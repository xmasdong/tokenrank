import { jsonError } from './lib.js';
import { storeReplacement, versionAtLeast } from './replacement.js';

const fields = ['tokens', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'requests'];
export function validateTotalReport(body, now = Date.now()) {
  if (body?.v !== 2 || body.timezone !== 'Asia/Shanghai' || body.token_basis !== 'upstream_total') throw new Error('请升级同步器以同步原版总用量');
  if (typeof body.device_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.device_id)) throw new Error('invalid device');
  if (!Number.isSafeInteger(body.source_at) || body.source_at <= 0 || body.source_at > now + 300000) throw new Error('请检查电脑时间后重试同步');
  if (typeof body.full !== 'boolean' || typeof body.complete !== 'boolean' || !Array.isArray(body.days) || (!body.days.length && !body.replace) || body.days.length > 400) throw new Error('invalid report');
  const seen = new Set(), today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  for (const d of body.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d?.day || '') || !Number.isFinite(Date.parse(d.day + 'T00:00:00Z'))
      || new Date(d.day + 'T00:00:00Z').toISOString().slice(0, 10) !== d.day || d.day > today || seen.has(d.day)) throw new Error('invalid day');
    seen.add(d.day);
    for (const field of fields) if (!Number.isSafeInteger(d[field]) || d[field] < 0 || d[field] > (field === 'requests' ? 1e7 : 1e13)) throw new Error('invalid count');
    for (const field of ['models', 'tools']) {
      if (!Array.isArray(d[field]) || d[field].length > 8) throw new Error('invalid details');
      let total = 0; const names = new Set();
      for (const pair of d[field]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0] || pair[0].length > 60 || names.has(pair[0])
          || !Number.isSafeInteger(pair[1]) || pair[1] < 0 || pair[1] > d.tokens) throw new Error('invalid details');
        names.add(pair[0]); total += pair[1];
      }
      if (total > d.tokens) throw new Error('invalid detail total');
    }
  }
  return body;
}

export async function storeTotalReport(env, conn, body, now = Date.now()) {
  try { validateTotalReport(body, now); } catch (err) { return jsonError(body?.v === 1 ? 426 : 400, err.message); }
  if (body.replace) return storeReplacement(env, conn, body, now);
  const guard = await env.DB.prepare('SELECT * FROM usage_rebuild_guard WHERE user_id=?1').bind(conn.user_id).first();
  if (guard && (!versionAtLeast(body.client_version,guard.client_version) || !versionAtLeast(body.collector_version,guard.collector_version)))
    return jsonError(426, '此账号已重建，请升级本机统计内核和同步脚本后再上传');
  const pending = await env.DB.prepare("SELECT 1 AS active FROM usage_replacements WHERE user_id=?1 AND status='collecting' AND expires_at>?2").bind(conn.user_id,now).first();
  if (pending) return jsonError(409, '此账号正在完整重建，请等待完成');
  const state = await env.DB.prepare('SELECT device_id, source_at FROM usage_sync_state WHERE user_id=?1').bind(conn.user_id).first();
  if ((!state || state.device_id !== body.device_id) && !body.full) return jsonError(409, '请执行 tokenrank rank push --full 完整同步此电脑');
  if (state && body.source_at < state.source_at) return jsonError(409, '此批数据早于已同步记录，请重新同步');
  const stmts = body.days.map(d => env.DB.prepare(`INSERT INTO daily_totals
    (user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13
    WHERE COALESCE((SELECT source_at FROM usage_rebuild_guard WHERE user_id=?1),0)=?14
      AND NOT EXISTS(SELECT 1 FROM usage_replacements WHERE user_id=?1 AND status='collecting' AND expires_at>?13)
    ON CONFLICT(user_id,device_id,day) DO UPDATE SET tokens=excluded.tokens,input_tokens=excluded.input_tokens,
    output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,cache_write=excluded.cache_write,requests=excluded.requests,
    models_json=excluded.models_json,tools_json=excluded.tools_json,source_at=excluded.source_at,updated_at=excluded.updated_at
    WHERE excluded.source_at >= daily_totals.source_at`)
    .bind(conn.user_id,body.device_id,d.day,d.tokens,d.input_tokens,d.output_tokens,d.cache_read,d.cache_write,d.requests,
      JSON.stringify(d.models),JSON.stringify(d.tools),body.source_at,now,guard?.source_at || 0));
  if (body.complete) stmts.push(env.DB.prepare(`INSERT INTO usage_sync_state (user_id,device_id,source_at,updated_at)
    SELECT ?1,?2,?3,?4 WHERE COALESCE((SELECT source_at FROM usage_rebuild_guard WHERE user_id=?1),0)=?5
      AND NOT EXISTS(SELECT 1 FROM usage_replacements WHERE user_id=?1 AND status='collecting' AND expires_at>?4)
    ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id,source_at=excluded.source_at,updated_at=excluded.updated_at
    WHERE excluded.source_at >= usage_sync_state.source_at`).bind(conn.user_id,body.device_id,body.source_at,now,guard?.source_at || 0));
  stmts.push(env.DB.prepare(`UPDATE connect_tokens SET last_report_at=?1,device_id=?2 WHERE token=?3
    AND COALESCE((SELECT source_at FROM usage_rebuild_guard WHERE user_id=?4),0)=?5
    AND NOT EXISTS(SELECT 1 FROM usage_replacements WHERE user_id=?4 AND status='collecting' AND expires_at>?1)`)
    .bind(now,body.device_id,conn.token,conn.user_id,guard?.source_at || 0));
  const result = await env.DB.batch(stmts);
  if (!result.at(-1)?.meta?.changes) return jsonError(409,'重建状态已变化，请等待重建完成后重新同步');
  return Response.json({ok:true,accepted:body.days.length});
}
