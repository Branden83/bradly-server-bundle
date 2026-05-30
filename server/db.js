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

export default db;
