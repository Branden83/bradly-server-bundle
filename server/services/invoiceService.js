import { v4 as uuid } from 'uuid';
import db, {
  createPlatformFee,
  getActiveHouseholdCleanerAgreement,
  updatePaymentIntentStatus,
} from '../db.js';
import { calculatePaymentBreakdown } from './paymentFeeService.js';

function formatCentsDisplay(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Active agreement for fee lookup; falls back to BYOC when none exists (legacy households).
 * @param {string} homeId
 * @param {string} cleanerId
 */
export function getAgreementForInvoice(homeId, cleanerId) {
  return getActiveHouseholdCleanerAgreement(homeId, cleanerId);
}

/**
 * @param {string} homeId
 * @param {string} cleanerId
 * @returns {'byoc' | 'match'}
 */
export function resolveAgreementSource(homeId, cleanerId) {
  const agreement = getAgreementForInvoice(homeId, cleanerId);
  return agreement?.source === 'match' ? 'match' : 'byoc';
}

/**
 * @param {number} cleanerAmountCents
 * @param {string} homeId
 * @param {string} cleanerId
 */
export function buildInvoiceFeeBreakdown(cleanerAmountCents, homeId, cleanerId) {
  const agreement = getAgreementForInvoice(homeId, cleanerId);
  const source = agreement?.source === 'match' ? 'match' : 'byoc';
  const breakdown = calculatePaymentBreakdown({ cleanerAmountCents, source });
  return {
    ...breakdown,
    agreement_id: agreement?.id ?? null,
  };
}

/**
 * @param {object} row
 */
export function formatInvoiceRow(row) {
  if (!row) return null;

  const cleanerAmount =
    row.cleaner_amount_cents ?? row.amount_cents ?? 0;
  const bradleyFee = row.bradley_fee_cents ?? 0;
  const total = row.total_amount_cents ?? cleanerAmount + bradleyFee;

  let payment = null;
  if (row.payment_intent_id) {
    payment = db
      .prepare('SELECT id, status, stripe_payment_intent_id FROM payment_intents WHERE id = ?')
      .get(row.payment_intent_id);
  }

  return {
    id: row.id,
    home_id: row.home_id,
    visit_id: row.visit_id,
    cleaner_id: row.cleaner_id,
    agreement_id: row.agreement_id ?? null,
    amount_cents: cleanerAmount,
    cleaner_amount_cents: cleanerAmount,
    bradley_fee_cents: bradleyFee,
    total_amount_cents: total,
    fee_type: row.fee_type ?? null,
    fee_percent: row.fee_percent ?? null,
    cleaner_payout_cents: cleanerAmount,
    cleaner_payout_display: formatCentsDisplay(cleanerAmount),
    note: row.note,
    status: row.status,
    paid_via: row.paid_via,
    created_at: row.created_at,
    paid_at: row.paid_at,
    cleaner_name: row.cleaner_name,
    visit_date: row.visit_date ?? null,
    payment,
  };
}

export function fetchInvoiceById(id) {
  const row = db
    .prepare(
      `SELECT i.*, u.display_name as cleaner_name, v.scheduled_date as visit_date
       FROM invoices i
       JOIN users u ON u.id = i.cleaner_id
       LEFT JOIN visits v ON v.id = i.visit_id
       WHERE i.id = ?`
    )
    .get(id);
  return formatInvoiceRow(row);
}

/**
 * @param {string} invoiceId
 * @param {string} homeownerId
 */
export function createPaymentIntentForInvoice(invoiceId, homeownerId) {
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

/**
 * Mark invoice paid from webhook / confirmed payment (not client-only).
 * @param {string} invoiceId
 * @param {{ paidVia?: string }} [options]
 */
export function markInvoicePaidFromPayment(invoiceId, options = {}) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) return null;

  if (invoice.payment_intent_id && options.markPaymentIntentSucceeded !== false) {
    updatePaymentIntentStatus(invoice.payment_intent_id, 'succeeded');
  }

  db.prepare(
    `UPDATE invoices SET status = 'paid', paid_via = ?, paid_at = datetime('now') WHERE id = ?`
  ).run(options.paidVia ?? 'stripe', invoiceId);

  if (invoice.fee_type && invoice.bradley_fee_cents > 0) {
    const existing = db
      .prepare('SELECT id FROM platform_fees WHERE invoice_id = ? LIMIT 1')
      .get(invoiceId);
    if (!existing) {
      createPlatformFee({
        id: uuid(),
        paymentIntentId: invoice.payment_intent_id,
        invoiceId: invoice.id,
        agreementId: invoice.agreement_id,
        feeType: invoice.fee_type,
        feePercent: invoice.fee_percent,
        cleanerAmountCents: invoice.cleaner_amount_cents ?? invoice.amount_cents,
        feeAmountCents: invoice.bradley_fee_cents,
        totalAmountCents: invoice.total_amount_cents ?? invoice.amount_cents,
        stripeFeeId: options.stripeFeeId ?? null,
      });
    }
  }

  return fetchInvoiceById(invoiceId);
}

/**
 * @param {string} invoiceId
 * @returns {boolean}
 */
export function invoiceHasSucceededPayment(invoiceId) {
  const invoice = db.prepare('SELECT payment_intent_id FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice?.payment_intent_id) return false;
  const pi = db
    .prepare('SELECT status FROM payment_intents WHERE id = ?')
    .get(invoice.payment_intent_id);
  return pi?.status === 'succeeded';
}
