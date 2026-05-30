import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getStripeClient } from '../lib/stripeClient.js';
import { isStripeConfigured } from '../lib/stripeConfig.js';

const DEFAULT_PUBLIC_URL = 'https://34-134-19-51.sslip.io';

function getCleanerConnectAccountId(cleanerId) {
  return (
    db.prepare('SELECT stripe_connect_account_id FROM users WHERE id = ?').get(cleanerId)
      ?.stripe_connect_account_id ?? null
  );
}

function isStubStripePaymentIntentId(id) {
  return !id || id.startsWith('pi_stub_');
}

function updatePaymentIntentStripeId(internalId, stripePaymentIntentId) {
  db.prepare(
    `UPDATE payment_intents SET stripe_payment_intent_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(stripePaymentIntentId, internalId);
}

function paymentIntentMetadata(invoice, internalPaymentIntentId) {
  return {
    invoice_id: invoice.id,
    bradley_payment_intent_id: internalPaymentIntentId,
    cleaner_id: invoice.cleaner_id,
    home_id: invoice.home_id,
  };
}

function connectPaymentIntentParams(invoice, internalPaymentIntentId, connectAccountId) {
  const total = invoice.total_amount_cents ?? invoice.amount_cents;
  const bradleyFee = invoice.bradley_fee_cents ?? 0;

  return {
    amount: total,
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
    application_fee_amount: bradleyFee,
    transfer_data: { destination: connectAccountId },
    metadata: paymentIntentMetadata(invoice, internalPaymentIntentId),
  };
}

/**
 * Create or retrieve a live Stripe PaymentIntent for an existing DB row.
 * @param {object} invoice
 * @param {object} paymentIntentRow
 * @returns {Promise<{ paymentIntent: object, clientSecret: string | null }>}
 */
export async function ensureStripePaymentIntent(invoice, paymentIntentRow) {
  if (!isStripeConfigured()) {
    return { paymentIntent: paymentIntentRow, clientSecret: null };
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return { paymentIntent: paymentIntentRow, clientSecret: null };
  }

  const connectAccountId = getCleanerConnectAccountId(invoice.cleaner_id);
  if (!connectAccountId) {
    const err = new Error('Cleaner Stripe Connect account not found');
    err.status = 400;
    throw err;
  }

  const stripeId = paymentIntentRow.stripe_payment_intent_id;

  if (!isStubStripePaymentIntentId(stripeId)) {
    const existing = await stripe.paymentIntents.retrieve(stripeId);
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status)) {
      return { paymentIntent: paymentIntentRow, clientSecret: existing.client_secret };
    }
    if (existing.status === 'succeeded') {
      const err = new Error('Invoice already paid');
      err.status = 409;
      throw err;
    }
  }

  const created = await stripe.paymentIntents.create(
    connectPaymentIntentParams(invoice, paymentIntentRow.id, connectAccountId)
  );
  updatePaymentIntentStripeId(paymentIntentRow.id, created.id);

  const updatedRow = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(paymentIntentRow.id);
  return { paymentIntent: updatedRow, clientSecret: created.client_secret };
}

/**
 * Stripe Checkout Session (hosted page) for web MVP.
 * @param {object} invoice
 * @param {object} paymentIntentRow
 * @param {{ successUrl?: string, cancelUrl?: string }} [options]
 */
export async function createCheckoutSession(invoice, paymentIntentRow, options = {}) {
  if (!isStripeConfigured()) {
    const err = new Error('Stripe is not configured on the server');
    err.status = 503;
    throw err;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    const err = new Error('Stripe is not configured on the server');
    err.status = 503;
    throw err;
  }

  const connectAccountId = getCleanerConnectAccountId(invoice.cleaner_id);
  if (!connectAccountId) {
    const err = new Error('Cleaner Stripe Connect account not found');
    err.status = 400;
    throw err;
  }

  const total = invoice.total_amount_cents ?? invoice.amount_cents;
  const bradleyFee = invoice.bradley_fee_cents ?? 0;
  const cleanerAmount = invoice.cleaner_amount_cents ?? invoice.amount_cents;
  const baseUrl = (process.env.BRADLEY_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/$/, '');
  const invoiceId = invoice.id;

  const successUrl =
    options.successUrl?.trim() ||
    `${baseUrl}/?paySuccess=1&invoiceId=${encodeURIComponent(invoiceId)}`;
  const cancelUrl =
    options.cancelUrl?.trim() ||
    `${baseUrl}/?payCancelled=1&invoiceId=${encodeURIComponent(invoiceId)}`;

  const cleaner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(invoice.cleaner_id);
  const productName = `Cleaning — ${cleaner?.display_name || 'your cleaner'}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: total,
          product_data: {
            name: productName,
            description: invoice.note?.trim() || `Cleaner payout ${(cleanerAmount / 100).toFixed(2)} + Bradley fee`,
          },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: bradleyFee,
      transfer_data: { destination: connectAccountId },
      metadata: paymentIntentMetadata(invoice, paymentIntentRow.id),
    },
    metadata: paymentIntentMetadata(invoice, paymentIntentRow.id),
  });

  const stripePaymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (stripePaymentIntentId && isStubStripePaymentIntentId(paymentIntentRow.stripe_payment_intent_id)) {
    updatePaymentIntentStripeId(paymentIntentRow.id, stripePaymentIntentId);
  }

  return {
    url: session.url,
    sessionId: session.id,
    paymentIntent: db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(paymentIntentRow.id),
  };
}

/**
 * Dev stub when Stripe keys are absent.
 * @param {string} invoiceId
 * @param {string} homeownerId
 */
export function createStubPaymentIntentRecord(invoiceId, homeownerId) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) {
    return { error: 'Not found', status: 404 };
  }
  if (invoice.status !== 'sent') {
    return { error: 'Invoice is not awaiting payment', status: 400 };
  }

  const existing = invoice.payment_intent_id
    ? db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(invoice.payment_intent_id)
    : null;

  if (existing && ['requires_payment_method', 'processing', 'requires_confirmation'].includes(existing.status)) {
    return { paymentIntent: existing, created: false };
  }

  if (existing?.status === 'succeeded') {
    return { error: 'Invoice already paid', status: 409 };
  }

  const id = uuid();
  const stripePaymentIntentId = `pi_stub_${id.replace(/-/g, '').slice(0, 24)}`;

  db.prepare(
    `INSERT INTO payment_intents (
      id, stripe_payment_intent_id, invoice_id, agreement_id,
      homeowner_id, cleaner_id, cleaner_amount_cents, bradley_fee_cents,
      total_amount_cents, fee_type, fee_percent, currency, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', 'requires_payment_method')`
  ).run(
    id,
    stripePaymentIntentId,
    invoice.id,
    invoice.agreement_id,
    homeownerId,
    invoice.cleaner_id,
    invoice.cleaner_amount_cents ?? invoice.amount_cents,
    invoice.bradley_fee_cents ?? 0,
    invoice.total_amount_cents ?? invoice.amount_cents,
    invoice.fee_type,
    invoice.fee_percent
  );

  db.prepare('UPDATE invoices SET payment_intent_id = ? WHERE id = ?').run(id, invoice.id);

  const paymentIntent = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id);
  return { paymentIntent, created: true };
}
