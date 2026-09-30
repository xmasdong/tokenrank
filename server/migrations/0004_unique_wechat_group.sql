-- Run the duplicate-key audit before applying. No historical rows are deleted or merged.
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_wechat_identity
ON rank_groups(group_openid_hash) WHERE group_openid_hash IS NOT NULL;
