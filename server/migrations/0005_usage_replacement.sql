-- Stage complete per-account snapshots; existing rankings stay visible until commit.
CREATE TABLE IF NOT EXISTS usage_replacements (
  user_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  source_at INTEGER NOT NULL,
  total_days INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  client_version TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('collecting','committing','complete')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_replacement_chunks (
  user_id INTEGER NOT NULL,
  replacement_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  digest TEXT NOT NULL,
  days_json TEXT NOT NULL,
  PRIMARY KEY(user_id,replacement_id,batch_index)
);
CREATE TABLE IF NOT EXISTS usage_rebuild_guard (
  user_id INTEGER PRIMARY KEY,
  client_version TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  source_at INTEGER NOT NULL
);
