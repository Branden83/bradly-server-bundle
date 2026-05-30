import { ServiceError } from './serviceError.js';

const EXPOSE_STRIPE =
  process.env.BRADLEY_EXPOSE_STRIPE_ERRORS === '1' ||
  process.env.NODE_ENV !== 'production';

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStripeSdkError(err) {
  return Boolean(
    err &&
      typeof err === 'object' &&
      typeof err.type === 'string' &&
      err.type.startsWith('Stripe')
  );
}

/**
 * Map Stripe SDK errors to ServiceError with safe, actionable messages.
 * @param {unknown} err
 * @returns {ServiceError | null}
 */
export function stripeErrorToServiceError(err) {
  if (!isStripeSdkError(err)) return null;

  const rawMessage = err.message || 'Payment provider error';
  let message = rawMessage;
  let status =
    typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 502;
  let code = err.code || 'stripe_error';

  if (/signed up for Connect/i.test(rawMessage)) {
    message =
      'Stripe Connect is not enabled for this platform. Complete Connect setup in the Stripe Dashboard (test mode → Settings → Connect).';
    status = 503;
    code = 'stripe_connect_not_enabled';
  } else if (/complete your platform profile/i.test(rawMessage)) {
    message =
      'Stripe Connect platform profile is incomplete. Finish setup at dashboard.stripe.com (test) → Settings → Connect.';
    status = 503;
    code = 'stripe_connect_profile_incomplete';
  }

  /** @type {Record<string, string> | undefined} */
  const details = EXPOSE_STRIPE
    ? { stripe_message: rawMessage, stripe_type: err.type }
    : undefined;

  return new ServiceError(message, { status, code, details });
}

/**
 * Rethrow as ServiceError when err is from Stripe; otherwise rethrow original.
 * @param {unknown} err
 */
export function rethrowStripeError(err) {
  const mapped = stripeErrorToServiceError(err);
  if (mapped) throw mapped;
  throw err;
}
