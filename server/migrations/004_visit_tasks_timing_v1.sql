-- Reference migration for visit_tasks_timing_v1 (applied in db.js migrateVisitTasksTimingV1).
-- Adds actual-time tracking on visit tasks and tables for estimate learning.

CREATE TABLE IF NOT EXISTS task_actual_records (
  id TEXT PRIMARY KEY,
  task_template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  visit_task_id TEXT REFERENCES visit_tasks(id) ON DELETE SET NULL,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  actual_minutes INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_actual_records_template
  ON task_actual_records(task_template_id, recorded_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_task_estimate_suggestions_home
  ON task_estimate_suggestions(home_id, status);
