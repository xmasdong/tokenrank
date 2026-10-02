import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readConfig, writeConfig, SYNC_DIR, normalizeUrl, normalizeToken } from './config.js';
import { inspectUpstream } from './upstream.js';
export const CLIENT_VERSION = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export const INTERVAL_MS = 300_000;
export const CHECK_TIMEOUT_MS = 15 * 60_000;
const identity = c => createHash('sha256').update(JSON.stringify([c.server,c.token,c.device_id,c.db_path])).digest('hex');
export function readHealth(dir=SYNC_DIR, config=readConfig(dir)) {
  try { const saved=readConfig(join(dir,'health')); return saved.identity===identity(config)?saved.status:null; }
  catch { return null; }
}

export function sameConnection(a,b) {
  return !!a?.token && a.token===b?.token && a.server===b?.server && a.device_id===b?.device_id && a.db_path===b?.db_path;
}
export function canContact(config) {
  return !!(config?.token && config.server && config.device_id)
    && process.env.TOKENRANK_OFFLINE!=='1' && process.env.TOKENMETER_OFFLINE!=='1';
}
export function errorCode(error, stage = 'source') {
  const status = /HTTP (\d+)/.exec(String(error?.message || error || ''))?.[1];
  if (status) return ({401:'AUTH_INVALID',403:'ACCOUNT_DISABLED',409:'SYNC_CONFLICT',426:'UPGRADE_REQUIRED',429:'RATE_LIMITED'})[status] || 'UPLOAD_FAILED';
  return stage==='source' ? 'SOURCE_READ_FAILED' : 'UPLOAD_FAILED';
}

/** Only allowlisted metadata leaves the computer. Never upload raw errors/paths. */
export async function sendHeartbeat({ dir=SYNC_DIR, config=readConfig(dir), status, fetcher=fetch,
  detached=false, now=Date.now(), platform=process.platform } = {}) {
  try {
    if (!canContact(config) || (!detached && !sameConnection(config,readConfig(dir)))) return false;
    const payload = { v:1, device_id:config.device_id, client_version:CLIENT_VERSION,
      collector_version:inspectUpstream(config.upstream_entry)?.version || null,
      platform:['darwin','win32','linux'].includes(platform)?platform:'other',
      state:status.state, error_code:status.error_code || null, source_day:status.source_day || null,
      check_started_at:status.check_started_at || null, checked_at:status.checked_at || null, event_at:now };
    const res = await fetcher(normalizeUrl(config.server)+'/agent/heartbeat', { method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+normalizeToken(config.token)},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const ack = await res.json();
    if (ack.ok!==true || ack.accepted!==true) return false;
    const latest = readConfig(dir);
    // Separate from upload checkpoints: the worker and supervisor write concurrently.
    if (sameConnection(config,latest)) writeConfig({ identity:identity(config),status:{...payload,last_seen_at:ack.server_time} },join(dir,'health'));
    return true;
  } catch { return false; }
}

export async function notifyStopped(reason, { dir=SYNC_DIR, config=readConfig(dir), fetcher=fetch } = {}) {
  const previous=readHealth(dir,config);
  return sendHeartbeat({dir,config,fetcher,detached:true,status:{state:'stopped',error_code:reason,
    checked_at:previous?.checked_at,source_day:previous?.source_day}});
}
