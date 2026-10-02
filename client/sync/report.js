import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readConfig, writeConfig, SYNC_DIR, normalizeUrl, normalizeToken, rejectSharedDirectory } from './config.js';
import { readDays } from './source.js';
import { inspectUpstream, collectorOutdated, UPSTREAM_VERSION } from './upstream.js';
const CLIENT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url),'utf8')).version;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const MAX_DAYS = 400;
const MAX_BODY_BYTES = 450 * 1024;
const fingerprint = day => createHash('sha256').update(JSON.stringify(day)).digest('hex');

export function batches(days, deviceId, { sourceAt = Date.now(), full = false, metadata = {}, replaceId = null } = {}) {
  const reports = [];
  let part = [];
  const make = values => ({ v: 2, device_id: deviceId, client: 'tokenrank-sync', timezone: 'Asia/Shanghai',
    token_basis: 'upstream_total', source_at: sourceAt, full, complete: false, ...metadata, days: values });
  for (const day of days) {
    if (part.length && (part.length >= MAX_DAYS || Buffer.byteLength(JSON.stringify(make([...part, day]))) > MAX_BODY_BYTES - 1024)) {
      reports.push(make(part)); part = [];
    }
    part.push(day);
  }
  if (part.length) reports.push(make(part));
  if (!reports.length && replaceId) reports.push(make([]));
  if (replaceId) reports.forEach((report, index) => {
    report.replace = { id: replaceId, batch_index: index, batch_count: reports.length, total_days: days.length };
  });
  if (reports.length) reports.at(-1).complete = true;
  return reports;
}

export async function sync({ dir = SYNC_DIR, full = false, replace = false, dryRun = false, now = Date.now(), fetcher = fetch, wait = sleep, log = () => {}, onProgress = () => {} } = {}) {
  const config = readConfig(dir);
  if (!config.token || !config.server) return { skipped: 'not-connected' };
  if (process.env.TOKENRANK_OFFLINE === '1' || process.env.TOKENMETER_OFFLINE === '1') return { skipped: 'offline' };
  const server = normalizeUrl(config.server), token = normalizeToken(config.token);
  const dbPath = rejectSharedDirectory(config.db_path, dir);
  replace = replace || config.replace_pending === true;
  const metadata = { client_version: CLIENT_VERSION, collector_version: inspectUpstream(config.upstream_entry)?.version || null };
  if (!dryRun && collectorOutdated(metadata.collector_version)) {
    // Pre-fix collectors double count Codex/DSH usage; never publish those totals.
    const message = `统计内核 token-watcher ${metadata.collector_version} 低于 ${UPSTREAM_VERSION}，会重复计算用量；请运行小程序「说明」页的更新命令`;
    writeConfig({ ...readConfig(dir), last_error: message }, dir);
    log(message);
    return { skipped: 'collector-outdated', error: message };
  }
  const stateFileConfig = () => {
    const latest = readConfig(dir);
    if (latest.token !== token || latest.server !== server || latest.device_id !== config.device_id || latest.db_path !== config.db_path)
      throw new Error('接入配置已改变，本次同步已取消');
    return latest;
  };
  try {
    if (replace && !dryRun) {
      onProgress({stage:'upload',source_day:null});
      const capability = await fetcher(`${server}/report/capabilities`, { signal: AbortSignal.timeout(15000) });
      if (!capability.ok || (await capability.json()).atomic_replace !== 1) throw new Error('服务端尚未支持完整替换，旧云端用量保持不变');
    }
    // Read every retained day so upstream corrections to old history are detected.
    onProgress({stage:'source',source_day:null});
    const days = readDays(dbPath, { now });
    const sourceDay=days.at(-1)?.day || null;
    const initializing = config.protocol_version !== 2 || config.initial_sync_pending;
    const unchanged = config.protocol_version === 2 ? config.synced_days || {} : {};
    const present = new Set(days.map(day => day.day));
    for (const day of Object.keys(unchanged)) if (!replace && !present.has(day)) days.push({ day, tokens: 0, input_tokens: 0, output_tokens: 0,
      cache_read: 0, cache_write: 0, requests: 0, models: [], tools: [] });
    days.sort((a,b) => a.day.localeCompare(b.day));
    const changed = full || replace ? days : days.filter(day => unchanged[day.day] !== fingerprint(day));
    onProgress({stage:'upload',source_day:sourceDay});
    const reports = batches(changed, config.device_id, { sourceAt: now, full: !!(full || replace || initializing), metadata,
      replaceId: replace ? crypto.randomUUID().replaceAll('-','') : null });
    if (dryRun) return { dryRun: true, reports, total_days: days.length, changed_days: changed.length };
    if (replace) writeConfig({ ...stateFileConfig(), replace_pending: true },dir);
    let accepted = 0;
    for (let i = 0; i < reports.length; i++) {
      const part = reports[i];
      log(`同步第 ${i + 1}/${reports.length} 批（${part.days.length} 天）`);
      for (let attempt = 0; ; attempt++) {
        stateFileConfig();
        const response = await fetcher(`${server}/report`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(part), signal: AbortSignal.timeout(15000) });
        if (response.status === 429 && attempt < 3) {
          const seconds = Number(response.headers.get('retry-after'));
          await wait(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 + 100 : 20100);
          continue;
        }
        if (!response.ok) throw new Error(`同步失败（HTTP ${response.status}）${response.status === 401 ? '，请重新复制接入命令' : ''}`);
        const result = await response.json();
        if (result.ok !== true || result.accepted !== part.days.length) throw new Error('服务端未确认整批数据，保留待同步状态');
        if (replace && (typeof result.committed !== 'boolean' || (part.complete && !result.committed)))
          throw new Error('服务端尚未确认完整替换，保留重建回传状态');
        const latest = stateFileConfig();
        if (replace) {
          if (part.complete) writeConfig({ ...latest, protocol_version: 2, initial_sync_pending: false, replace_pending: false,
            synced_days: Object.fromEntries(days.map(day => [day.day,fingerprint(day)])), last_ok_at: now, last_error: null },dir);
          accepted += part.days.length;
          break;
        }
        const hashes = { ...unchanged, ...(latest.protocol_version === 2 ? latest.synced_days || {} : {}) };
        for (const day of part.days) hashes[day.day] = fingerprint(day);
        writeConfig({ ...latest, protocol_version: 2, initial_sync_pending: !!(initializing && !part.complete), synced_days: hashes,
          last_ok_at: part.complete ? now : latest.last_ok_at || null, last_error: null }, dir);
        accepted += part.days.length;
        break;
      }
    }
    return { ok: true, accepted, total_days: days.length, changed_days: changed.length, ...(replace ? { replaced: true } : {}) };
  } catch (err) {
    // No credentials, source paths, or raw server error bodies in status/logs.
    const message = String(err.message || '同步失败').replaceAll(token, '[hidden]').slice(0, 300);
    try { const latest = stateFileConfig(); writeConfig({ ...latest, last_error: message }, dir); } catch {}
    throw new Error(message);
  }
}
