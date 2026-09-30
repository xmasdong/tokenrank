import { jsonError } from './lib.js';
export const MIN_REBUILD_CLIENT = '0.2.6', MIN_REBUILD_COLLECTOR = '1.8.2';
export function versionAtLeast(value, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(value || '')) return false;
  const a = value.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
const TTL = 30 * 60 * 1000;

export async function storeReplacement(env, conn, body, now) {
  const r = body.replace;
  if (!r || !/^[a-f0-9]{32}$/.test(r.id || '') || !Number.isInteger(r.batch_index) || !Number.isInteger(r.batch_count)
    || r.batch_count < 1 || r.batch_count > 1000 || r.batch_index < 0 || r.batch_index >= r.batch_count
    || !Number.isInteger(r.total_days) || r.total_days < 0 || r.total_days > 10000
    || body.full !== true || body.complete !== (r.batch_index === r.batch_count - 1)
    || (r.total_days === 0 && (r.batch_count !== 1 || body.days.length !== 0))
    || (r.total_days > 0 && !body.days.length)) return jsonError(400, 'invalid replacement');
  if (!versionAtLeast(body.client_version, MIN_REBUILD_CLIENT) || !versionAtLeast(body.collector_version, MIN_REBUILD_COLLECTOR))
    return jsonError(426, '请先用最新更新命令升级统计内核与同步器，再重建回传');
  const uid = conn.user_id, id = r.id;
  const prepare = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const guard = await prepare('SELECT * FROM usage_rebuild_guard WHERE user_id=?1',uid).first();
  if (guard && (!versionAtLeast(body.client_version,guard.client_version) || !versionAtLeast(body.collector_version,guard.collector_version)))
    return jsonError(426,'该账号已有更新版本的重建结果，请先升级后重试');
  const getJob = () => prepare('SELECT * FROM usage_replacements WHERE user_id=?1', uid).first();
  if (r.batch_index === 0) {
    await prepare(`INSERT INTO usage_replacements
      (user_id,id,device_id,source_at,total_days,batch_count,client_version,collector_version,status,expires_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'collecting',?9
      WHERE NOT EXISTS(SELECT 1 FROM usage_sync_state WHERE user_id=?1 AND source_at>?4)
        AND COALESCE((SELECT source_at FROM usage_rebuild_guard WHERE user_id=?1),0)=?11
      ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,device_id=excluded.device_id,source_at=excluded.source_at,
      total_days=excluded.total_days,batch_count=excluded.batch_count,client_version=excluded.client_version,
      collector_version=excluded.collector_version,status='collecting',expires_at=excluded.expires_at
      WHERE usage_replacements.id<>excluded.id AND (usage_replacements.expires_at<=?10 OR usage_replacements.status='complete' OR usage_replacements.device_id=excluded.device_id)
        AND excluded.source_at>usage_replacements.source_at`,
    uid,id,body.device_id,body.source_at,r.total_days,r.batch_count,body.client_version,body.collector_version,now+TTL,now,guard?.source_at || 0).run();
  }
  const job = await getJob();
  if (!job || job.id !== id || job.expires_at <= now) return jsonError(409, '另一项重建正在进行，或本次任务已过期；稍后重试同一更新命令');
  if (job.device_id !== body.device_id || job.source_at !== body.source_at || job.total_days !== r.total_days
    || job.batch_count !== r.batch_count || job.client_version !== body.client_version || job.collector_version !== body.collector_version)
    return jsonError(409, '重建批次信息不一致');
  const days = JSON.stringify(body.days);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(days)))].map(n => n.toString(16).padStart(2,'0')).join('');
  const own = "EXISTS(SELECT 1 FROM usage_replacements WHERE user_id=?1 AND id=?2 AND status='collecting' AND expires_at>?3)";
  await env.DB.batch([
    prepare(`DELETE FROM usage_replacement_chunks WHERE user_id=?1 AND replacement_id<>?2 AND ${own}`,uid,id,now),
    prepare(`INSERT INTO usage_replacement_chunks(user_id,replacement_id,batch_index,digest,days_json)
      SELECT ?1,?2,?4,?5,?6 WHERE ${own} ON CONFLICT(user_id,replacement_id,batch_index) DO NOTHING`,uid,id,now,r.batch_index,digest,days),
    prepare(`UPDATE usage_replacements SET expires_at=?4 WHERE user_id=?1 AND id=?2 AND ${own}`,uid,id,now,now+TTL),
  ]);
  const saved = await prepare('SELECT digest FROM usage_replacement_chunks WHERE user_id=?1 AND replacement_id=?2 AND batch_index=?3',uid,id,r.batch_index).first();
  if (saved?.digest !== digest) return jsonError(409, '重建批次内容发生变化，请重新运行更新命令');
  if (job.status === 'complete') return Response.json({ok:true,accepted:body.days.length,committed:true});
  if (!body.complete) return Response.json({ok:true,accepted:body.days.length,committed:false});
  const counts = await prepare(`SELECT COUNT(*) AS batches,SUM(json_array_length(days_json)) AS days,
    (SELECT COUNT(DISTINCT json_extract(d.value,'$.day')) FROM usage_replacement_chunks c,json_each(c.days_json) d
      WHERE c.user_id=?1 AND c.replacement_id=?2) AS distinct_days
    FROM usage_replacement_chunks WHERE user_id=?1 AND replacement_id=?2`,uid,id).first();
  if (counts.batches !== r.batch_count || counts.days !== r.total_days || counts.distinct_days !== r.total_days)
    return jsonError(409, '重建数据尚未完整，或日期重复；云端旧用量未清除');
  const committing = "EXISTS(SELECT 1 FROM usage_replacements WHERE user_id=?1 AND id=?2 AND status='committing')";
  // D1 batch is one transaction. All deletes and inserts share a guarded commit marker.
  await env.DB.batch([
    prepare(`UPDATE usage_replacements SET status='committing' WHERE user_id=?1 AND id=?2 AND status='collecting' AND expires_at>?3
      AND NOT EXISTS(SELECT 1 FROM usage_sync_state WHERE user_id=?1 AND source_at>?4)
      AND COALESCE((SELECT source_at FROM usage_rebuild_guard WHERE user_id=?1),0)=?5`,uid,id,now,body.source_at,guard?.source_at || 0),
    prepare(`DELETE FROM daily_totals WHERE user_id=?1 AND ${committing}`,uid,id),
    prepare(`DELETE FROM daily_stats WHERE user_id=?1 AND ${committing}`,uid,id),
    prepare(`INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at)
      SELECT ?1,?3,json_extract(d.value,'$.day'),json_extract(d.value,'$.tokens'),json_extract(d.value,'$.input_tokens'),
      json_extract(d.value,'$.output_tokens'),json_extract(d.value,'$.cache_read'),json_extract(d.value,'$.cache_write'),
      json_extract(d.value,'$.requests'),json_extract(d.value,'$.models'),json_extract(d.value,'$.tools'),?4,?5
      FROM usage_replacement_chunks c,json_each(c.days_json) d WHERE c.user_id=?1 AND c.replacement_id=?2 AND ${committing}`,
    uid,id,body.device_id,body.source_at,now),
    prepare(`INSERT INTO usage_sync_state(user_id,device_id,source_at,updated_at) SELECT ?1,?3,?4,?5 WHERE ${committing}
      ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id,source_at=excluded.source_at,updated_at=excluded.updated_at`,uid,id,body.device_id,body.source_at,now),
    prepare(`INSERT INTO usage_rebuild_guard(user_id,client_version,collector_version,source_at) SELECT ?1,?3,?4,?5 WHERE ${committing}
      ON CONFLICT(user_id) DO UPDATE SET client_version=excluded.client_version,collector_version=excluded.collector_version,source_at=excluded.source_at`,
    uid,id,body.client_version,body.collector_version,body.source_at),
    prepare(`UPDATE connect_tokens SET last_report_at=?3,device_id=?4 WHERE user_id=?1 AND token=?5 AND ${committing}`,uid,id,now,body.device_id,conn.token),
    prepare(`UPDATE usage_replacements SET status='complete' WHERE user_id=?1 AND id=?2 AND status='committing'`,uid,id),
  ]);
  const committed = await getJob();
  if (committed?.id !== id || committed.status !== 'complete') return jsonError(409, '已有更新的数据，本次未替换，请重新运行更新命令');
  return Response.json({ok:true,accepted:body.days.length,committed:true});
}
