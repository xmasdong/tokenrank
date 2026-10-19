import { jsonError } from './lib.js';
export const SHARE_ID = /^[0-9a-f]{24}$/;
const TTL = 90 * 86400000;
export async function readShare(env, id, allowComparison = true) {
  if (!SHARE_ID.test(id || '')) return null;
  const row = await env.DB.prepare('SELECT id, snapshot_json, created_at, expires_at FROM usage_shares WHERE id = ?1 AND expires_at > ?2 AND revoked_at IS NULL')
    .bind(id, Date.now()).first();
  if (!row) return null;
  const record = { id: row.id, ...JSON.parse(row.snapshot_json), created_at: row.created_at, expires_at: row.expires_at };
  if (record.style === 'comparison') {
    if (!allowComparison) return null;
    const source = await readShare(env, record.comparison?.source_id, false);
    if (!source) return null;
    // Keep only a reference at rest: revocation, expiry and account deletion of
    // the original immediately invalidate every comparison that depends on it.
    record.comparison = { source_id: source.id, source: { user: source.user, usage: {
      period: source.usage.period, from: source.usage.from, to: source.usage.to,
      timezone: source.usage.timezone, token_basis: source.usage.token_basis,
      summary: source.usage.summary, tools: source.usage.tools,
    }, created_at: source.created_at } };
  }
  return record;
}

