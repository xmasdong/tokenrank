import { jsonError, beijingDay } from './lib.js';
import { addDays, buildDaily, validDay } from './history.js';
const KEYS = ['daily','sync_error'], STALE = 15 * 60000;
const VALUES = new Set(['title','range','tokens','active_days','reported_days','requests','time','reason','platform','duration','summary']);
const SOURCES = { daily:new Set(['title','range','tokens','requests','time','summary']), sync_error:new Set(['title','reason','platform','duration','time']) };
const LABELS = { daily:'用量日报', sync_error:'同步异常' };
export function reminderConfig(env) {
  let raw; try { raw = JSON.parse(env.WX_REMINDER_TEMPLATES || '{}'); } catch { raw = {}; }
  const result = {};
  if (env.WX_REMINDERS_ENABLED !== '1' || !env.WX_APPID || !env.WX_APPSECRET) return result;
  for (const key of KEYS) {
    const item = raw?.[key], fields = item?.fields;
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(item?.template_id || '') || !fields || Array.isArray(fields) || typeof fields !== 'object') continue;
    const entries = Object.entries(fields);
    if (!entries.length || entries.length > 10 || entries.some(([field, value]) =>
      !/^(thing|number|time|date|phrase|character_string)\d+$/.test(field) || !VALUES.has(value) || !SOURCES[key].has(value))) continue;
    // Two different intents must not silently share a single permission quota.
    if (Object.values(result).some(other => other.template_id === item.template_id)) continue;
    result[key] = { template_id:item.template_id, fields };
  }
  return result;
}
export function reminderMeta(env, preference, lastReport) {
  const kinds = KEYS.filter(key => reminderConfig(env)[key]);
  return { reminder_kinds:kinds, reminder_prompt_eligible:!!(kinds.length && lastReport && preference?.awaiting_first_report && !preference.prompt_seen_at) };
}
/** Called when obtaining an installation command, before a first upload exists. */
export async function connectionReminderMeta(env, userId, lastReport) {
  let preference = await env.DB.prepare('SELECT * FROM reminder_preferences WHERE user_id=?1').bind(userId).first();
  if (!preference) {
    await env.DB.prepare(`INSERT OR IGNORE INTO reminder_preferences(user_id,awaiting_first_report)
      SELECT ?1,CASE WHEN ?2 IS NULL AND NOT EXISTS(SELECT 1 FROM daily_totals WHERE user_id=?1)
        AND NOT EXISTS(SELECT 1 FROM daily_stats WHERE user_id=?1) THEN 1 ELSE 0 END
      WHERE EXISTS(SELECT 1 FROM users WHERE id=?1)`).bind(userId,lastReport ?? null).run();
    preference = await env.DB.prepare('SELECT * FROM reminder_preferences WHERE user_id=?1').bind(userId).first();
  }
  return reminderMeta(env,preference,lastReport);
}
export function nextDaily(now = Date.now()) {
  const today = beijingDay(now), nine = Date.parse(today + 'T09:00:00+08:00');
  const sendDay = now < nine ? today : addDays(today, 1);
  return { report_day:addDays(sendDay, -1), scheduled_at:Date.parse(sendDay + 'T09:00:00+08:00') };
}
export async function reminderStatus(env, userId, now = Date.now()) {
  const user = await env.DB.prepare(`SELECT c.last_report_at,p.awaiting_first_report,p.prompt_seen_at
    FROM users u LEFT JOIN connect_tokens c ON c.user_id=u.id LEFT JOIN reminder_preferences p ON p.user_id=u.id WHERE u.id=?1`).bind(userId).first();
  if (!user) throw new Error('ACCOUNT_NOT_FOUND');
  const {results} = await env.DB.prepare('SELECT * FROM reminder_jobs WHERE user_id=?1').bind(userId).all(), config = reminderConfig(env);
  return { ...reminderMeta(env,user,user.last_report_at), has_reported:!!user.last_report_at,
    kinds:KEYS.map(key => { const job=results.find(row=>row.kind===key);return {key,label:LABELS[key],available:!!config[key],
      template_id:config[key]?.template_id || null, ...(key==='daily' ? nextDaily(now) : {}),
      appointment:job ? {id:job.id,state:job.state,scheduled_at:job.scheduled_at,...(key==='daily' ? {report_day:job.week_start} : {}),
        updated_at:job.updated_at,error_code:job.error_code} : null}; }) };
}
export async function acknowledgeReminderPrompt(env, userId, now = Date.now()) {
  await env.DB.prepare(`UPDATE reminder_preferences SET prompt_seen_at=COALESCE(prompt_seen_at,?2)
    WHERE user_id=?1 AND awaiting_first_report=1
    AND EXISTS(SELECT 1 FROM connect_tokens WHERE user_id=?1 AND last_report_at IS NOT NULL)`)
    .bind(userId,now).run();
  return Response.json({acknowledged:true});
}
export async function reserveReminder(env, userId, kind, body, now = Date.now()) {
  if (kind === 'weekly') return jsonError(410,'周报提醒已调整为日报，请重新预约');
  if (!KEYS.includes(kind) || !/^[A-Za-z0-9_-]{16,80}$/.test(body?.request_id || '')) return jsonError(400,'预约参数无效');
  const config = reminderConfig(env)[kind];
  if (!config) return jsonError(503,'该提醒暂未开放');
  const connected = await env.DB.prepare('SELECT 1 AS ok FROM connect_tokens WHERE user_id=?1 AND last_report_at IS NOT NULL').bind(userId).first();
  if (!connected) return jsonError(409,'请先完成电脑接入和首次用量同步');
  const current = await env.DB.prepare('SELECT * FROM reminder_jobs WHERE user_id=?1 AND kind=?2').bind(userId,kind).first();
  if (current?.state==='sending' && current.request_id!==body.request_id) return jsonError(409,'本次提醒正在发送，请稍后再试');
  const date = kind==='daily' ? nextDaily(now) : {scheduled_at:null,report_day:null};
  await env.DB.prepare(`INSERT INTO reminder_jobs(user_id,kind,id,request_id,template_id,state,scheduled_at,week_start,created_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,'pending',?6,?7,?8,?8 WHERE EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)
    ON CONFLICT(user_id,kind) DO UPDATE SET id=excluded.id,request_id=excluded.request_id,template_id=excluded.template_id,
      state='pending',scheduled_at=excluded.scheduled_at,week_start=excluded.week_start,created_at=excluded.created_at,
      updated_at=excluded.updated_at,attempted_at=NULL,error_code=NULL
    WHERE reminder_jobs.request_id<>excluded.request_id AND reminder_jobs.state<>'sending'`)
    .bind(userId,kind,crypto.randomUUID().replaceAll('-','').slice(0,24),body.request_id,config.template_id,date.scheduled_at,date.report_day,now).run();
  return Response.json(await reminderStatus(env,userId,now));
}
export async function cancelReminder(env, userId, kind, body, now=Date.now()) {
  if (!KEYS.includes(kind) || !/^[a-f0-9]{24}$/.test(body?.id || '')) return jsonError(400,'预约参数无效');
  const result = await env.DB.prepare(`UPDATE reminder_jobs SET state='cancelled',updated_at=?4 WHERE user_id=?1 AND kind=?2 AND id=?3 AND state='pending'`)
    .bind(userId,kind,body.id,now).run();
  if (!result.meta?.changes) return jsonError(409,'预约状态已有变化，请刷新后查看');
  return Response.json(await reminderStatus(env,userId,now));
}
/** Only accepted, ordered heartbeats can extend a continuous failure episode. */
export async function trackReminderFailure(env, userId, deviceId) {
  if (!reminderConfig(env).sync_error) return;
  await env.DB.prepare(`INSERT INTO reminder_failure_runs(user_id,device_id,state,error_since,event_at,last_seen_at)
    SELECT a.user_id,a.device_id,a.state,CASE WHEN a.state='error' THEN a.last_seen_at ELSE NULL END,a.event_at,a.last_seen_at
    FROM sync_agents a JOIN reminder_jobs j ON j.user_id=a.user_id AND j.kind='sync_error' AND j.state='pending'
    WHERE a.user_id=?1 AND a.device_id=?2
    ON CONFLICT(user_id,device_id) DO UPDATE SET state=excluded.state,event_at=excluded.event_at,last_seen_at=excluded.last_seen_at,
      error_since=CASE WHEN excluded.state<>'error' THEN NULL
        WHEN reminder_failure_runs.state='error' AND excluded.last_seen_at-reminder_failure_runs.last_seen_at<=900000
        THEN COALESCE(reminder_failure_runs.error_since,excluded.last_seen_at) ELSE excluded.last_seen_at END
    WHERE excluded.event_at>reminder_failure_runs.event_at OR
      (excluded.event_at=reminder_failure_runs.event_at AND excluded.last_seen_at>reminder_failure_runs.last_seen_at)`)
    .bind(userId,deviceId).run();
}
const time = timestamp => timestamp ? new Date(timestamp+8*3600000).toISOString().slice(0,16).replace('T',' ') : '';
export function templateData(config, values) {
  const data = {};
  for (const [field,source] of Object.entries(config.fields)) {
    let value = String(values[source] ?? '');
    if (!value) throw new Error('DATA_UNAVAILABLE');
    if (field.startsWith('number') && !/^\d{1,32}(?:\.\d+)?$/.test(value)) throw new Error('FIELD_TYPE_MISMATCH');
    const limit = field.startsWith('thing') ? 20 : field.startsWith('phrase') ? 5 : 32;
    if (![...value].length || [...value].length>limit) throw new Error('FIELD_TOO_LONG');
    data[field]={value};
  }
  return data;
}
export function createReminderSender({fetcher=(...args)=>fetch(...args),now=()=>Date.now()}={}) {
  const tokens=new Map();
  return async (env,payload) => {
    for (let attempt=0;attempt<2;attempt++) {
      let token=tokens.get(env.WX_APPID);
      if (!token || token.expires<=now() || attempt || token.secret!==env.WX_APPSECRET) {
        const response=await fetcher('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',signal:AbortSignal.timeout(10000),
          headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credential',appid:env.WX_APPID,secret:env.WX_APPSECRET,force_refresh:false})});
        const body=await response.json();
        if (!response.ok || !body.access_token) return {state:'failed',code:'TOKEN_UNAVAILABLE'};
        token={value:body.access_token,secret:env.WX_APPSECRET,expires:now()+Math.max(0,(body.expires_in||7200)-120)*1000};tokens.set(env.WX_APPID,token);
      }
      // Network ambiguity is not retried: a timed-out request may already have consumed permission.
      const response=await fetcher('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token='+encodeURIComponent(token.value),
        {method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const body=await response.json();
      if (attempt===0 && [40001,40014,42001].includes(body.errcode)) continue;
      return response.ok && body.errcode===0 ? {state:'sent',code:null}
        : {state:body.errcode===43101?'needs_permission':'failed',code:'WX_'+(Number(body.errcode)||'ERROR')};
    }
    return {state:'failed',code:'TOKEN_UNAVAILABLE'};
  };
}
const sender=createReminderSender();
const amount = tokens => tokens>=1e8 ? (tokens/1e8).toFixed(2)+' 亿' : tokens>=1e4 ? (tokens/1e4).toFixed(2)+' 万' : String(tokens);
export function dailySummary(tokens, requests) {
  const compact = value => amount(Math.max(0,Number(value)||0)).replaceAll(' ','');
  const content = compact(tokens) + ' · ' + compact(requests) + '次';
  if ([...content].length <= 20) return content;
  return Number(tokens).toExponential(2) + ' · ' + Number(requests).toExponential(1) + '次';
}
const reason = {SOURCE_READ_FAILED:'读取统计失败',COLLECTOR_OUTDATED:'统计内核需更新',UPLOAD_FAILED:'用量上传失败',AUTH_INVALID:'接入凭证失效',SYNC_CONFLICT:'同步任务冲突',UPGRADE_REQUIRED:'同步程序需更新',RATE_LIMITED:'上传请求受限',CHECK_TIMEOUT:'同步检查超时',PROCESS_EXIT:'同步检查退出'};
export async function runReminders(env,{now=Date.now(),send=sender}={}) {
  const config=reminderConfig(env);if (!Object.keys(config).length) return {processed:0};
  await env.DB.prepare(`UPDATE reminder_jobs SET state='unknown',error_code='SEND_INTERRUPTED',updated_at=?1
    WHERE state='sending' AND attempted_at<?2`).bind(now,now-10*60000).run();
  const {results}=await env.DB.prepare(`SELECT j.*,u.openid,a.platform,a.error_code AS agent_error,r.error_since FROM reminder_jobs j
    JOIN users u ON u.id=j.user_id AND u.disabled_at IS NULL JOIN connect_tokens c ON c.user_id=j.user_id AND c.last_report_at IS NOT NULL
    LEFT JOIN usage_sync_state s ON s.user_id=j.user_id LEFT JOIN sync_agents a ON a.user_id=j.user_id AND a.device_id=s.device_id
    LEFT JOIN reminder_failure_runs r ON r.user_id=a.user_id AND r.device_id=a.device_id
    WHERE j.state='pending' AND ((j.kind='daily' AND j.scheduled_at<=?1) OR
      (j.kind='sync_error' AND a.state='error' AND a.last_seen_at>=?2 AND r.event_at=a.event_at
       AND r.error_since IS NOT NULL AND MAX(r.error_since,j.created_at)<=?2 AND (j.last_sent_at IS NULL OR j.last_sent_at<=?3)))
    ORDER BY j.created_at,j.user_id LIMIT 50`).bind(now,now-STALE,now-86400000).all();
  let processed=0;
  for (const job of results) {
    const item=config[job.kind];if (!item) continue;
    const claimed=await env.DB.prepare(`UPDATE reminder_jobs SET state='sending',attempted_at=?3,updated_at=?3
      WHERE user_id=?1 AND id=?2 AND state='pending' AND EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)`)
      .bind(job.user_id,job.id,now).run();if (!claimed.meta?.changes) continue;
    processed++;let result;
    try {
      if (job.template_id!==item.template_id) result={state:'needs_permission',code:'TEMPLATE_CHANGED'};
      let values,page;
      if (!result && job.kind==='daily') {
        if (!validDay(job.week_start) || job.week_start >= beijingDay(now) || now - job.scheduled_at >= 86400000) result={state:'skipped',code:'DAILY_EXPIRED'};
        if (!result) {
          // The legacy column name is retained so existing weekly rows and old Workers remain compatible during migration.
          const {results:rows}=await env.DB.prepare('SELECT * FROM ranked_usage WHERE user_id=?1 AND day=?2').bind(job.user_id,job.week_start).all();
          const report=buildDaily(rows,job.week_start);
          if (!report.has_history) result={state:'skipped',code:'NO_DAY_USAGE'};
          values={title:job.week_start.slice(5).replace('-','.')+' Token日报',range:job.week_start,tokens:amount(report.summary.tokens),
            requests:report.summary.requests,summary:dailySummary(report.summary.tokens,report.summary.requests),time:time(now)};
          page='pages/daily/daily?day='+job.week_start+'&reminder_id='+job.id;
        }
      } else if (!result) {
        values={title:'同步异常',time:time(now),reason:reason[job.agent_error]||'同步检查失败',platform:job.platform==='win32'?'Windows':job.platform==='darwin'?'macOS':'电脑',duration:Math.floor((now-Math.max(job.error_since,job.created_at))/60000)};
        page='pages/connect/connect';
      }
      // Recheck deletion/cancellation immediately before crossing into WeChat.
      const active=!result && await env.DB.prepare(`SELECT 1 AS ok FROM reminder_jobs j JOIN users u ON u.id=j.user_id
        WHERE j.user_id=?1 AND j.id=?2 AND j.state='sending' AND u.disabled_at IS NULL`).bind(job.user_id,job.id).first();
      if (active) result=await send(env,{touser:job.openid,template_id:item.template_id,page,data:templateData(item,values),miniprogram_state:'formal',lang:'zh_CN'});
      else if (!result) continue;
    } catch (error) { const invalid=['DATA_UNAVAILABLE','FIELD_TYPE_MISMATCH','FIELD_TOO_LONG'].includes(error.message); result={state:invalid?'failed':'unknown',code:invalid?error.message:'SEND_UNCONFIRMED'}; }
    await env.DB.prepare(`UPDATE reminder_jobs SET state=?3,error_code=?4,updated_at=?5,last_sent_at=CASE WHEN ?3='sent' THEN ?5 ELSE last_sent_at END
      WHERE user_id=?1 AND id=?2 AND state='sending'`).bind(job.user_id,job.id,result.state,result.code,now).run();
  }
  return {processed};
}
