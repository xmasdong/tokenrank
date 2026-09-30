-- 后台停用账号：停用后不出现在任何榜单，上传被拒；数据保留，可恢复。
-- 停用：UPDATE users SET disabled_at = <毫秒时间戳>, disabled_reason = '原因' WHERE id = <用户ID>;
-- 恢复：UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = <用户ID>;
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
ALTER TABLE users ADD COLUMN disabled_reason TEXT;
DROP VIEW IF EXISTS ranked_usage;
CREATE VIEW ranked_usage AS
  SELECT d.* FROM daily_totals d JOIN usage_sync_state s
  ON s.user_id=d.user_id AND s.device_id=d.device_id
  JOIN users u ON u.id=d.user_id AND u.disabled_at IS NULL;
