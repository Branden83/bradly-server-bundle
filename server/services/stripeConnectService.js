import db from '../db.js';

const DEV_BYPASS =
  process.env.NODE_ENV !== 'production' || process.env.BRADLEY_DEV_STRIPE_BYPASS === '1';

/**
 * MVP stub: Stripe Connect onboarding required before cleaner can receive in-app payments.
 * Set stripe_connect_onboarding_complete = 1 and stripe_connect_account_id when Connect is wired.
 *
 * @param {string} cleanerId
 * @returns {{ ready: boolean, reason?: string }}
 */
export function getCleanerConnectStatus(cleanerId) {
  const row = db
    .prepare(
      `SELECT stripe_connect_account_id, stripe_connect_onboarding_complete
       FROM users WHERE id = ?`
    )
    .get(cleanerId);

  if (!row) {
    return { ready: false, reason: 'Cleaner not found' };
  }

  if (DEV_BYPASS) {
    return { ready: true, reason: 'dev_bypass' };
  }

  if (row.stripe_connect_onboarding_complete && row.stripe_connect_account_id) {
    return { ready: true };
  }

  return {
    ready: false,
    reason: 'stripe_connect_onboarding_required',
  };
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
