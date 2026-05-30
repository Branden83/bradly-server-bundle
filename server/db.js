import crypto from 'crypto';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { calculatePaymentBreakdown } from './services/paymentFeeService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BRADLEY_DB_PATH || join(__dirname, 'bradley.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);

function migrateHouseholdMembers() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('household_members_v2');
  if (done) return;

  db.exec(`
    CREATE TABLE home_members_v2 (
      home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'cleaner')),
      PRIMARY KEY (home_id, user_id)
    );
  `);

  const hasOld = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='home_members'")
    .get();
  if (hasOld) {
    db.exec(`INSERT OR IGNORE INTO home_members_v2 SELECT * FROM home_members`);
    db.exec(`DROP TABLE home_members`);
  }
  db.exec(`ALTER TABLE home_members_v2 RENAME TO home_members`);
  db.exec(`
    INSERT OR IGNORE INTO home_members (home_id, user_id, role)
    SELECT id, owner_id, 'owner' FROM homes
  `);
  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('household_members_v2');
}

migrateHouseholdMembers();

function migrateVisitFeedback() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('visit_feedback_v1');
  if (done) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS visit_feedback (
      id TEXT PRIMARY KEY,
      visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      went_well TEXT NOT NULL DEFAULT '',
      needs_improvement TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_visit_feedback_home ON visit_feedback(home_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visit_feedback_visit ON visit_feedback(visit_id);
  `);
  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('visit_feedback_v1');
}

migrateVisitFeedback();

function migrateAdminAndLicensing() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('admin_licensing_v1');
  if (done) return;

  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'subscription_status')) {
    db.exec(`ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'trial'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const roleCheck = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`
    )
    .get();
  if (roleCheck?.sql && !roleCheck.sql.includes("'admin'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_admin_v1 (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('client', 'cleaner', 'admin')),
        push_token TEXT,
        subscription_status TEXT NOT NULL DEFAULT 'trial',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_admin_v1 (id, email, password_hash, display_name, role, push_token, subscription_status, created_at)
      SELECT id, email, password_hash, display_name, role, push_token,
        COALESCE(subscription_status, 'trial'), created_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_admin_v1 RENAME TO users;
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('admin_licensing_v1');
}

migrateAdminAndLicensing();

function migrateTaskEstimatesAndHourlyRate() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('task_estimates_hourly_rate_v1');
  if (done) return;

  const homeCols = db.prepare('PRAGMA table_info(homes)').all();
  if (!homeCols.some((c) => c.name === 'hourly_rate_cents')) {
    db.exec(`ALTER TABLE homes ADD COLUMN hourly_rate_cents INTEGER`);
  }

  const taskCols = db.prepare('PRAGMA table_info(task_templates)').all();
  if (!taskCols.some((c) => c.name === 'estimated_minutes')) {
    db.exec(`ALTER TABLE task_templates ADD COLUMN estimated_minutes INTEGER NOT NULL DEFAULT 15`);
  }

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('task_estimates_hourly_rate_v1');
}

migrateTaskEstimatesAndHourlyRate();

function migrateSubscriptionTrialAndVisitResponse() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('subscription_visit_response_v1');
  if (done) return;

  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'subscription_trial_ends_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN subscription_trial_ends_at TEXT`);
  }
  if (!userCols.some((c) => c.name === 'subscription_expires_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN subscription_expires_at TEXT`);
  }

  db.exec(`
    UPDATE users
    SET subscription_trial_ends_at = datetime(created_at, '+14 days')
    WHERE subscription_trial_ends_at IS NULL
  `);

  const visitCols = db.prepare('PRAGMA table_info(visits)').all();
  if (!visitCols.some((c) => c.name === 'cleaner_response')) {
    db.exec(`ALTER TABLE visits ADD COLUMN cleaner_response TEXT NOT NULL DEFAULT 'pending'`);
  }
  if (!visitCols.some((c) => c.name === 'cleaner_responded_at')) {
    db.exec(`ALTER TABLE visits ADD COLUMN cleaner_responded_at TEXT`);
  }

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('subscription_visit_response_v1');
}

migrateSubscriptionTrialAndVisitResponse();

function migrateUxPriorities45678() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('ux_priorities_45678_v1');
  if (done) return;

  const visitCols = db.prepare('PRAGMA table_info(visits)').all();
  if (!visitCols.some((c) => c.name === 'decline_reason')) {
    db.exec(`ALTER TABLE visits ADD COLUMN decline_reason TEXT`);
  }
  if (!visitCols.some((c) => c.name === 'decline_reason_text')) {
    db.exec(`ALTER TABLE visits ADD COLUMN decline_reason_text TEXT`);
  }

  const taskCols = db.prepare('PRAGMA table_info(task_templates)').all();
  if (!taskCols.some((c) => c.name === 'priority')) {
    db.exec(`ALTER TABLE task_templates ADD COLUMN priority TEXT NOT NULL DEFAULT 'must'`);
  }

  const vtCols = db.prepare('PRAGMA table_info(visit_tasks)').all();
  if (!vtCols.some((c) => c.name === 'priority')) {
    db.exec(`ALTER TABLE visit_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'must'`);
  }

  db.exec(`
    UPDATE visit_tasks SET priority = COALESCE(
      (SELECT priority FROM task_templates WHERE id = visit_tasks.task_template_id),
      'must'
    )
    WHERE task_template_id IS NOT NULL
  `);

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('ux_priorities_45678_v1');
}

migrateUxPriorities45678();

function migrateMarketplaceV1() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('marketplace_v1');
  if (done) return;

  const sql = readFileSync(join(__dirname, 'migrations', '001_marketplace_v1.sql'), 'utf8');
  db.exec(sql);
  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('marketplace_v1');
}

migrateMarketplaceV1();

