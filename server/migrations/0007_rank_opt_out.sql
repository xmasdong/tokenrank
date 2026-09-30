-- 用户可关闭排名：仍能看自己的用量，但不出现在广场榜、群榜和他人可见的名次里。
ALTER TABLE users ADD COLUMN rank_hidden INTEGER NOT NULL DEFAULT 0;
CREATE VIEW IF NOT EXISTS public_usage AS
  SELECT r.* FROM ranked_usage r JOIN users u ON u.id = r.user_id AND u.rank_hidden = 0;