export function shareTools(usage) {
  const named = usage.tools.filter(t => !t.unclassified && t.tokens > 0);
  const first = named.slice(0, 4);
  const denominator = Math.max(usage.summary.tokens, usage.tools.reduce((n, t) => n + t.tokens, 0));
  const other = Math.max(0, denominator - first.reduce((n, t) => n + t.tokens, 0));
  return [...first.map(t => ({ name: t.name, tokens: t.tokens,
    percent: denominator ? Math.round(t.tokens / denominator * 1000) / 10 : 0 })),
    ...(other ? [{ name: named.length > first.length ? '其他工具 / 未分类' : '其他 / 未分类', tokens: other,
      percent: Math.round(other / denominator * 1000) / 10, unclassified: true }] : [])];
}
export async function groupShareStanding(env, user, usage, groupId) {
  const group = await env.DB.prepare(`SELECT g.name, m.hidden,
    (SELECT COUNT(*) FROM rank_group_members WHERE group_id=g.id) AS members
    FROM rank_groups g JOIN rank_group_members m ON m.group_id=g.id AND m.user_id=?2
    WHERE g.id=?1`).bind(groupId, user.id).first();
  if (!group) return jsonError(403, '请先加入这个群榜');
  const rows = await env.DB.prepare(`SELECT user_id AS uid, SUM(tokens) AS tokens FROM public_usage
    WHERE day>=?1 AND day<=?2 AND user_id IN
      (SELECT user_id FROM rank_group_members WHERE group_id=?3 AND hidden=0)
    GROUP BY user_id HAVING tokens>0 ORDER BY tokens DESC, uid ASC`)
    .bind(usage.period === 'all' ? '0000-01-01' : usage.from, usage.to, groupId).all();
  const hidden = !!(user.rank_hidden || group.hidden);
  const index = rows.results.findIndex(row => row.uid === user.id);
  if (!hidden && usage.summary.tokens > 0 && (index < 0 || rows.results[index].tokens !== usage.summary.tokens))
    return jsonError(409, '榜单已有更新，请重新分享');
  return { name: group.name, rank: !hidden && index >= 0 ? index + 1 : null,
    participants: rows.results.length, members: group.members, hidden };
}
export async function createShare(env, user, usage, style = 'usage', source = null) {
  // Whitelist only what the card displays. No private daily history, IDs or credentials.
  const snapshot = {
    user: { nickname: user.nickname || `AI玩家-${String(user.user_id).slice(-4).padStart(4,'0')}`, avatar_url: user.avatar_url || null },
    usage: { period: usage.period, from: usage.from, to: usage.to, timezone: usage.timezone, token_basis: usage.token_basis,
      summary: { tokens: usage.summary.tokens, requests: usage.summary.requests, active_days: usage.summary.active_days },
      tools: style === 'tools' ? shareTools(usage) : usage.tools.filter(t => !t.unclassified).slice(0, 1), activity: usage.activity, standing: usage.standing },
  };
  if (style === 'tools') snapshot.style = 'tools';
  if (style === 'daily') {
    snapshot.style = 'daily';
    snapshot.usage.report_day = usage.day;
    snapshot.usage.models = usage.models.filter(item => !item.unclassified).slice(0,1);
    for (const key of ['input_tokens','output_tokens','cache_read','cache_write']) snapshot.usage.summary[key] = usage.summary[key];
  }
  if (style === 'weekly') {
    snapshot.style = 'weekly';
    const week = usage.weekly;
    snapshot.usage.weekly = Object.fromEntries(['week_start', 'week_end', 'complete', 'reported_days', 'previous_from', 'previous_to',
      'previous_reported_days', 'previous_tokens', 'comparison_status', 'change_tokens', 'change_percent', 'peak', 'top_model'].map(key => [key, week[key]]));
  }
  if (style === 'comparison') {
    if (!source || source.style === 'comparison') return jsonError(400, '对比来源无效');
    snapshot.style = 'comparison';
    snapshot.comparison = { source_id: source.id };
  }
  if (usage.group_standing) {
    const group = usage.group_standing;
    snapshot.usage.group_standing = { name: group.name, rank: group.rank, participants: group.participants,
      members: group.members, hidden: group.hidden };
  }
  if (style === 'receipt') {
    snapshot.style = 'receipt';
    for (const key of ['input_tokens','output_tokens','cache_read','cache_write']) snapshot.usage.summary[key] = usage.summary[key];
    const cost = usage.cost;
    snapshot.usage.cost = { basis: cost.basis, currency: cost.currency, status: cost.status, usd_micros: cost.usd_micros,
      models: cost.models.slice(0, 5), other_usd_micros: cost.models.slice(5).reduce((s,m) => s + m.usd_micros, 0),
      other_model_count: Math.max(0, cost.models.length - 5), model_count: new Set([...cost.models.map(m=>m.name), ...cost.unpriced_models]).size,
      unpriced_count: cost.unpriced_models.length, missing_days: cost.missing_days };
  }
  const json = JSON.stringify(snapshot);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const fingerprint = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('');
  const previous = await env.DB.prepare('SELECT id FROM usage_shares WHERE user_id = ?1 AND fingerprint = ?2 AND expires_at > ?3 AND revoked_at IS NULL')
    .bind(user.user_id, fingerprint, Date.now()).first();
  if (previous) {
    const record = await readShare(env, previous.id);
    return record ? Response.json(record) : jsonError(404, '分享记录已失效，请重新打开卡片');
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_shares WHERE user_id = ?1 AND created_at > ?2')
    .bind(user.user_id, Date.now() - 86400000).first();
  if (count.n >= 50) return jsonError(429, '今天生成的分享记录较多，请明天再试');
  const id = crypto.randomUUID().replaceAll('-','').slice(0,24), now = Date.now();
  const expiresAt = source ? Math.min(now + TTL, source.expires_at) : now + TTL;
  await env.DB.prepare(`INSERT INTO usage_shares (id,user_id,fingerprint,snapshot_json,created_at,expires_at)
    VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(user_id,fingerprint) DO UPDATE SET
    id=excluded.id,snapshot_json=excluded.snapshot_json,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL
    WHERE usage_shares.expires_at <= excluded.created_at OR usage_shares.revoked_at IS NOT NULL`)
    .bind(id, user.user_id, fingerprint, json, now, expiresAt).run();
  const saved = await env.DB.prepare('SELECT id FROM usage_shares WHERE user_id=?1 AND fingerprint=?2').bind(user.user_id, fingerprint).first();
  const record = await readShare(env, saved.id);
  return record ? Response.json(record) : jsonError(404, '分享记录已失效，请重新打开卡片');
}