function migratePaymentsV1() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('payments_v1');
  if (done) return;

  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'stripe_connect_account_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN stripe_connect_account_id TEXT`);
  }
  if (!userCols.some((c) => c.name === 'stripe_connect_onboarding_complete')) {
    db.exec(`ALTER TABLE users ADD COLUMN stripe_connect_onboarding_complete INTEGER NOT NULL DEFAULT 0`);
  }

  const agreementCols = db.prepare('PRAGMA table_info(household_cleaner_agreements)').all();
  if (!agreementCols.some((c) => c.name === 'fee_type')) {
    db.exec(`ALTER TABLE household_cleaner_agreements ADD COLUMN fee_type TEXT`);
  }
  if (!agreementCols.some((c) => c.name === 'fee_percent')) {
    db.exec(`ALTER TABLE household_cleaner_agreements ADD COLUMN fee_percent INTEGER`);
  }

  db.exec(`
    UPDATE household_cleaner_agreements
    SET fee_type = CASE WHEN source = 'match' THEN 'match_fee' ELSE 'byoc_platform_fee' END,
        fee_percent = CASE WHEN source = 'match' THEN 10 ELSE 5 END
    WHERE fee_type IS NULL OR fee_percent IS NULL
  `);

  const invoiceCols = db.prepare('PRAGMA table_info(invoices)').all();
  const addInvoiceCol = (name, ddl) => {
    if (!invoiceCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE invoices ADD COLUMN ${ddl}`);
    }
  };
  addInvoiceCol('cleaner_amount_cents', 'cleaner_amount_cents INTEGER');
  addInvoiceCol('bradley_fee_cents', 'bradley_fee_cents INTEGER');
  addInvoiceCol('total_amount_cents', 'total_amount_cents INTEGER');
  addInvoiceCol('fee_type', 'fee_type TEXT');
  addInvoiceCol('fee_percent', 'fee_percent INTEGER');
  addInvoiceCol('agreement_id', 'agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL');
  addInvoiceCol('payment_intent_id', 'payment_intent_id TEXT');

  const invoiceBackfill = db
    .prepare(
      `SELECT id, home_id, cleaner_id, amount_cents FROM invoices WHERE cleaner_amount_cents IS NULL`
    )
    .all();
  const agreementForBackfill = db.prepare(
    `SELECT id, source FROM household_cleaner_agreements
     WHERE household_id = ? AND cleaner_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`
  );
  const invoiceBreakdownUpdate = db.prepare(
    `UPDATE invoices SET
      agreement_id = ?, cleaner_amount_cents = ?, bradley_fee_cents = ?,
      total_amount_cents = ?, fee_type = ?, fee_percent = ?
     WHERE id = ?`
  );
  for (const inv of invoiceBackfill) {
    const agreement = agreementForBackfill.get(inv.home_id, inv.cleaner_id);
    const source = agreement?.source === 'match' ? 'match' : 'byoc';
    const breakdown = calculatePaymentBreakdown({
      cleanerAmountCents: inv.amount_cents,
      source,
    });
    invoiceBreakdownUpdate.run(
      agreement?.id ?? null,
      breakdown.cleaner_amount_cents,
      breakdown.bradley_fee_cents,
      breakdown.total_amount_cents,
      breakdown.fee_type,
      breakdown.fee_percent,
      inv.id
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      stripe_payment_intent_id TEXT UNIQUE,
      invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
      agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL,
      homeowner_id TEXT NOT NULL REFERENCES users(id),
      cleaner_id TEXT NOT NULL REFERENCES users(id),
      cleaner_amount_cents INTEGER NOT NULL,
      bradley_fee_cents INTEGER NOT NULL,
      total_amount_cents INTEGER NOT NULL,
      fee_type TEXT NOT NULL CHECK (fee_type IN ('byoc_platform_fee', 'match_fee')),
      fee_percent INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL DEFAULT 'requires_payment_method',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payment_intents_invoice ON payment_intents(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_payment_intents_stripe ON payment_intents(stripe_payment_intent_id);
  `);

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('payments_v1');
}

migratePaymentsV1();

function migratePaymentMonetizationV1() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('payment_monetization_v1');
  if (done) return;

  const hasPlatformFees = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_fees'")
    .get();
  if (!hasPlatformFees) {
    db.exec(`
      CREATE TABLE platform_fees (
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
    `);
  }

  // Re-backfill invoice breakdown from agreement.source (payments_v1 used flat 5% BYOC).
  const pending = db
    .prepare(
      `SELECT id, home_id, cleaner_id, amount_cents, agreement_id, fee_percent, cleaner_amount_cents
       FROM invoices
       WHERE amount_cents IS NOT NULL`
    )
    .all();

  const agreementStmt = db.prepare(
    `SELECT id, source FROM household_cleaner_agreements
     WHERE household_id = ? AND cleaner_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`
  );
  const updateStmt = db.prepare(
    `UPDATE invoices SET
      agreement_id = ?,
      cleaner_amount_cents = ?,
      bradley_fee_cents = ?,
      total_amount_cents = ?,
      fee_type = ?,
      fee_percent = ?
     WHERE id = ?`
  );

  for (const inv of pending) {
    const agreement = agreementStmt.get(inv.home_id, inv.cleaner_id);
    const source = agreement?.source === 'match' ? 'match' : 'byoc';
    const breakdown = calculatePaymentBreakdown({
      cleanerAmountCents: inv.amount_cents,
      source,
    });
    const needsUpdate =
      inv.agreement_id !== (agreement?.id ?? null) ||
      inv.fee_percent !== breakdown.fee_percent;
    if (!needsUpdate && inv.cleaner_amount_cents != null) continue;

    updateStmt.run(
      agreement?.id ?? null,
      breakdown.cleaner_amount_cents,
      breakdown.bradley_fee_cents,
      breakdown.total_amount_cents,
      breakdown.fee_type,
      breakdown.fee_percent,
      inv.id
    );
  }

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('payment_monetization_v1');
}

migratePaymentMonetizationV1();

