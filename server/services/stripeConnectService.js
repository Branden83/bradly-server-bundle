import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { validateStripeOnboardingStatus } from '../validation/cleanerProfile.js';
import { assertCleanerUser, getProfileRowByUserId } from './cleanerProfileHelpers.js';

const DEV_BYPASS =
  process.env.NODE_ENV !== 'production' || process.env.BRADLEY_DEV_STRIPE_BYPASS === '1';

function getUserStripeRow(userId) {
  return db
    .prepare(
      `SELECT id, email, stripe_connect_account_id, stripe_connect_onboarding_complete
       FROM users WHERE id = ?`
    )
    .get(userId);
}

function updateProfileStripeStatus(userId, status) {
  validateStripeOnboardingStatus(status);
  db.prepare(
    `UPDATE cleaner_profiles
     SET stripe_onboarding_status = ?, updated_at = datetime('now')
     WHERE user_id = ?`
  ).run(status, userId);
}

/**
 * Map Stripe account capabilities to profile onboarding status.
 * @param {{ charges_enabled?: boolean, payouts_enabled?: boolean, requirements?: { disabled_reason?: string } }} account
 */
export function mapStripeAccountToOnboardingStatus(account) {
  if (account.requirements?.disabled_reason) return 'restricted';
  if (account.charges_enabled && account.payouts_enabled) return 'complete';
  return 'pending';
}

/**
 * @param {string} cleanerId
 */
export function isStripeOnboardingComplete(cleanerId) {
  return getCleanerConnectStatus(cleanerId).ready;
}

/**
 * MVP stub: Stripe Connect onboarding required before cleaner can receive in-app payments.
 *
 * @param {string} cleanerId
 * @returns {{ ready: boolean, reason?: string, stripe_onboarding_status: string, account_id?: string | null }}
 */
export function getCleanerConnectStatus(cleanerId) {
  const user = getUserStripeRow(cleanerId);
  if (!user) {
    return { ready: false, reason: 'cleaner_not_found', stripe_onboarding_status: 'not_started' };
  }

  const profile = getProfileRowByUserId(cleanerId);
  const profileStatus = profile?.stripe_onboarding_status ?? 'not_started';

  if (DEV_BYPASS) {
    return {
      ready: true,
      reason: 'dev_bypass',
      stripe_onboarding_status: profileStatus === 'not_started' ? 'complete' : profileStatus,
      account_id: user.stripe_connect_account_id ?? null,
    };
  }

  if (user.stripe_connect_onboarding_complete && user.stripe_connect_account_id) {
    return {
      ready: true,
      stripe_onboarding_status: profileStatus === 'restricted' ? 'restricted' : 'complete',
      account_id: user.stripe_connect_account_id,
    };
  }

  if (user.stripe_connect_account_id) {
    return {
      ready: false,
      reason: 'stripe_connect_onboarding_required',
      stripe_onboarding_status: profileStatus === 'restricted' ? 'restricted' : 'pending',
      account_id: user.stripe_connect_account_id,
    };
  }

  return {
    ready: false,
    reason: 'stripe_connect_account_missing',
    stripe_onboarding_status: profileStatus,
    account_id: null,
  };
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Create (or return existing) Stripe Connect Express account for cleaner.
 * @param {string} userId
 * @param {{ email?: string, country?: string }} [options]
 */
export function createConnectAccount(userId, options = {}) {
  assertCleanerUser(userId);
  const profile = getProfileRowByUserId(userId);
  assertFound(profile, 'Create a cleaner profile before connecting payments');

  const user = getUserStripeRow(userId);
  assertFound(user, 'User not found');

  if (user.stripe_connect_account_id) {
    return {
      account_id: user.stripe_connect_account_id,
      stripe_onboarding_status: profile.stripe_onboarding_status,
      already_exists: true,
    };
  }

  let accountId;
  if (isStripeConfigured()) {
    throw new ServiceError(
      'Stripe SDK wiring pending — set STRIPE_SECRET_KEY and implement account creation',
      { status: 501, code: 'stripe_not_implemented' }
    );
  }

  accountId = `acct_dev_${uuid().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `UPDATE users SET stripe_connect_account_id = ?, stripe_connect_onboarding_complete = 0
     WHERE id = ?`
  ).run(accountId, userId);
  updateProfileStripeStatus(userId, 'pending');

  return {
    account_id: accountId,
    stripe_onboarding_status: 'pending',
    already_exists: false,
    dev_mode: !isStripeConfigured(),
    email: options.email ?? user.email,
  };
}

/**
 * @param {string} userId
 * @param {{ returnUrl: string, refreshUrl: string }} urls
 */
export function createOnboardingLink(userId, { returnUrl, refreshUrl }) {
  assertCleanerUser(userId);
  const user = getUserStripeRow(userId);
  assertFound(user, 'User not found');

  if (!user.stripe_connect_account_id) {
    throw new ServiceError('Create a Connect account first', { status: 400 });
  }

  if (!returnUrl || !refreshUrl) {
    throw new ServiceError('returnUrl and refreshUrl are required');
  }

  if (isStripeConfigured()) {
    throw new ServiceError(
      'Stripe SDK wiring pending — set STRIPE_SECRET_KEY and implement account links',
      { status: 501, code: 'stripe_not_implemented' }
    );
  }

  if (DEV_BYPASS) {
    syncConnectStatus(userId, { onboardingComplete: true, status: 'complete' });
    return {
      url: returnUrl,
      expires_at: null,
      dev_mode: true,
      dev_bypass: true,
    };
  }

  return {
    url: `${returnUrl}?stripe=mock_pending`,
    expires_at: null,
    dev_mode: true,
  };
}

/**
 * Refresh Connect + profile stripe_onboarding_status from known state.
 * @param {string} userId
 * @param {{ onboardingComplete?: boolean, status?: string }} [stripeState]
 */
export function syncConnectStatus(userId, stripeState = {}) {
  assertCleanerUser(userId);
  const user = getUserStripeRow(userId);
  assertFound(user, 'User not found');

  let nextStatus = stripeState.status;
  if (!nextStatus) {
    if (DEV_BYPASS && stripeState.onboardingComplete !== false) {
      nextStatus = 'complete';
    } else if (user.stripe_connect_onboarding_complete) {
      nextStatus = 'complete';
    } else if (user.stripe_connect_account_id) {
      nextStatus = 'pending';
    } else {
      nextStatus = 'not_started';
    }
  }

  validateStripeOnboardingStatus(nextStatus);

  const onboardingComplete =
    stripeState.onboardingComplete ??
    (nextStatus === 'complete' || (DEV_BYPASS && nextStatus !== 'restricted'));

  db.prepare(
    `UPDATE users SET stripe_connect_onboarding_complete = ? WHERE id = ?`
  ).run(onboardingComplete ? 1 : 0, userId);

  updateProfileStripeStatus(userId, nextStatus);

  return getCleanerConnectStatus(userId);
}

/**
 * @param {string} userId
 */
export function getConnectAccountStatus(userId) {
  assertCleanerUser(userId);
  const status = getCleanerConnectStatus(userId);
  const profile = getProfileRowByUserId(userId);
  return {
    ...status,
    stripe_onboarding_status: profile?.stripe_onboarding_status ?? status.stripe_onboarding_status,
  };
}
