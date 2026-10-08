-- Optional estimates from the original collector; NULL means not synced, never $0.
ALTER TABLE daily_totals ADD COLUMN cost_json TEXT;