function migrateCleanerProfileV2() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('cleaner_profile_v2');
  if (done) return;

  const profileCols = db.prepare('PRAGMA table_info(cleaner_profiles)').all();
  const addProfileCol = (name, ddl) => {
    if (!profileCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE cleaner_profiles ADD COLUMN ${ddl}`);
    }
  };

  addProfileCol('profile_photo_url', 'profile_photo_url TEXT');
  addProfileCol(
    'pet_comfort_level',
    "pet_comfort_level TEXT NOT NULL DEFAULT 'none'"
  );
  addProfileCol('fragrance_free_available', 'fragrance_free_available INTEGER NOT NULL DEFAULT 0');
  addProfileCol(
    'eco_friendly_products_available',
    'eco_friendly_products_available INTEGER NOT NULL DEFAULT 0'
  );
  addProfileCol('bleach_allowed', 'bleach_allowed INTEGER NOT NULL DEFAULT 1');
  addProfileCol('deep_cleaning_available', 'deep_cleaning_available INTEGER NOT NULL DEFAULT 0');
  addProfileCol('move_in_move_out_available', 'move_in_move_out_available INTEGER NOT NULL DEFAULT 0');
  addProfileCol(
    'recurring_cleaning_available',
    'recurring_cleaning_available INTEGER NOT NULL DEFAULT 1'
  );
  addProfileCol('one_time_cleaning_available', 'one_time_cleaning_available INTEGER NOT NULL DEFAULT 1');
  addProfileCol(
    'stripe_onboarding_status',
    "stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started'"
  );

  const stripeBackfill = db
    .prepare(
      `SELECT cp.id, u.stripe_connect_onboarding_complete, u.stripe_connect_account_id
       FROM cleaner_profiles cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.stripe_onboarding_status = 'not_started'`
    )
    .all();
  const stripeUpdate = db.prepare(
    `UPDATE cleaner_profiles SET stripe_onboarding_status = ? WHERE id = ?`
  );
  for (const row of stripeBackfill) {
    let status = 'not_started';
    if (row.stripe_connect_onboarding_complete === 1) status = 'complete';
    else if (row.stripe_connect_account_id) status = 'pending';
    stripeUpdate.run(status, row.id);
  }

  const areaCols = db.prepare('PRAGMA table_info(cleaner_service_areas)').all();
  if (!areaCols.some((c) => c.name === 'is_primary')) {
    db.exec(`ALTER TABLE cleaner_service_areas ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`);
  }
  if (!areaCols.some((c) => c.name === 'updated_at')) {
    db.exec(`ALTER TABLE cleaner_service_areas ADD COLUMN updated_at TEXT`);
    db.exec(`UPDATE cleaner_service_areas SET updated_at = datetime('now') WHERE updated_at IS NULL`);
  }

  const availCols = db.prepare('PRAGMA table_info(cleaner_availability)').all();
  if (!availCols.some((c) => c.name === 'notes')) {
    db.exec(`ALTER TABLE cleaner_availability ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);
  }

  const sql = readFileSync(join(__dirname, 'migrations', '003_cleaner_profile_v2.sql'), 'utf8');
  db.exec(sql);

  const hasLanguagesTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleaner_languages'")
    .get();
  if (hasLanguagesTable) {
    const profiles = db
      .prepare(`SELECT id, languages FROM cleaner_profiles WHERE languages IS NOT NULL AND languages != '' AND languages != '[]'`)
      .all();
    const existingLang = db.prepare(
      'SELECT 1 FROM cleaner_languages WHERE cleaner_profile_id = ? AND language_code = ?'
    );
    const insertLang = db.prepare(
      `INSERT INTO cleaner_languages (
        id, cleaner_profile_id, language_code, language_name, proficiency
      ) VALUES (?, ?, ?, ?, ?)`
    );

    const slugCode = (name) =>
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 16) || 'unknown';

    for (const profile of profiles) {
      let entries = [];
      try {
        const parsed = JSON.parse(profile.languages);
        if (Array.isArray(parsed)) {
          entries = parsed.map((item) => {
            if (typeof item === 'string') return { name: item, proficiency: 'conversational' };
            if (item && typeof item === 'object') {
              return {
                name: item.name || item.language || item.language_name || String(item),
                code: item.code || item.language_code,
                proficiency: item.proficiency || 'conversational',
              };
            }
            return { name: String(item), proficiency: 'conversational' };
          });
        }
      } catch {
        entries = profile.languages
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((name) => ({ name, proficiency: 'conversational' }));
      }

      for (const entry of entries) {
        const languageName = String(entry.name || '').trim().slice(0, 120);
        if (!languageName) continue;
        const languageCode = (entry.code || slugCode(languageName)).slice(0, 16);
        if (existingLang.get(profile.id, languageCode)) continue;
        const proficiency = ['basic', 'conversational', 'fluent', 'native'].includes(
          entry.proficiency
        )
          ? entry.proficiency
          : 'conversational';
        insertLang.run(
          crypto.randomUUID(),
          profile.id,
          languageCode,
          languageName,
          proficiency
        );
      }
    }
  }

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('cleaner_profile_v2');
}

migrateCleanerProfileV2();

function migrateVisitTasksTimingV1() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('visit_tasks_timing_v1');
  if (done) return;

  const vtCols = db.prepare('PRAGMA table_info(visit_tasks)').all();
  if (!vtCols.some((c) => c.name === 'started_at')) {
    db.exec(`ALTER TABLE visit_tasks ADD COLUMN started_at TEXT`);
  }
  if (!vtCols.some((c) => c.name === 'actual_minutes')) {
    db.exec(`ALTER TABLE visit_tasks ADD COLUMN actual_minutes INTEGER`);
  }

  const tableInfo = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='visit_tasks'`)
    .get();
  if (tableInfo?.sql && !tableInfo.sql.includes('in_progress')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE visit_tasks_timing_v1 (
        id TEXT PRIMARY KEY,
        visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
        task_template_id TEXT REFERENCES task_templates(id) ON DELETE SET NULL,
        room_name TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        cadence TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'must' CHECK (priority IN ('must', 'nice', 'skip_visit')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'skipped', 'blocked')),
        skip_reason TEXT,
        started_at TEXT,
        completed_at TEXT,
        actual_minutes INTEGER
      );
      INSERT INTO visit_tasks_timing_v1 (
        id, visit_id, task_template_id, room_name, title, instructions, cadence, priority,
        status, skip_reason, started_at, completed_at, actual_minutes
      )
      SELECT
        id, visit_id, task_template_id, room_name, title, instructions, cadence, priority,
        status, skip_reason, started_at, completed_at, actual_minutes
      FROM visit_tasks;
      DROP TABLE visit_tasks;
      ALTER TABLE visit_tasks_timing_v1 RENAME TO visit_tasks;
      CREATE INDEX IF NOT EXISTS idx_visit_tasks_visit ON visit_tasks(visit_id);
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }

  const sql = readFileSync(join(__dirname, 'migrations', '004_visit_tasks_timing_v1.sql'), 'utf8');
  db.exec(sql);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_estimate_suggestions (
      id TEXT PRIMARY KEY,
      home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
      task_template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      current_minutes INTEGER NOT NULL,
      suggested_minutes INTEGER NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      divergence_percent REAL,
      ai_summary TEXT,
      ai_summary_cached_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      applied_at TEXT,
      UNIQUE(home_id, task_template_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_estimate_suggestions_home ON task_estimate_suggestions(home_id, status);
  `);

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('visit_tasks_timing_v1');
}

