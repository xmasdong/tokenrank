-- Preserve the legacy UTC/input-output rows. Only fully initialized v2 sources enter rankings.
CREATE TABLE IF NOT EXISTS daily_totals (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_totals_day ON daily_totals(day);
CREATE TABLE IF NOT EXISTS usage_sync_state (
  user_id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIEW IF NOT EXISTS ranked_usage AS
  SELECT d.* FROM daily_totals d JOIN usage_sync_state s
  ON s.user_id=d.user_id AND s.device_id=d.device_id;
