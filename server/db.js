import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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
  bio = '',
  experienceYears = null,
  hourlyRateCents = null,
  minimumVisitMinutes = null,
  minimumVisitCents = null,
  acceptsNewClients = false,
  suppliesIncluded = false,
  bringsVacuum = false,
  languages = '[]',
  profileStatus = 'draft',
  backgroundCheckStatus = 'not_provided',
  insuranceStatus = 'not_provided',
  adminNotes = '',
}) {
  db.prepare(
    `INSERT INTO cleaner_profiles (
      id, user_id, display_name, bio, experience_years, hourly_rate_cents,
      minimum_visit_minutes, minimum_visit_cents, accepts_new_clients,
      supplies_included, brings_vacuum, languages, profile_status,
      background_check_status, insurance_status, admin_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    displayName,
    bio,
    experienceYears,
    hourlyRateCents,
    minimumVisitMinutes,
    minimumVisitCents,
    boolToInt(acceptsNewClients),
    boolToInt(suppliesIncluded),
    boolToInt(bringsVacuum),
    jsonField(languages),
    profileStatus,
    backgroundCheckStatus,
    insuranceStatus,
    adminNotes
  );
  return getCleanerProfileById(id);
}

export function updateCleanerProfile(id, fields) {
  const allowed = {
    displayName: 'display_name',
    bio: 'bio',
    experienceYears: 'experience_years',
    hourlyRateCents: 'hourly_rate_cents',
    minimumVisitMinutes: 'minimum_visit_minutes',
    minimumVisitCents: 'minimum_visit_cents',
    acceptsNewClients: 'accepts_new_clients',
    suppliesIncluded: 'supplies_included',
    bringsVacuum: 'brings_vacuum',
    languages: 'languages',
    profileStatus: 'profile_status',
    backgroundCheckStatus: 'background_check_status',
    insuranceStatus: 'insurance_status',
    adminNotes: 'admin_notes',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    if (['acceptsNewClients', 'suppliesIncluded', 'bringsVacuum'].includes(key)) {
      values.push(boolToInt(fields[key]));
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
}) {
  db.prepare(
    `INSERT INTO cleaner_service_areas (id, cleaner_profile_id, zip_code, city, state, radius_miles)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, cleanerProfileId, zipCode, city, state, radiusMiles);
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
}) {
  db.prepare(
    `INSERT INTO cleaner_availability (
      id, cleaner_profile_id, day_of_week, start_time, end_time, is_available
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, cleanerProfileId, dayOfWeek, startTime, endTime, boolToInt(isAvailable, 1));
  return getCleanerAvailabilityById(id);
}

export function updateCleanerAvailability(id, fields) {
  const allowed = {
    dayOfWeek: 'day_of_week',
    startTime: 'start_time',
    endTime: 'end_time',
    isAvailable: 'is_available',
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

export default db;