migrateVisitTasksTimingV1();

function boolToInt(value, defaultValue = 0) {
  if (value === undefined || value === null) return defaultValue;
  return value ? 1 : 0;
}

function jsonField(value, fallback = '[]') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function getCleanerProfileById(id) {
  return db.prepare('SELECT * FROM cleaner_profiles WHERE id = ?').get(id) ?? null;
}

export function getCleanerProfileByUserId(userId) {
  return db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(userId) ?? null;
}

export function listCleanerProfiles({ profileStatus } = {}) {
  if (profileStatus) {
    return db
      .prepare(
        'SELECT * FROM cleaner_profiles WHERE profile_status = ? ORDER BY updated_at DESC'
      )
      .all(profileStatus);
  }
  return db.prepare('SELECT * FROM cleaner_profiles ORDER BY updated_at DESC').all();
}

export function createCleanerProfile({
  id,
  userId,
  displayName,
  profilePhotoUrl = null,
  bio = '',
  experienceYears = null,
  hourlyRateCents = null,
  minimumVisitMinutes = null,
  minimumVisitCents = null,
  acceptsNewClients = false,
  suppliesIncluded = false,
  bringsVacuum = false,
  languages = '[]',
  petComfortLevel = 'none',
  fragranceFreeAvailable = false,
  ecoFriendlyProductsAvailable = false,
  bleachAllowed = true,
  deepCleaningAvailable = false,
  moveInMoveOutAvailable = false,
  recurringCleaningAvailable = true,
  oneTimeCleaningAvailable = true,
  profileStatus = 'draft',
  backgroundCheckStatus = 'not_provided',
  insuranceStatus = 'not_provided',
  stripeOnboardingStatus = 'not_started',
  adminNotes = '',
}) {
  db.prepare(
    `INSERT INTO cleaner_profiles (
      id, user_id, display_name, profile_photo_url, bio, experience_years, hourly_rate_cents,
      minimum_visit_minutes, minimum_visit_cents, accepts_new_clients,
      supplies_included, brings_vacuum, languages, pet_comfort_level,
      fragrance_free_available, eco_friendly_products_available, bleach_allowed,
      deep_cleaning_available, move_in_move_out_available,
      recurring_cleaning_available, one_time_cleaning_available,
      profile_status, background_check_status, insurance_status,
      stripe_onboarding_status, admin_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    displayName,
    profilePhotoUrl,
    bio,
    experienceYears,
    hourlyRateCents,
    minimumVisitMinutes,
    minimumVisitCents,
    boolToInt(acceptsNewClients),
    boolToInt(suppliesIncluded),
    boolToInt(bringsVacuum),
    jsonField(languages),
    petComfortLevel,
    boolToInt(fragranceFreeAvailable),
    boolToInt(ecoFriendlyProductsAvailable),
    boolToInt(bleachAllowed, 1),
    boolToInt(deepCleaningAvailable),
    boolToInt(moveInMoveOutAvailable),
    boolToInt(recurringCleaningAvailable, 1),
    boolToInt(oneTimeCleaningAvailable, 1),
    profileStatus,
    backgroundCheckStatus,
    insuranceStatus,
    stripeOnboardingStatus,
    adminNotes
  );
  return getCleanerProfileById(id);
}

export function updateCleanerProfile(id, fields) {
  const allowed = {
    displayName: 'display_name',
    profilePhotoUrl: 'profile_photo_url',
    bio: 'bio',
    experienceYears: 'experience_years',
    hourlyRateCents: 'hourly_rate_cents',
    minimumVisitMinutes: 'minimum_visit_minutes',
    minimumVisitCents: 'minimum_visit_cents',
    acceptsNewClients: 'accepts_new_clients',
    suppliesIncluded: 'supplies_included',
    bringsVacuum: 'brings_vacuum',
    languages: 'languages',
    petComfortLevel: 'pet_comfort_level',
    fragranceFreeAvailable: 'fragrance_free_available',
    ecoFriendlyProductsAvailable: 'eco_friendly_products_available',
    bleachAllowed: 'bleach_allowed',
    deepCleaningAvailable: 'deep_cleaning_available',
    moveInMoveOutAvailable: 'move_in_move_out_available',
    recurringCleaningAvailable: 'recurring_cleaning_available',
    oneTimeCleaningAvailable: 'one_time_cleaning_available',
    profileStatus: 'profile_status',
    backgroundCheckStatus: 'background_check_status',
    insuranceStatus: 'insurance_status',
    stripeOnboardingStatus: 'stripe_onboarding_status',
    adminNotes: 'admin_notes',
  };
  const boolFields = new Set([
    'acceptsNewClients',
    'suppliesIncluded',
    'bringsVacuum',
    'fragranceFreeAvailable',
    'ecoFriendlyProductsAvailable',
    'bleachAllowed',
    'deepCleaningAvailable',
    'moveInMoveOutAvailable',
    'recurringCleaningAvailable',
    'oneTimeCleaningAvailable',
  ]);
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (boolFields.has(key)) {
      values.push(boolToInt(fields[key], key === 'bleachAllowed' ? 1 : 0));
    } else if (key === 'languages') {
      values.push(jsonField(fields[key]));
    } else {
      values.push(fields[key]);
    }
  }
  if (!sets.length) return getCleanerProfileById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaner_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleanerProfileById(id);
}

export function getCleanerLanguageById(id) {
  return db.prepare('SELECT * FROM cleaner_languages WHERE id = ?').get(id) ?? null;
}

export function listCleanerLanguagesByProfileId(cleanerProfileId) {
  return db
    .prepare(
      `SELECT * FROM cleaner_languages
       WHERE cleaner_profile_id = ?
       ORDER BY language_name ASC`
    )
    .all(cleanerProfileId);
}

export function createCleanerLanguage({
  id,
  cleanerProfileId,
  languageCode,
  languageName,
  proficiency = 'conversational',
}) {
  db.prepare(
    `INSERT INTO cleaner_languages (
      id, cleaner_profile_id, language_code, language_name, proficiency
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, cleanerProfileId, languageCode, languageName, proficiency);
  return getCleanerLanguageById(id);
}

export function updateCleanerLanguage(id, fields) {
  const allowed = {
    languageCode: 'language_code',
    languageName: 'language_name',
    proficiency: 'proficiency',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(fields[key]);
  }
  if (!sets.length) return getCleanerLanguageById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaner_languages SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleanerLanguageById(id);
}

export function deleteCleanerLanguage(id) {
  return db.prepare('DELETE FROM cleaner_languages WHERE id = ?').run(id);
}

export function getCleanerServiceById(id) {
  return db.prepare('SELECT * FROM cleaner_services WHERE id = ?').get(id) ?? null;
}

export function listCleanerServicesByProfileId(cleanerProfileId) {
  return db
    .prepare(
      `SELECT * FROM cleaner_services
       WHERE cleaner_profile_id = ?
       ORDER BY service_label ASC`
    )
    .all(cleanerProfileId);
}

export function createCleanerService({
  id,
  cleanerProfileId,
  serviceKey,
  serviceLabel,
  isOffered = true,
}) {
  db.prepare(
    `INSERT INTO cleaner_services (
      id, cleaner_profile_id, service_key, service_label, is_offered
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, cleanerProfileId, serviceKey, serviceLabel, boolToInt(isOffered, 1));
  return getCleanerServiceById(id);
}

export function updateCleanerService(id, fields) {
  const allowed = {
    serviceKey: 'service_key',
    serviceLabel: 'service_label',
    isOffered: 'is_offered',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'isOffered' ? boolToInt(fields[key], 1) : fields[key]);
  }
  if (!sets.length) return getCleanerServiceById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaner_services SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleanerServiceById(id);
}

export function deleteCleanerService(id) {
  return db.prepare('DELETE FROM cleaner_services WHERE id = ?').run(id);
}

export function getCleanerServiceAreaById(id) {
  return db.prepare('SELECT * FROM cleaner_service_areas WHERE id = ?').get(id) ?? null;
}

export function listCleanerServiceAreasByProfileId(cleanerProfileId) {
  return db
    .prepare(
      'SELECT * FROM cleaner_service_areas WHERE cleaner_profile_id = ? ORDER BY created_at ASC'
    )
    .all(cleanerProfileId);
}

export function createCleanerServiceArea({
  id,
  cleanerProfileId,
  zipCode,
  city,
  state,
  radiusMiles = null,
  isPrimary = false,
}) {
  db.prepare(
    `INSERT INTO cleaner_service_areas (
      id, cleaner_profile_id, zip_code, city, state, radius_miles, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, cleanerProfileId, zipCode, city, state, radiusMiles, boolToInt(isPrimary));
  return getCleanerServiceAreaById(id);
}

export function updateCleanerServiceArea(id, fields) {
  const allowed = {
    zipCode: 'zip_code',
    city: 'city',
    state: 'state',
    radiusMiles: 'radius_miles',
    isPrimary: 'is_primary',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'isPrimary' ? boolToInt(fields[key]) : fields[key]);
  }
  if (!sets.length) return getCleanerServiceAreaById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaner_service_areas SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleanerServiceAreaById(id);
}

export function deleteCleanerServiceArea(id) {
  return db.prepare('DELETE FROM cleaner_service_areas WHERE id = ?').run(id);
}

export function getCleanerAvailabilityById(id) {
  return db.prepare('SELECT * FROM cleaner_availability WHERE id = ?').get(id) ?? null;
}

export function listCleanerAvailabilityByProfileId(cleanerProfileId) {
  return db
    .prepare(
      `SELECT * FROM cleaner_availability
       WHERE cleaner_profile_id = ?
       ORDER BY day_of_week ASC, start_time ASC`
    )
    .all(cleanerProfileId);
}

export function createCleanerAvailability({
  id,
  cleanerProfileId,
  dayOfWeek,
  startTime,
  endTime,
  isAvailable = true,
  notes = '',
}) {
  db.prepare(
    `INSERT INTO cleaner_availability (
      id, cleaner_profile_id, day_of_week, start_time, end_time, is_available, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, cleanerProfileId, dayOfWeek, startTime, endTime, boolToInt(isAvailable, 1), notes);
  return getCleanerAvailabilityById(id);
}

export function updateCleanerAvailability(id, fields) {
  const allowed = {
    dayOfWeek: 'day_of_week',
    startTime: 'start_time',
    endTime: 'end_time',
    isAvailable: 'is_available',
    notes: 'notes',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'isAvailable' ? boolToInt(fields[key], 1) : fields[key]);
  }
  if (!sets.length) return getCleanerAvailabilityById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaner_availability SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleanerAvailabilityById(id);
}

export function deleteCleanerAvailability(id) {
  return db.prepare('DELETE FROM cleaner_availability WHERE id = ?').run(id);
}

export function getCleaningRequestById(id) {
  return db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(id) ?? null;
}

export function listCleaningRequestsByHomeownerId(homeownerId) {
  return db
    .prepare(
      'SELECT * FROM cleaning_requests WHERE homeowner_id = ? ORDER BY created_at DESC'
    )
    .all(homeownerId);
}

export function listCleaningRequestsByStatus(status) {
  return db
    .prepare('SELECT * FROM cleaning_requests WHERE status = ? ORDER BY created_at DESC')
    .all(status);
}

export function listOpenCleaningRequestsByZipCodes(zipCodes = []) {
  if (!zipCodes.length) return [];
  const placeholders = zipCodes.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM cleaning_requests
       WHERE status IN ('open', 'proposals_received')
         AND zip_code IN (${placeholders})
       ORDER BY created_at DESC`
    )
    .all(...zipCodes);
}

export function listAllCleaningRequests() {
  return db.prepare('SELECT * FROM cleaning_requests ORDER BY created_at DESC').all();
}

export function createCleaningRequest({
  id,
  homeownerId,
  householdId = null,
  zipCode,
  city,
  state,
  homeSizeLabel = '',
  bedrooms = null,
  bathrooms = null,
  squareFeet = null,
  frequency = 'weekly',
  preferredDays = '[]',
  preferredTimeWindows = '[]',
  pets = '',
  suppliesAvailable = false,
  homeownerBudgetMinCents = null,
  homeownerBudgetMaxCents = null,
  estimatedMinutes = 0,
  aiPreferenceSummary = '',
  status = 'draft',
}) {
  db.prepare(
    `INSERT INTO cleaning_requests (
      id, homeowner_id, household_id, zip_code, city, state, home_size_label,
      bedrooms, bathrooms, square_feet, frequency, preferred_days,
      preferred_time_windows, pets, supplies_available,
      homeowner_budget_min_cents, homeowner_budget_max_cents,
      estimated_minutes, ai_preference_summary, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    homeownerId,
    householdId,
    zipCode,
    city,
    state,
    homeSizeLabel,
    bedrooms,
    bathrooms,
    squareFeet,
    frequency,
    jsonField(preferredDays),
    jsonField(preferredTimeWindows),
    pets,
    boolToInt(suppliesAvailable),
    homeownerBudgetMinCents,
    homeownerBudgetMaxCents,
    estimatedMinutes,
    aiPreferenceSummary,
    status
  );
  return getCleaningRequestById(id);
}

export function updateCleaningRequest(id, fields) {
  const allowed = {
    householdId: 'household_id',
    zipCode: 'zip_code',
    city: 'city',
    state: 'state',
    homeSizeLabel: 'home_size_label',
    bedrooms: 'bedrooms',
    bathrooms: 'bathrooms',
    squareFeet: 'square_feet',
    frequency: 'frequency',
    preferredDays: 'preferred_days',
    preferredTimeWindows: 'preferred_time_windows',
    pets: 'pets',
    suppliesAvailable: 'supplies_available',
    homeownerBudgetMinCents: 'homeowner_budget_min_cents',
    homeownerBudgetMaxCents: 'homeowner_budget_max_cents',
    estimatedMinutes: 'estimated_minutes',
    aiPreferenceSummary: 'ai_preference_summary',
    status: 'status',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (key === 'suppliesAvailable') {
      values.push(boolToInt(fields[key]));
    } else if (key === 'preferredDays' || key === 'preferredTimeWindows') {
      values.push(jsonField(fields[key]));
    } else {
      values.push(fields[key]);
    }
  }
  if (!sets.length) return getCleaningRequestById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaning_requests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleaningRequestById(id);
}

export function cancelCleaningRequest(id) {
  db.prepare(
    `UPDATE cleaning_requests
     SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ?`
  ).run(id);
  return getCleaningRequestById(id);
}

export function getCleaningRequestTaskById(id) {
  return db.prepare('SELECT * FROM cleaning_request_tasks WHERE id = ?').get(id) ?? null;
}

export function listCleaningRequestTasksByRequestId(requestId) {
  return db
    .prepare(
      `SELECT * FROM cleaning_request_tasks
       WHERE request_id = ?
       ORDER BY sort_order ASC, created_at ASC`
    )
    .all(requestId);
}

export function createCleaningRequestTask({
  id,
  requestId,
  roomName,
  taskName,
  notes = '',
  cadence,
  estimatedMinutes = 15,
  isDeepClean = false,
  sortOrder = 0,
}) {
  db.prepare(
    `INSERT INTO cleaning_request_tasks (
      id, request_id, room_name, task_name, notes, cadence,
      estimated_minutes, is_deep_clean, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    requestId,
    roomName,
    taskName,
    notes,
    cadence,
    estimatedMinutes,
    boolToInt(isDeepClean),
    sortOrder
  );
  recalculateCleaningRequestEstimatedMinutes(requestId);
  return getCleaningRequestTaskById(id);
}

export function updateCleaningRequestTask(id, fields) {
  const existing = getCleaningRequestTaskById(id);
  if (!existing) return null;

  const allowed = {
    roomName: 'room_name',
    taskName: 'task_name',
    notes: 'notes',
    cadence: 'cadence',
    estimatedMinutes: 'estimated_minutes',
    isDeepClean: 'is_deep_clean',
    sortOrder: 'sort_order',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'isDeepClean' ? boolToInt(fields[key]) : fields[key]);
  }
  if (!sets.length) return existing;
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaning_request_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  recalculateCleaningRequestEstimatedMinutes(existing.request_id);
  return getCleaningRequestTaskById(id);
}

export function deleteCleaningRequestTask(id) {
  const existing = getCleaningRequestTaskById(id);
  if (!existing) return { changes: 0 };
  const result = db.prepare('DELETE FROM cleaning_request_tasks WHERE id = ?').run(id);
  recalculateCleaningRequestEstimatedMinutes(existing.request_id);
  return result;
}

export function recalculateCleaningRequestEstimatedMinutes(requestId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_minutes), 0) AS total
       FROM cleaning_request_tasks WHERE request_id = ?`
    )
    .get(requestId);
  db.prepare(
    `UPDATE cleaning_requests
     SET estimated_minutes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(row.total, requestId);
  return row.total;
}

