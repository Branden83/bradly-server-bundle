CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('client', 'cleaner', 'admin')),
  push_token TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'trial',
  subscription_trial_ends_at TEXT,
  subscription_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS homes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  visit_day INTEGER NOT NULL DEFAULT 2,
  visit_time TEXT NOT NULL DEFAULT '10:00',
  hourly_rate_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS home_members (
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'cleaner')),
  PRIMARY KEY (home_id, user_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly')),
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  active INTEGER NOT NULL DEFAULT 1,
  last_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed')),
  cleaner_response TEXT NOT NULL DEFAULT 'pending' CHECK (cleaner_response IN ('pending', 'accepted', 'declined')),
  cleaner_responded_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visit_tasks (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  task_template_id TEXT REFERENCES task_templates(id) ON DELETE SET NULL,
  room_name TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'blocked')),
  skip_reason TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_questions (
  id TEXT PRIMARY KEY,
  visit_task_id TEXT NOT NULL REFERENCES visit_tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'cleaner' CHECK (role IN ('cleaner', 'member')),
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_visits_home_date ON visits(home_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_visit_tasks_visit ON visit_tasks(visit_id);
CREATE INDEX IF NOT EXISTS idx_questions_task ON task_questions(visit_task_id);

CREATE TABLE IF NOT EXISTS payment_methods (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  venmo_handle TEXT,
  zelle_contact TEXT,
  cashapp_handle TEXT,
  paypal_handle TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  visit_id TEXT REFERENCES visits(id) ON DELETE SET NULL,
  cleaner_id TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'paid', 'cancelled')),
  paid_via TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_home ON invoices(home_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_cleaner ON invoices(cleaner_id, created_at DESC);

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
