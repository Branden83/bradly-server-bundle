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

export default db;