export function getCleanerProposalById(id) {
  return db.prepare('SELECT * FROM cleaner_proposals WHERE id = ?').get(id) ?? null;
}

export function listCleanerProposalsByRequestId(requestId) {
  return db
    .prepare(
      'SELECT * FROM cleaner_proposals WHERE request_id = ? ORDER BY created_at DESC'
    )
    .all(requestId);
}

export function listCleanerProposalsByCleanerId(cleanerId) {
  return db
    .prepare(
      'SELECT * FROM cleaner_proposals WHERE cleaner_id = ? ORDER BY created_at DESC'
    )
    .all(cleanerId);
}

export function createCleanerProposal({
  id,
  requestId,
  cleanerId,
  cleanerProfileId,
  hourlyRateCents,
  minimumVisitMinutes = null,
  minimumVisitCents = null,
  firstVisitEstimatedMinutes,
  firstVisitTotalCents,
  recurringEstimatedMinutes,
  recurringTotalCents,
  suppliesIncluded = false,
  proposedDay = null,
  proposedStartTime = null,
  proposedEndTime = null,
  message = '',
  adjustmentReason = '',
  status = 'sent',
}) {
  db.prepare(
    `INSERT INTO cleaner_proposals (
      id, request_id, cleaner_id, cleaner_profile_id, hourly_rate_cents,
      minimum_visit_minutes, minimum_visit_cents, first_visit_estimated_minutes,
      first_visit_total_cents, recurring_estimated_minutes, recurring_total_cents,
      supplies_included, proposed_day, proposed_start_time, proposed_end_time,
      message, adjustment_reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    requestId,
    cleanerId,
    cleanerProfileId,
    hourlyRateCents,
    minimumVisitMinutes,
    minimumVisitCents,
    firstVisitEstimatedMinutes,
    firstVisitTotalCents,
    recurringEstimatedMinutes,
    recurringTotalCents,
    boolToInt(suppliesIncluded),
    proposedDay,
    proposedStartTime,
    proposedEndTime,
    message,
    adjustmentReason,
    status
  );
  return getCleanerProposalById(id);
}

export function updateCleanerProposal(id, fields) {
  const allowed = {
    hourlyRateCents: 'hourly_rate_cents',
    minimumVisitMinutes: 'minimum_visit_minutes',
    minimumVisitCents: 'minimum_visit_cents',
    firstVisitEstimatedMinutes: 'first_visit_estimated_minutes',
    firstVisitTotalCents: 'first_visit_total_cents',
    recurringEstimatedMinutes: 'recurring_estimated_minutes',
    recurringTotalCents: 'recurring_total_cents',
    suppliesIncluded: 'supplies_included',
    proposedDay: 'proposed_day',
    proposedStartTime: 'proposed_start_time',
    proposedEndTime: 'proposed_end_time',
    message: 'message',
    adjustmentReason: 'adjustment_reason',
    status: 'status',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'suppliesIncluded' ? boolToInt(fields[key]) : fields[key]);
  }
  if (!sets.length) return getCleanerProposalById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE cleaner_proposals SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCleanerProposalById(id);
}

export function withdrawCleanerProposal(id) {
  db.prepare(
    `UPDATE cleaner_proposals
     SET status = 'withdrawn', updated_at = datetime('now')
     WHERE id = ?`
  ).run(id);
  return getCleanerProposalById(id);
}

export function getHouseholdCleanerAgreementById(id) {
  return db.prepare('SELECT * FROM household_cleaner_agreements WHERE id = ?').get(id) ?? null;
}

export function listHouseholdCleanerAgreementsByUserId(userId) {
  return db
    .prepare(
      `SELECT * FROM household_cleaner_agreements
       WHERE homeowner_id = ? OR cleaner_id = ?
       ORDER BY created_at DESC`
    )
    .all(userId, userId);
}

export function listHouseholdCleanerAgreementsByHouseholdId(householdId) {
  return db
    .prepare(
      `SELECT * FROM household_cleaner_agreements
       WHERE household_id = ?
       ORDER BY created_at DESC`
    )
    .all(householdId);
}

export function createHouseholdCleanerAgreement({
  id,
  householdId,
  homeownerId,
  cleanerId,
  acceptedProposalId = null,
  source,
  hourlyRateCents,
  recurringEstimatedMinutes,
  recurringEstimatedTotalCents,
  firstVisitEstimatedMinutes = null,
  firstVisitEstimatedTotalCents = null,
  agreedFrequency,
  agreedDay = null,
  agreedStartTime = null,
  agreedEndTime = null,
  suppliesIncluded = false,
  status = 'active',
}) {
  db.prepare(
    `INSERT INTO household_cleaner_agreements (
      id, household_id, homeowner_id, cleaner_id, accepted_proposal_id, source,
      hourly_rate_cents, recurring_estimated_minutes, recurring_estimated_total_cents,
      first_visit_estimated_minutes, first_visit_estimated_total_cents,
      agreed_frequency, agreed_day, agreed_start_time, agreed_end_time,
      supplies_included, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    householdId,
    homeownerId,
    cleanerId,
    acceptedProposalId,
    source,
    hourlyRateCents,
    recurringEstimatedMinutes,
    recurringEstimatedTotalCents,
    firstVisitEstimatedMinutes,
    firstVisitEstimatedTotalCents,
    agreedFrequency,
    agreedDay,
    agreedStartTime,
    agreedEndTime,
    boolToInt(suppliesIncluded),
    status
  );
  return getHouseholdCleanerAgreementById(id);
}

export function updateHouseholdCleanerAgreement(id, fields) {
  const allowed = {
    acceptedProposalId: 'accepted_proposal_id',
    hourlyRateCents: 'hourly_rate_cents',
    recurringEstimatedMinutes: 'recurring_estimated_minutes',
    recurringEstimatedTotalCents: 'recurring_estimated_total_cents',
    firstVisitEstimatedMinutes: 'first_visit_estimated_minutes',
    firstVisitEstimatedTotalCents: 'first_visit_estimated_total_cents',
    agreedFrequency: 'agreed_frequency',
    agreedDay: 'agreed_day',
    agreedStartTime: 'agreed_start_time',
    agreedEndTime: 'agreed_end_time',
    suppliesIncluded: 'supplies_included',
    status: 'status',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'suppliesIncluded' ? boolToInt(fields[key]) : fields[key]);
  }
  if (!sets.length) return getHouseholdCleanerAgreementById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE household_cleaner_agreements SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values
  );
  return getHouseholdCleanerAgreementById(id);
}

