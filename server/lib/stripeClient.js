import Stripe from 'stripe';
import { getStripeSecretKey } from './stripeConfig.js';

/** @type {Stripe | null} */
let stripeClient = null;
/** @type {string | null} */
let stripeClientKey = null;

/**
 * @returns {Stripe | null}
 */
export function getStripeClient() {
  const secretKey = getStripeSecretKey();
  if (!secretKey) return null;
  if (stripeClient && stripeClientKey === secretKey) {
    return stripeClient;
  }
  stripeClient = new Stripe(secretKey, { apiVersion: '2025-02-24.acacia' });
  stripeClientKey = secretKey;
  return stripeClient;
}

/** Reset cached client (tests / key rotation). */
export function resetStripeClient() {
  stripeClient = null;
  stripeClientKey = null;
}
