CREATE TABLE IF NOT EXISTS usage_shares (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_usage_shares_owner_time ON usage_shares(user_id, created_at);