export function getScopeChangeRequestById(id) {
  return db.prepare('SELECT * FROM scope_change_requests WHERE id = ?').get(id) ?? null;
}

export function listScopeChangeRequestsByAgreementId(agreementId) {
  return db
    .prepare(
      `SELECT * FROM scope_change_requests
       WHERE agreement_id = ?
       ORDER BY created_at DESC`
    )
    .all(agreementId);
}

export function createScopeChangeRequest({
  id,
  agreementId,
  householdId,
  requestedByUserId,
  oldEstimatedMinutes,
  newEstimatedMinutes,
  addedMinutes,
  oldEstimatedTotalCents = null,
  newEstimatedTotalCents = null,
  notes = '',
  status = 'pending',
  cleanerAdjustedMinutes = null,
  cleanerAdjustedTotalCents = null,
  cleanerMessage = null,
  homeownerResponse = null,
}) {
  db.prepare(
    `INSERT INTO scope_change_requests (
      id, agreement_id, household_id, requested_by_user_id,
      old_estimated_minutes, new_estimated_minutes, added_minutes,
      old_estimated_total_cents, new_estimated_total_cents, notes, status,
      cleaner_adjusted_minutes, cleaner_adjusted_total_cents,
      cleaner_message, homeowner_response
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    agreementId,
    householdId,
    requestedByUserId,
    oldEstimatedMinutes,
    newEstimatedMinutes,
    addedMinutes,
    oldEstimatedTotalCents,
    newEstimatedTotalCents,
    notes,
    status,
    cleanerAdjustedMinutes,
    cleanerAdjustedTotalCents,
    cleanerMessage,
    homeownerResponse
  );
  return getScopeChangeRequestById(id);
}

export function updateScopeChangeRequest(id, fields) {
  const allowed = {
    oldEstimatedMinutes: 'old_estimated_minutes',
    newEstimatedMinutes: 'new_estimated_minutes',
    addedMinutes: 'added_minutes',
    oldEstimatedTotalCents: 'old_estimated_total_cents',
    newEstimatedTotalCents: 'new_estimated_total_cents',
    notes: 'notes',
    status: 'status',
    cleanerAdjustedMinutes: 'cleaner_adjusted_minutes',
    cleanerAdjustedTotalCents: 'cleaner_adjusted_total_cents',
    cleanerMessage: 'cleaner_message',
    homeownerResponse: 'homeowner_response',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(fields[key]);
  }
  if (!sets.length) return getScopeChangeRequestById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE scope_change_requests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getScopeChangeRequestById(id);
}

export function getAdminMatchSuggestionById(id) {
  return db.prepare('SELECT * FROM admin_match_suggestions WHERE id = ?').get(id) ?? null;
}

export function listAdminMatchSuggestions({ requestId, status } = {}) {
  const clauses = [];
  const values = [];
  if (requestId) {
    clauses.push('request_id = ?');
    values.push(requestId);
  }
  if (status) {
    clauses.push('status = ?');
    values.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM admin_match_suggestions ${where} ORDER BY created_at DESC`)
    .all(...values);
}

