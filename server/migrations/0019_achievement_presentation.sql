-- Short-lived display reservations. Existing display receipts and usage stay intact.
CREATE TABLE IF NOT EXISTS achievement_display_leases (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL,
  badge_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS achievement_lease_account_insert BEFORE INSERT ON achievement_display_leases
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS achievement_lease_account_update BEFORE UPDATE ON achievement_display_leases
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_NOT_FOUND'); END;
