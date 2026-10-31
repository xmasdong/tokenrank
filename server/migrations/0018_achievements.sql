-- Achievement display receipts and actual upload days. No historical upload backfill.
CREATE TABLE IF NOT EXISTS achievement_upload_days (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  first_report_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, day)
);
CREATE TABLE IF NOT EXISTS achievement_displays (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  shown_at INTEGER NOT NULL,
  achieved_day TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY(user_id, badge_id, rule_version)
);
CREATE INDEX IF NOT EXISTS idx_achievement_claim ON achievement_displays(user_id, claim_id);
CREATE TRIGGER IF NOT EXISTS achievement_upload_account_insert BEFORE INSERT ON achievement_upload_days
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS achievement_upload_account_update BEFORE UPDATE ON achievement_upload_days
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS achievement_display_account_insert BEFORE INSERT ON achievement_displays
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS achievement_display_account_update BEFORE UPDATE ON achievement_displays
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
