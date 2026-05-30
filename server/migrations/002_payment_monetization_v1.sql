-- Reference migration for payment_monetization_v1 (applied in db.js migratePaymentMonetizationV1).
-- Safe to run on empty DBs; existing installs use idempotent checks in db.js.

-- Stripe PaymentIntent mirror; webhooks are source of truth for status.
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  stripe_payment_intent_id TEXT UNIQUE,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL,
  homeowner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleaner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleaner_amount_cents INTEGER NOT NULL,
  bradley_fee_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('byoc_platform_fee', 'match_fee')),
  fee_percent INTEGER NOT NULL CHECK (fee_percent IN (5, 10)),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'requires_payment_method' CHECK (
    status IN (
      'requires_payment_method',
      'requires_confirmation',
      'processing',
      'succeeded',
      'failed',
      'canceled'
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_invoice ON payment_intents(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_stripe ON payment_intents(stripe_payment_intent_id);

-- Platform fee audit rows (recorded when payment succeeds via Stripe webhook).
CREATE TABLE IF NOT EXISTS platform_fees (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('byoc_platform_fee', 'match_fee')),
  fee_percent INTEGER NOT NULL CHECK (fee_percent IN (5, 10)),
  cleaner_amount_cents INTEGER NOT NULL,
  fee_amount_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  stripe_fee_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_fees_payment_intent ON platform_fees(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_invoice ON platform_fees(invoice_id);

-- Invoice payment breakdown (fee on top of cleaner price).
ALTER TABLE invoices ADD COLUMN cleaner_amount_cents INTEGER;
ALTER TABLE invoices ADD COLUMN bradley_fee_cents INTEGER;
ALTER TABLE invoices ADD COLUMN total_amount_cents INTEGER;
ALTER TABLE invoices ADD COLUMN fee_type TEXT CHECK (
  fee_type IS NULL OR fee_type IN ('byoc_platform_fee', 'match_fee')
);
ALTER TABLE invoices ADD COLUMN fee_percent INTEGER CHECK (fee_percent IS NULL OR fee_percent IN (5, 10));
ALTER TABLE invoices ADD COLUMN agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN payment_intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_agreement ON invoices(agreement_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_intent ON invoices(payment_intent_id);
