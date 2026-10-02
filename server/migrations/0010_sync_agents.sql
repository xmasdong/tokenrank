-- Separate liveness from changed usage. No credentials, paths or raw error logs.
CREATE TABLE IF NOT EXISTS sync_agents (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  client_version TEXT NOT NULL,
  collector_version TEXT,
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT,
  source_day TEXT,
  check_started_at INTEGER,
  checked_at INTEGER,
  event_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_seen ON sync_agents(last_seen_at);
CREATE TRIGGER IF NOT EXISTS sync_agents_account_insert
BEFORE INSERT ON sync_agents
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS sync_agents_account_update
BEFORE UPDATE ON sync_agents
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
