-- Expand reminder kinds without changing usage or interpreting weekly consent as daily consent.
CREATE TABLE IF NOT EXISTS reminder_jobs_daily_migration (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('weekly','daily','sync_error')),
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
INSERT OR REPLACE INTO reminder_jobs_daily_migration(user_id,kind,id,request_id,template_id,state,scheduled_at,week_start,created_at,updated_at,attempted_at,last_sent_at,error_code) SELECT user_id,kind,id,request_id,template_id,state,scheduled_at,week_start,created_at,updated_at,attempted_at,last_sent_at,error_code FROM reminder_jobs;
DROP TABLE reminder_jobs;
ALTER TABLE reminder_jobs_daily_migration RENAME TO reminder_jobs;
CREATE INDEX IF NOT EXISTS idx_reminder_due ON reminder_jobs(state,scheduled_at);
CREATE TRIGGER IF NOT EXISTS reminder_jobs_account_insert BEFORE INSERT ON reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS reminder_jobs_account_update BEFORE UPDATE OF user_id ON reminder_jobs
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
-- A weekly appointment never turns into a daily appointment without a new user gesture.
UPDATE reminder_jobs SET state='cancelled',error_code='DAILY_REPLACED_WEEKLY',updated_at=unixepoch()*1000
WHERE kind='weekly' AND state='pending';
