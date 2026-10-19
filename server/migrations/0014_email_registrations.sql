-- Optional private email registration only; no subscription or delivery is enabled.
CREATE TABLE IF NOT EXISTS email_registrations (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  consent_at INTEGER,
  consent_version TEXT,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- A withdrawn row retains only its revision, preventing stale requests from restoring an address.
CREATE TRIGGER IF NOT EXISTS email_registrations_account_insert BEFORE INSERT ON email_registrations
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS email_registrations_account_update BEFORE UPDATE OF user_id ON email_registrations
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
