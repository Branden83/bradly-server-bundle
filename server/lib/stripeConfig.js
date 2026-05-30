import db from '../db.js';

function readAppSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row?.value?.trim() || '';
}

/**
 * Stripe key resolution. Env vars take precedence over admin app_settings.
 */
export function getStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() || readAppSetting('stripe_secret_key');
}

export function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || readAppSetting('stripe_webhook_secret');
}

export function getStripePublishableKey(getSetting) {
  const fromEnv = process.env.STRIPE_PUBLISHABLE_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (typeof getSetting === 'function') {
    return getSetting('stripe_publishable_key')?.trim() || '';
  }
  return readAppSetting('stripe_publishable_key');
}

export function isStripeConfigured() {
  return Boolean(getStripeSecretKey());
}

export function isStripeWebhookConfigured() {
  return Boolean(getStripeWebhookSecret());
}
