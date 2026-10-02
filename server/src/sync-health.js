import { bearerToken, jsonError } from './lib.js';

export const STALE_AFTER_MS = 15 * 60_000;
const STATES = new Set(['starting', 'checking', 'idle', 'uploaded', 'error', 'stopped']);
const ERRORS = new Set(['SOURCE_READ_FAILED', 'COLLECTOR_OUTDATED', 'UPLOAD_FAILED', 'AUTH_INVALID',
  'ACCOUNT_DISABLED', 'SYNC_CONFLICT', 'UPGRADE_REQUIRED', 'RATE_LIMITED', 'CHECK_TIMEOUT', 'PROCESS_EXIT',
  'USER_DISABLED', 'USER_UNINSTALLED', 'SERVICE_STOPPED']);
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?$/;
const FIELDS = new Set(['v','device_id','client_version','collector_version','platform','state','error_code',
  'source_day','check_started_at','checked_at','event_at']);

async function readHeartbeat(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid heartbeat');
  let size = 0; const parts = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('heartbeat too large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(await new Blob(parts).text());
}

export async function heartbeat(request, env, now = Date.now()) {
  const token = bearerToken(request);
  if (!token) return jsonError(401, 'missing connect token');
  const conn = await env.DB.prepare(`SELECT c.user_id,u.disabled_at FROM connect_tokens c
    JOIN users u ON u.id=c.user_id WHERE c.token=?1`).bind(token).first();
  if (!conn) return jsonError(401, 'invalid connect token');
  if (conn.disabled_at) return jsonError(403, '账号已停用');
  let b;
  try { b = await readHeartbeat(request); } catch { return jsonError(400, 'invalid heartbeat'); }
  const time = value => value == null || (Number.isSafeInteger(value) && value>0 && value<=now+300000);
  if (!b || Object.keys(b).some(k=>!FIELDS.has(k)) || b.v!==1
    || typeof b.device_id!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.device_id) || typeof b.client_version!=='string' || b.client_version.length>64 || !VERSION.test(b.client_version)
    || (b.collector_version!=null && (typeof b.collector_version!=='string' || b.collector_version.length>64 || !VERSION.test(b.collector_version)))
    || !['darwin','win32','linux','other'].includes(b.platform) || !STATES.has(b.state)
    || (b.error_code!=null && !ERRORS.has(b.error_code))
    || ((b.state==='error' || b.state==='stopped') !== !!b.error_code)
    || (b.state==='stopped' && !['USER_DISABLED','USER_UNINSTALLED','SERVICE_STOPPED'].includes(b.error_code))
    || (b.state==='error' && ['USER_DISABLED','USER_UNINSTALLED','SERVICE_STOPPED'].includes(b.error_code))
    || !time(b.check_started_at) || !time(b.checked_at) || !time(b.event_at) || !b.event_at
    || (b.source_day!=null && (!/^\d{4}-\d{2}-\d{2}$/.test(b.source_day) || !Number.isFinite(Date.parse(b.source_day+'T00:00Z'))
      || new Date(b.source_day+'T00:00Z').toISOString().slice(0,10)!==b.source_day))) return jsonError(400, 'invalid heartbeat');
  // Re-check the credential inside the write. Deletion/rotation can race auth.
  const result = await env.DB.prepare(`INSERT INTO sync_agents
    (user_id,device_id,client_version,collector_version,platform,state,error_code,source_day,check_started_at,checked_at,event_at,last_seen_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12
    WHERE EXISTS(SELECT 1 FROM connect_tokens c JOIN users u ON u.id=c.user_id WHERE c.token=?13 AND c.user_id=?1 AND u.disabled_at IS NULL)
    ON CONFLICT(user_id,device_id) DO UPDATE SET client_version=excluded.client_version,
      collector_version=excluded.collector_version,platform=excluded.platform,state=excluded.state,error_code=excluded.error_code,
      source_day=excluded.source_day,check_started_at=excluded.check_started_at,checked_at=excluded.checked_at,
      event_at=excluded.event_at,last_seen_at=excluded.last_seen_at
    WHERE excluded.event_at>sync_agents.event_at OR
      (excluded.event_at=sync_agents.event_at AND (sync_agents.state!='stopped' OR excluded.state='stopped'))`)
    .bind(conn.user_id,b.device_id,b.client_version,b.collector_version??null,b.platform,b.state,b.error_code??null,
      b.source_day??null,b.check_started_at??null,b.checked_at??null,b.event_at,now,token).run();
  return Response.json({ ok:true, accepted:!!result.meta?.changes, server_time:now });
}

export function presentAgent(row, now = Date.now()) {
  const state = row.state==='stopped' ? 'stopped' : now-row.last_seen_at>STALE_AFTER_MS ? 'unreachable'
    : row.state==='error' ? 'error' : row.state==='checking' || row.state==='starting' ? 'checking' : 'online';
  return { device_id:row.device_id, platform:row.platform, state, result:row.state,
    client_version:row.client_version, collector_version:row.collector_version, error_code:row.error_code,
    last_seen_at:row.last_seen_at, last_check_at:row.checked_at, check_started_at:row.check_started_at, source_day:row.source_day };
}

export async function syncHealth(env, userId, now = Date.now()) {
  const { results } = await env.DB.prepare(`SELECT a.*,
    (SELECT device_id FROM usage_sync_state WHERE user_id=?1) AS ranked_device_id FROM sync_agents a WHERE user_id=?1
    ORDER BY CASE WHEN device_id=(SELECT device_id FROM usage_sync_state WHERE user_id=?1) THEN 0 ELSE 1 END,
      last_seen_at DESC LIMIT 20`).bind(userId).all();
  const agents = results.map(row=>presentAgent(row,now));
  const ranked = results[0]?.ranked_device_id;
  const primary = ranked ? agents.find(agent=>agent.device_id===ranked) : agents[0];
  return { ...(primary || { state:'unknown' }), supported:!!primary, agents };
}
