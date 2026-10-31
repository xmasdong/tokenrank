import { beijingDay, jsonError } from './lib.js';
export const ACHIEVEMENT_VERSION = 1;
export function uploadDayStatement(env,userId,deviceId,sourceAt,now,guardSource) {
  return env.DB.prepare(`INSERT INTO achievement_upload_days(user_id,day,first_report_at)
    SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)
    AND EXISTS(SELECT 1 FROM usage_sync_state WHERE user_id=?1 AND device_id=?4 AND source_at=?5)
    AND COALESCE((SELECT source_at FROM usage_rebuild_guard WHERE user_id=?1),0)=?6
    AND NOT EXISTS(SELECT 1 FROM usage_replacements WHERE user_id=?1 AND status='collecting' AND expires_at>?3)
    ON CONFLICT(user_id,day) DO NOTHING`).bind(userId,beijingDay(now),now,deviceId,sourceAt,guardSource);
}
const DAY = 86400000;
const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && Number.isFinite(Date.parse(day+'T00:00:00Z')) && new Date(day+'T00:00:00Z').toISOString().slice(0,10) === day;
const number = n => Number.isSafeInteger(Number(n)) && Number(n) >= 0 ? Number(n) : 0;
const families = [
  ['connect','首次同步','terminal','编码','已完成同步','次',[1]],
  ['requests','累计调用','code-leaves','编码','累计调用','次',[100,1000,10000,100000]],
  ['models','模型使用','neural-core','AI','已记录模型','个',[1,3,5,10]],
  ['tools','工具使用','linked-loops','AI','已记录工具','个',[2,3,5,8]],
  ['active','连续活跃','steady-flame','坚持','最长连续活跃','天',[3,7,30,100]],
  ['uploads','连续上传','upload-calendar','坚持','最长连续上传','天',[3,7,30,100]],
  ['peak','单日用量','milestone-peaks','用量','历史单日最高','Tokens',[1e8,5e8,1e9,5e9]],
  ['total','累计用量','usage-orbit','用量','累计含缓存总量','Tokens',[1e8,1e9,1e10,1e11]],
  ['build','项目构建','build-modules','产出','待接入产出数据','',[]],
  ['release','发布交付','release-plane','产出','待接入发布数据','',[]],
  ['adoption','成果采用','value-bridge','价值','待接入使用反馈','',[]],
  ['impact','成果影响','impact-beacon','价值','待定义影响指标','',[]],
].map(([id,label,art,group,metric_label,unit,thresholds],order)=>({id,label,art,group,metric_label,unit,thresholds,order}));
function names(json) {
  let pairs; try { pairs=JSON.parse(json || '[]'); } catch { return []; }
  if(!Array.isArray(pairs)) return [];
  return pairs.filter(p=>Array.isArray(p) && typeof p[0]==='string' && p[0].trim() && number(p[1])>0 &&
    !/^(其他|未分类|unknown|other|unclassified|其他\s*\/\s*未分类)$/i.test(p[0].trim())).map(p=>p[0].trim());
}
function streak(days, thresholds) {
  let previous=null,run=0,max=0; const dates=new Map();
  for(const day of [...new Set(days)].sort()) {
    const ms=Date.parse(day+'T00:00:00Z');run=previous!==null && ms-previous===DAY ? run+1:1;previous=ms;max=Math.max(max,run);
    for(const n of thresholds) if(run>=n && !dates.has(n)) dates.set(n,day);
  }
  return {value:max,dates};
}
/** These are real current-source rows. Cache columns must never be added to total_tokens again. */
export function buildAchievements(rows=[],uploads=[],receipts=[],source=null,now=Date.now()) {
  const today=beijingDay(now),byDay=new Map();
  for(const row of rows) if(validDay(row.day) && row.day<=today) {
    const old=byDay.get(row.day);
    if(!old || number(row.source_at)>=number(old.source_at)) byDay.set(row.day,row);
  }
  const ordered=[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day));
  const validUploads=uploads.filter(r=>validDay(r.day)&&r.day<=today).sort((a,b)=>a.day.localeCompare(b.day));
  const metrics=new Map(),dates=new Map();
  const record=(family,value,day)=>{metrics.set(family,value);for(const n of families.find(f=>f.id===family).thresholds) if(value>=n && !dates.has(family+':'+n)) dates.set(family+':'+n,day);};
  let total=0,requests=0,peak=0;const models=new Set(),tools=new Set();
  for(const row of ordered) {
    total+=number(row.tokens);requests+=number(row.requests);peak=Math.max(peak,number(row.tokens));
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(requests)) throw new Error('用量数据超出安全范围');
    names(row.models_json).forEach(name=>models.add(name));names(row.tools_json).forEach(name=>tools.add(name));
    record('total',total,row.day);record('requests',requests,row.day);record('peak',peak,row.day);record('models',models.size,row.day);record('tools',tools.size,row.day);
  }
  for(const [id,days] of [['active',ordered.filter(r=>number(r.tokens)>0||number(r.requests)>0).map(r=>r.day)],['uploads',validUploads.map(r=>r.day)]]) {
    const result=streak(days,families.find(f=>f.id===id).thresholds);metrics.set(id,result.value);for(const [n,day] of result.dates) dates.set(id+':'+n,day);
  }
  const seen=new Map(receipts.map(r=>[r.badge_id,r]));
  const ready=!!source?.device_id && !source.disabled_at;
  metrics.set('connect',ready?1:0);
  if(ready)dates.set('connect:1',seen.get('connect:1')?.achieved_day || validUploads[0]?.day || today);
  const result=families.map(f=>{
    const current=ready?(metrics.get(f.id)||0):0;
    return {...f,enabled:!!f.thresholds.length,current,
      badges:f.thresholds.map((threshold,tier)=>{
        const id=f.id+':'+threshold,earned=ready&&current>=threshold;
        return {id,family:f.id,label:f.label,art:f.art,threshold,unit:f.unit,metric_label:f.metric_label,current,
          tier:tier+1,priority:tier*100+f.order,earned,achieved_day:earned?(dates.get(id)||today):null,seen:seen.has(id),rule_version:ACHIEVEMENT_VERSION};
      })};
  });
  const all=result.flatMap(f=>f.badges),pending=all.filter(b=>b.earned&&!b.seen).sort((a,b)=>b.priority-a.priority);
  return {rule_version:ACHIEVEMENT_VERSION,timezone:'Asia/Shanghai',token_basis:'upstream_total',as_of:today,
    has_source:ready,earned_count:all.filter(b=>b.earned).length,pending:pending.map(b=>b.id),families:result};
}
export async function loadAchievements(env,userId,now=Date.now()) {
  const today=beijingDay(now),bind=sql=>env.DB.prepare(sql).bind(userId,today);
  const [rows,uploads,seen,source]=await Promise.all([
    bind('SELECT day,tokens,requests,models_json,tools_json,source_at,updated_at FROM ranked_usage WHERE user_id=?1 AND day<=?2 ORDER BY day').all(),
    bind('SELECT day,first_report_at FROM achievement_upload_days WHERE user_id=?1 AND day<=?2 ORDER BY day').all(),
    env.DB.prepare('SELECT badge_id,achieved_day FROM achievement_displays WHERE user_id=?1 AND rule_version=?2').bind(userId,ACHIEVEMENT_VERSION).all(),
    env.DB.prepare('SELECT u.disabled_at,s.device_id,s.source_at FROM users u LEFT JOIN usage_sync_state s ON s.user_id=u.id WHERE u.id=?1').bind(userId).first(),
  ]);
  const data=buildAchievements(rows.results,uploads.results,seen.results,source,now);
  const revision={device:source?.device_id||'',source:number(source?.source_at),count:rows.results.length,
    updated:Math.max(0,...rows.results.map(r=>number(r.updated_at))),row_source:Math.max(0,...rows.results.map(r=>number(r.source_at))),
    tokens:rows.results.reduce((n,r)=>n+number(r.tokens),0),requests:rows.results.reduce((n,r)=>n+number(r.requests),0),
    uploads:uploads.results.length,upload_at:Math.max(0,...uploads.results.map(r=>number(r.first_report_at)))};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([revision,rows.results,uploads.results])));
  data.snapshot=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
  return {data,revision};
}
/** One atomic INSERT claims every unseen, still-eligible badge. Concurrent phones cannot split/replay the popup. */
export async function claimAchievements(env,userId,now=Date.now()) {
  const {data,revision:r}=await loadAchievements(env,userId,now);
  const pending=data.families.flatMap(f=>f.badges).filter(b=>data.pending.includes(b.id));
  if(!pending.length)return Response.json({badge:null,count:0,claimed_ids:[]});
  const claimId=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO achievement_displays(user_id,badge_id,rule_version,shown_at,achieved_day,claim_id)
    SELECT ?1,json_extract(j.value,'$.id'),?3,?4,json_extract(j.value,'$.day'),?5 FROM json_each(?2) j
    WHERE EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)
    AND EXISTS(SELECT 1 FROM usage_sync_state WHERE user_id=?1 AND device_id=?6 AND source_at=?7)
    AND (SELECT COUNT(*) FROM ranked_usage WHERE user_id=?1 AND day<=?10)=?9
    AND (SELECT COALESCE(MAX(updated_at),0) FROM ranked_usage WHERE user_id=?1 AND day<=?10)=?8
    AND (SELECT COALESCE(MAX(source_at),0) FROM ranked_usage WHERE user_id=?1 AND day<=?10)=?11
    AND (SELECT COALESCE(SUM(tokens),0) FROM ranked_usage WHERE user_id=?1 AND day<=?10)=?12
    AND (SELECT COALESCE(SUM(requests),0) FROM ranked_usage WHERE user_id=?1 AND day<=?10)=?13
    AND (SELECT COUNT(*) FROM achievement_upload_days WHERE user_id=?1 AND day<=?10)=?14
    AND (SELECT COALESCE(MAX(first_report_at),0) FROM achievement_upload_days WHERE user_id=?1 AND day<=?10)=?15
    ON CONFLICT(user_id,badge_id,rule_version) DO NOTHING`)
    .bind(userId,JSON.stringify(pending.map(b=>({id:b.id,day:b.achieved_day}))),ACHIEVEMENT_VERSION,now,claimId,
      r.device,r.source,r.updated,r.count,data.as_of,r.row_source,r.tokens,r.requests,r.uploads,r.upload_at).run();
  const claimed=await env.DB.prepare('SELECT badge_id FROM achievement_displays WHERE user_id=?1 AND claim_id=?2').bind(userId,claimId).all();
  const ids=claimed.results.map(r=>r.badge_id),badges=pending.filter(b=>ids.includes(b.id)).sort((a,b)=>b.priority-a.priority);
  return Response.json({badge:badges[0]||null,count:badges.length,claimed_ids:ids});
}
export async function achievementShare(env,userId,body) {
  const {data}=await loadAchievements(env,userId);
  const badge=data.families.flatMap(f=>f.badges).find(b=>b.id===body?.badge_id&&b.earned);
  if(!badge)return jsonError(409,'该成就尚未达成，或数据已修正，请刷新');
  if(body.achievement_snapshot!==data.snapshot)return Response.json({error:'成就数据已有更新，请刷新后分享',code:'ACHIEVEMENT_CHANGED'},{status:409});
  return badge;
}