export function createAdminMatchSuggestion({
  id,
  requestId,
  cleanerProfileId,
  suggestedByAdminId,
  score = null,
  reasonsJson = '[]',
  status = 'suggested',
}) {
  db.prepare(
    `INSERT INTO admin_match_suggestions (
      id, request_id, cleaner_profile_id, suggested_by_admin_id, score, reasons_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    requestId,
    cleanerProfileId,
    suggestedByAdminId,
    score,
    jsonField(reasonsJson),
    status
  );
  return getAdminMatchSuggestionById(id);
}

export function updateAdminMatchSuggestion(id, fields) {
  const allowed = {
    score: 'score',
    reasonsJson: 'reasons_json',
    status: 'status',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'reasonsJson' ? jsonField(fields[key]) : fields[key]);
  }
  if (!sets.length) return getAdminMatchSuggestionById(id);
  sets.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE admin_match_suggestions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getAdminMatchSuggestionById(id);
}

/** Active agreement for invoice fee lookup (household_cleaner_agreements.source). */
export function getActiveHouseholdCleanerAgreement(householdId, cleanerId) {
  return (
    db
      .prepare(
        `SELECT * FROM household_cleaner_agreements
         WHERE household_id = ? AND cleaner_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(householdId, cleanerId) ?? null
  );
}

