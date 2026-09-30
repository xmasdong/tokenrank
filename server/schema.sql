-- 「Token 群排名」D1 表结构（部署见 wrangler.toml.example 注释）
-- 原则：只存聚合数字与微信侧公开资料（昵称/头像），无原始明细、无 IP、无设备指纹。

-- 用户：openid 为唯一锚点（wx.login → code2session）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  nickname TEXT,
  avatar_path TEXT,
  session_key TEXT,                          -- 微信会话密钥（解密 getGroupEnterInfo 用，永不返回）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,                      -- 后台停用：不上榜、拒绝上传，数据保留
  disabled_reason TEXT,
  rank_hidden INTEGER NOT NULL DEFAULT 0     -- 用户关闭排名：自己可见用量，不上任何榜
);

-- 小程序会话：随机 token，30 天有效
CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content BLOB NOT NULL,
  mime_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mp_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mp_sessions_user ON mp_sessions(user_id);

-- 采集接入码：客户端 Bearer 凭证；每用户一个活跃码（重置即作废旧码）
CREATE TABLE IF NOT EXISTS connect_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id TEXT,                            -- 客户端自报随机设备 id（仅排查用，非指纹）
  created_at INTEGER NOT NULL,
  last_report_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_connect_user ON connect_tokens(user_id);

-- 一个真实微信群对应一张榜：只通过解密的群身份建立绑定和成员关系。
CREATE TABLE IF NOT EXISTS rank_groups (
  id TEXT PRIMARY KEY,                       -- 8 位随机短 id
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  group_openid_hash TEXT,                    -- 微信群匿名标识哈希；空值仅兼容历史手动群
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_oidhash ON rank_groups(group_openid_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_wechat_identity ON rank_groups(group_openid_hash) WHERE group_openid_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS rank_group_members (
  group_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON rank_group_members(user_id);

-- 日桶：客户端按天上报；同日重报取 MAX（水位，防删本地日志回退榜单）
-- models_json / tools_json 为 [[名称, 当日该维 tokens], ...] ≤8 条，绝对量便于跨天聚合
CREATE TABLE IF NOT EXISTS daily_stats (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,                         -- UTC YYYY-MM-DD
  tokens INTEGER NOT NULL DEFAULT 0,         -- input+output（不含缓存）
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  models_json TEXT,
  tools_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);
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
  ON s.user_id=d.user_id AND s.device_id=d.device_id
  JOIN users u ON u.id=d.user_id AND u.disabled_at IS NULL;
CREATE VIEW IF NOT EXISTS public_usage AS
  SELECT r.* FROM ranked_usage r JOIN users u ON u.id = r.user_id AND u.rank_hidden = 0;

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
