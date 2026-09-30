-- 按群控制是否显示自己的排名：隐藏后不出现在该群榜单，其他群和广场不受影响。
ALTER TABLE rank_group_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