export function getPaymentIntentById(id) {
  return db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) ?? null;
}

export function updatePaymentIntentStatus(id, status) {
  db.prepare(
    `UPDATE payment_intents SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id);
  return getPaymentIntentById(id);
}

/**
 * Audit row when a platform fee is collected (typically from Stripe webhook).
 */
export function createPlatformFee({
  id,
  paymentIntentId = null,
  invoiceId = null,
  agreementId = null,
  feeType,
  feePercent,
  cleanerAmountCents,
  feeAmountCents,
  totalAmountCents,
  stripeFeeId = null,
}) {
  db.prepare(
    `INSERT INTO platform_fees (
      id, payment_intent_id, invoice_id, agreement_id,
      fee_type, fee_percent, cleaner_amount_cents, fee_amount_cents,
      total_amount_cents, stripe_fee_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    paymentIntentId,
    invoiceId,
    agreementId,
    feeType,
    feePercent,
    cleanerAmountCents,
    feeAmountCents,
    totalAmountCents,
    stripeFeeId
  );
  return db.prepare('SELECT * FROM platform_fees WHERE id = ?').get(id);
}

function migrateEstimateLearningAiV1() {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('estimate_learning_ai_v1');
  if (done) return;

  const sugCols = db.prepare('PRAGMA table_info(task_estimate_suggestions)').all();
  if (sugCols.length && !sugCols.some((c) => c.name === 'ai_summary')) {
    db.exec(`ALTER TABLE task_estimate_suggestions ADD COLUMN ai_summary TEXT`);
  }
  if (sugCols.length && !sugCols.some((c) => c.name === 'ai_summary_cached_at')) {
    db.exec(`ALTER TABLE task_estimate_suggestions ADD COLUMN ai_summary_cached_at TEXT`);
  }
  if (sugCols.length && !sugCols.some((c) => c.name === 'divergence_percent')) {
    db.exec(`ALTER TABLE task_estimate_suggestions ADD COLUMN divergence_percent REAL`);
  }

  db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('estimate_learning_ai_v1');
}

migrateEstimateLearningAiV1();

export default db;
