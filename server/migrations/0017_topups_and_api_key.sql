-- Prepaid API balances (DeepSeek): each top-up, and balances the user copied from the vendor console to recalibrate.
CREATE TABLE IF NOT EXISTS user_topups (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL CHECK (vendor IN ('deepseek')),
  kind TEXT NOT NULL CHECK (kind IN ('topup','balance')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('CNY','USD','EUR','GBP','HKD','JPY')),
  day TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_topups_user ON user_topups(user_id);
CREATE TRIGGER IF NOT EXISTS user_topups_account_insert BEFORE INSERT ON user_topups
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS user_topups_account_update BEFORE UPDATE OF user_id ON user_topups
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
-- A plan whose vendor usage is paid through an API key instead: that usage is not counted toward the plan.
ALTER TABLE user_subscriptions ADD COLUMN api_key INTEGER NOT NULL DEFAULT 0;
