import { beijingDay, jsonError } from './lib.js';
import { usageWindow, buildUsage } from './usage.js';

export async function rankSnapshot(group, period, today, rows) {
  const value = group ? [group.id, group.name, group.members, period, today, rows] : ['global', period, today, rows];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

// A group PK is a read-only view. It never creates a public share on behalf of
// the selected member, nor exposes an account ID or their daily history.
export async function groupPk(env, user, groupId, body, origin, now = Date.now()) {
  const { period, rank, snapshot } = body || {};
  if (!['day', 'week', 'month', 'all'].includes(period) || !Number.isSafeInteger(rank) || rank < 1 || rank > 1e9 ||
    typeof snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot)) return jsonError(400, 'PK 参数无效，请重新从群榜选择');
  const range = usageWindow(period, now), to = period === 'all' ? '9999-12-31' : range.to;
  const ranked = `SELECT u.id AS uid, u.nickname, u.avatar_path,
    SUM(ds.tokens) AS tokens, SUM(ds.requests) AS requests, SUM(ds.cache_read + ds.cache_write) AS cache
    FROM public_usage ds JOIN users u ON u.id=ds.user_id
    WHERE ds.day>=?1 AND ds.day<=?2 AND ds.user_id IN
      (SELECT user_id FROM rank_group_members WHERE group_id=?3 AND hidden=0)
    GROUP BY ds.user_id HAVING tokens>0 ORDER BY tokens DESC, uid ASC`;
  const fields = 'day,tokens,input_tokens,output_tokens,requests,cache_read,cache_write,models_json,tools_json,updated_at,cost_json';
  const [groups, rankedRows, peerRows, ownRows] = await env.DB.batch([
    env.DB.prepare(`SELECT g.id,g.name,(SELECT COUNT(*) FROM rank_group_members WHERE group_id=g.id) AS members,
      EXISTS(SELECT 1 FROM rank_group_members WHERE group_id=g.id AND user_id=?2) AS joined
      FROM rank_groups g WHERE g.id=?1`).bind(groupId, user.id),
    env.DB.prepare(ranked).bind(range.from, to, groupId),
    env.DB.prepare(`SELECT ${fields} FROM public_usage WHERE user_id=(SELECT uid FROM (${ranked} LIMIT 1 OFFSET ?4))
      AND day>=?1 AND day<=?2 ORDER BY day`).bind(range.from, to, groupId, rank - 1),
    env.DB.prepare(`SELECT ${fields} FROM ranked_usage WHERE user_id=?3 AND day>=?1 AND day<=?2 ORDER BY day`)
      .bind(range.from, to, user.id),
  ]);
  const group = groups.results[0];
  if (!group) return jsonError(404, '群不存在或已解散');
  if (!group.joined) return jsonError(403, '请先加入这个群榜');
  const rows = rankedRows.results;
  if (snapshot !== await rankSnapshot(group, period, beijingDay(now), rows))
    return Response.json({ error: '榜单已有更新，请返回群榜重新选择', code: 'BOARD_CHANGED' }, { status: 409 });
  const peer = rows[rank - 1];
  if (!peer) return jsonError(404, '这位成员暂未上榜，请重新选择');
  if (peer.uid === user.id) return Response.json({ error: '这是你自己的用量记录', code: 'SELF_COMPARISON' }, { status: 409 });
  if (!ownRows.results.some(row => row.day <= range.to)) return Response.json({ error: '这段日期还没有同步记录',
    code: 'NO_PERIOD_USAGE', from: range.from, to: range.to }, { status: 422 });
  const left = buildUsage(peerRows.results, period, now), right = buildUsage(ownRows.results, period, now);
  const from = period === 'all' ? [left.from, right.from].sort()[0] : range.from;
  const publicUsage = usage => ({ period, from, to: range.to, timezone: 'Asia/Shanghai', token_basis: 'upstream_total',
    summary: { tokens: usage.summary.tokens, requests: usage.summary.requests, active_days: usage.summary.active_days },
    tools: usage.tools.filter(tool => !tool.unclassified).slice(0, 1) });
  const profile = (uid, nickname, avatar) => ({ nickname: nickname || `AI玩家-${String(uid).slice(-4).padStart(4, '0')}`,
    avatar_url: avatar ? origin + '/avatars/' + avatar : null });
  return Response.json({ style: 'comparison', transient: true, created_at: now,
    user: profile(user.id, user.nickname, user.avatar_path), usage: publicUsage(right),
    comparison: { source: { user: profile(peer.uid, peer.nickname, peer.avatar_path), usage: publicUsage(left), created_at: now } } });
}
