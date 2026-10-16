-- Optional joint distribution; existing totals and history stay intact.
ALTER TABLE daily_totals ADD COLUMN tool_models_json TEXT;
