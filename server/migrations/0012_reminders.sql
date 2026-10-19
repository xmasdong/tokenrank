-- Additive only: never rewrite or delete existing usage.
CREATE TABLE IF NOT EXISTS reminder_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  awaiting_first_report INTEGER NOT NULL DEFAULT 0,
  prompt_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS reminder_jobs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('weekly','sync_error')),
  id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','cancelled','needs_permission','failed','unknown','skipped')),
  scheduled_at INTEGER,
  week_start TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempted_at INTEGER,
  last_sent_at INTEGER,
  error_code TEXT,
  PRIMARY KEY(user_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_reminder_due ON reminder_jobs(state,scheduled_at);
CREATE TABLE IF NOT EXISTS reminder_failure_runs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error_since INTEGER,
  event_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,device_id)
);
CREATE TRIGGER IF NOT EXISTS reminder_preferences_account_insert BEFORE INSERT ON reminder_preferences
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_jobs_account_insert BEFORE INSERT ON reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_failure_runs_account_insert BEFORE INSERT ON reminder_failure_runs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS reminder_preferences_account_update BEFORE UPDATE OF user_id ON reminder_preferences
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_jobs_account_update BEFORE UPDATE OF user_id ON reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_failure_runs_account_update BEFORE UPDATE OF user_id ON reminder_failure_runs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
