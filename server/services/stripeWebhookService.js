import { getStripeClient } from '../lib/stripeClient.js';
import { getStripeWebhookSecret } from '../lib/stripeConfig.js';
import db, {
  getPaymentIntentByStripeId,
  recordStripeWebhookEvent,
} from '../db.js';
import { markInvoicePaidFromPayment } from './invoiceService.js';
import { syncConnectStatusFromStripeAccount } from './stripeConnectService.js';

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ received: boolean, duplicate?: boolean }>}
 */
export async function handleStripeWebhookRequest(req) {
  const webhookSecret = getStripeWebhookSecret();
  if (!webhookSecret) {
    const err = new Error('Stripe webhook secret not configured');
    err.status = 503;
    throw err;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    const err = new Error('Stripe secret key not configured');
    err.status = 503;
    throw err;
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    const err = new Error('Missing Stripe-Signature header');
    err.status = 400;
    throw err;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    const parseErr = new Error(`Webhook signature verification failed: ${err.message}`);
    parseErr.status = 400;
    throw parseErr;
  }

  const isNew = recordStripeWebhookEvent(event.id, event.type);
  if (!isNew) {
    return { received: true, duplicate: true };
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event.data.object);
      break;
    case 'account.updated':
      await handleAccountUpdated(event.data.object);
      break;
    default:
      break;
  }

  return { received: true };
}

/**
 * @param {import('stripe').Stripe.PaymentIntent} paymentIntent
 */
async function handlePaymentIntentSucceeded(paymentIntent) {
  const row = getPaymentIntentByStripeId(paymentIntent.id);
  if (!row) {
    console.warn('[stripe webhook] payment_intent.succeeded: unknown PI', paymentIntent.id);
    return;
  }

  if (row.status === 'succeeded') return;

  if (!row.invoice_id) {
    db.prepare(
      `UPDATE payment_intents SET status = 'succeeded', updated_at = datetime('now') WHERE id = ?`
    ).run(row.id);
    return;
  }

  const applicationFeeId =
    typeof paymentIntent.application_fee_amount === 'number' && paymentIntent.application_fee_amount > 0
      ? paymentIntent.latest_charge ?? null
      : null;

  markInvoicePaidFromPayment(row.invoice_id, {
    paidVia: 'stripe',
    stripeFeeId: applicationFeeId,
  });
}

/**
 * @param {import('stripe').Stripe.Account} account
 */
async function handleAccountUpdated(account) {
  if (!account?.id) return;
  const user = db
    .prepare('SELECT id FROM users WHERE stripe_connect_account_id = ?')
    .get(account.id);
  if (!user) return;
  syncConnectStatusFromStripeAccount(user.id, account);
}
