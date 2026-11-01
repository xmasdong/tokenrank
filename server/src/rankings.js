import { usageWindow } from './usage.js';
import { sanitizeName } from './lib.js';

/** One aggregate for every joined group; never one query per group. */
export async function rankingsOverview(env, user, value) {
  const range = usageWindow(value), { period, from } = range, to = period === 'all' ? '9999-12-31' : range.to;
  const mine = await env.DB.prepare('SELECT SUM(tokens) AS t FROM ranked_usage WHERE user_id=?1 AND day>=?2 AND day<=?3').bind(user.id,from,to).first();
  const tokens = mine?.t || 0;
  const [global, groups] = await Promise.all([
    env.DB.prepare(`SELECT rank FROM (SELECT user_id,ROW_NUMBER() OVER(ORDER BY SUM(tokens) DESC,user_id) AS rank
      FROM public_usage WHERE day>=?1 AND day<=?2 GROUP BY user_id HAVING SUM(tokens)>0) WHERE user_id=?3`).bind(from,to,user.id).first(),
    env.DB.prepare(`WITH own AS (
      SELECT g.id,g.name,m.hidden AS my_hidden,(SELECT COUNT(*) FROM rank_group_members WHERE group_id=g.id) AS members
      FROM rank_groups g JOIN rank_group_members m ON m.group_id=g.id WHERE m.user_id=?1
    ), totals AS (
      SELECT m.group_id,d.user_id,SUM(d.tokens) AS tokens,MAX(d.updated_at) AS updated_at
      FROM public_usage d JOIN rank_group_members m ON m.user_id=d.user_id AND m.hidden=0
      WHERE d.day>=?2 AND d.day<=?3 AND m.group_id IN(SELECT id FROM own) GROUP BY m.group_id,d.user_id
    ) SELECT own.*,MAX(t.updated_at) AS updated_at,
      SUM(CASE WHEN t.tokens>?4 OR(t.tokens=?4 AND t.user_id<?1) THEN 1 ELSE 0 END) AS ahead
      FROM own LEFT JOIN totals t ON t.group_id=own.id GROUP BY own.id
      ORDER BY own.members DESC,updated_at DESC,own.id ASC LIMIT 50`).bind(user.id,from,to,tokens).all(),
  ]);
  const out = groups.results.map(g => ({ id:g.id,name:g.name,members:g.members,
    profile_required:!(sanitizeName(user.nickname) && user.avatar_path),
    my_rank:tokens>0 && !user.rank_hidden && !g.my_hidden ? g.ahead+1 : null, my_tokens:tokens,
    rank_hidden:!!user.rank_hidden,group_hidden:!!g.my_hidden,global_rank:global?.rank ?? null,updated_at:g.updated_at }));
  return { period,groups:out,global:{rank:global?.rank ?? null,tokens},updated_at:Math.max(0,...out.map(g=>g.updated_at || 0)) || null };
}
