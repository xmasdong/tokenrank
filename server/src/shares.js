import { jsonError } from './lib.js';
export const SHARE_ID = /^[0-9a-f]{24}$/;
const TTL = 90 * 86400000;
export async function readShare(env, id) {
  if (!SHARE_ID.test(id || '')) return null;
  const row = await env.DB.prepare('SELECT id, snapshot_json, created_at, expires_at FROM usage_shares WHERE id = ?1 AND expires_at > ?2 AND revoked_at IS NULL')
    .bind(id, Date.now()).first();
  return row ? { id: row.id, ...JSON.parse(row.snapshot_json), created_at: row.created_at, expires_at: row.expires_at } : null;
}
export async function createShare(env, user, usage, style = 'usage') {
  // Whitelist only what the card displays. No private daily history, IDs or credentials.
  const snapshot = {
    user: { nickname: user.nickname || `AI玩家-${String(user.user_id).slice(-4).padStart(4,'0')}`, avatar_url: user.avatar_url || null },
    usage: { period: usage.period, from: usage.from, to: usage.to, timezone: usage.timezone, token_basis: usage.token_basis,
      summary: { tokens: usage.summary.tokens, requests: usage.summary.requests, active_days: usage.summary.active_days },
      tools: usage.tools.filter(t => !t.unclassified).slice(0, 1), activity: usage.activity, standing: usage.standing },
  };
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
  if (previous) return Response.json(await readShare(env, previous.id));
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_shares WHERE user_id = ?1 AND created_at > ?2')
    .bind(user.user_id, Date.now() - 86400000).first();
  if (count.n >= 50) return jsonError(429, '今天生成的分享记录较多，请明天再试');
  const id = crypto.randomUUID().replaceAll('-','').slice(0,24), now = Date.now();
  await env.DB.prepare(`INSERT INTO usage_shares (id,user_id,fingerprint,snapshot_json,created_at,expires_at)
    VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(user_id,fingerprint) DO UPDATE SET
    id=excluded.id,snapshot_json=excluded.snapshot_json,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL
    WHERE usage_shares.expires_at <= excluded.created_at OR usage_shares.revoked_at IS NOT NULL`)
    .bind(id, user.user_id, fingerprint, json, now, now + TTL).run();
  const saved = await env.DB.prepare('SELECT id FROM usage_shares WHERE user_id=?1 AND fingerprint=?2').bind(user.user_id, fingerprint).first();
  return Response.json(await readShare(env, saved.id));
}
