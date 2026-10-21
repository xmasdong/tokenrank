-- Private ledger of a user's paid AI subscriptions; amounts in minor units (分 / 美分).
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  plan TEXT,
  price_minor INTEGER NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('CNY','USD')),
  cycle TEXT NOT NULL CHECK (cycle IN ('week','month','quarter','year','custom')),
  custom_days INTEGER,
  start_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled')),
  ended_day TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE TRIGGER IF NOT EXISTS user_subscriptions_account_insert BEFORE INSERT ON user_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS user_subscriptions_account_update BEFORE UPDATE OF user_id ON user_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'ACCOUNT_NOT_FOUND'); END;
