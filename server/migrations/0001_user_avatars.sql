-- Additive migration: retains all users and usage records.
CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content BLOB NOT NULL,
  mime_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
