import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {deleteAccount} from '../src/account.js';
import {connectionReminderMeta,reminderConfig,reminderStatus,acknowledgeReminderPrompt,reserveReminder,cancelReminder,nextDaily,trackReminderFailure,runReminders,createReminderSender,templateData,dailySummary} from '../src/reminders.js';
const now=Date.parse('2026-10-19T09:00:00+08:00'), minute=60000;
// Only test fixtures use synthetic template IDs. Production requires approved IDs.
const config={daily:{template_id:'w'.repeat(43),fields:{thing2:'title',thing3:'summary',time5:'time'}},sync_error:{template_id:'e'.repeat(43),fields:{thing1:'reason',thing2:'platform',number3:'duration',time4:'time'}}};
function fixture(t) {
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const f={db};
 function prepare(sql){let args=[];const params=()=>Object.fromEntries(args.map((v,i)=>[String(i+1),v]));return{_sql:sql,bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(params())??null;},async all(){return {results:db.prepare(sql).all(params())};},_run(){const r=db.prepare(sql).run(params());return {meta:{changes:r.changes}};},async run(){return this._run();}};}
 f.env={WX_REMINDERS_ENABLED:'1',WX_APPID:'test-app',WX_APPSECRET:'test-secret',WX_REMINDER_TEMPLATES:JSON.stringify(config),DB:{prepare,async batch(stmts){db.exec('BEGIN');try{const out=[];for(const statement of stmts)out.push(/^SELECT/i.test(statement._sql)?await statement.all():statement._run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 for(const id of [1,2]){db.prepare('INSERT INTO users(id,openid,created_at,updated_at) VALUES(?,?,1,1)').run(id,'private-'+id);db.prepare('INSERT INTO connect_tokens(token,user_id,created_at,last_report_at) VALUES(?,?,1,?)').run('connect-'+id,id,now);db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+id,id,Date.now()+60000);}
 f.reserve=(kind='daily',id=1,at=now-60*minute,request='request_fixture_0001')=>reserveReminder(f.env,id,kind,{request_id:request},at);
 f.job=(kind='daily',id=1)=>db.prepare('SELECT * FROM reminder_jobs WHERE user_id=? AND kind=?').get(id,kind);
 f.seed=(id=1,day='2026-10-18',tokens=258000000,device='selected')=>{db.prepare("INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at) VALUES(?,?,?,?,0,0,0,0,1,'[]','[]',1,1)").run(id,device,day,tokens);db.prepare('INSERT OR IGNORE INTO usage_sync_state VALUES(?,?,1,1)').run(id,'selected');};
 f.agent=async(state='error',at=now,device='selected')=>{db.prepare("INSERT INTO sync_agents(user_id,device_id,client_version,platform,state,error_code,event_at,last_seen_at) VALUES(1,?,'0.2.16','darwin',?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,event_at=excluded.event_at,last_seen_at=excluded.last_seen_at").run(device,state,state==='error'?'UPLOAD_FAILED':state==='stopped'?'USER_DISABLED':null,at,at);await trackReminderFailure(f.env,1,device);};
 f.sent=[];f.run=at=>runReminders(f.env,{now:at??now,send:async(env,payload)=>{f.sent.push(payload);return {state:'sent',code:null};}});
 return f;
}
test('无模板、密钥、字段或总开关时不开放、不访问数据库、不发送',async()=>{
 for(const env of [{},{WX_REMINDERS_ENABLED:'1'},{WX_REMINDERS_ENABLED:'0',WX_REMINDER_TEMPLATES:JSON.stringify(config)}]){assert.deepEqual(reminderConfig(env),{});assert.deepEqual(await runReminders(env),{processed:0});}
 assert.deepEqual(reminderConfig({WX_REMINDERS_ENABLED:'1',WX_APPID:'a',WX_APPSECRET:'b',WX_REMINDER_TEMPLATES:'broken'}),{});
});
test('首次命令建立待询问状态，零用量上报也触发；未上报、旧用户和重置不触发',async t=>{
 const f=fixture(t);f.db.exec('UPDATE connect_tokens SET last_report_at=NULL WHERE user_id=1');
 assert.equal((await connectionReminderMeta(f.env,1,null)).reminder_prompt_eligible,false);
 await acknowledgeReminderPrompt(f.env,1,now);assert.equal(f.db.prepare('SELECT prompt_seen_at FROM reminder_preferences WHERE user_id=1').get().prompt_seen_at,null);
 f.seed(1,'2026-10-19',0);f.db.exec('UPDATE connect_tokens SET last_report_at=1 WHERE user_id=1');
 assert.equal((await connectionReminderMeta(f.env,1,1)).reminder_prompt_eligible,true);
 await acknowledgeReminderPrompt(f.env,1,now);await acknowledgeReminderPrompt(f.env,1,now+100);
 assert.equal(f.db.prepare('SELECT prompt_seen_at FROM reminder_preferences WHERE user_id=1').get().prompt_seen_at,now);
 assert.equal((await connectionReminderMeta(f.env,1,null)).reminder_prompt_eligible,false);
 assert.equal((await connectionReminderMeta(f.env,2,now)).reminder_prompt_eligible,false);
 f.db.exec('DELETE FROM reminder_preferences WHERE user_id=1');assert.equal((await connectionReminderMeta(f.env,1,null)).reminder_prompt_eligible,false);
});
test('模板未配置时保留待询问状态，配置后可询问，不伪造预约',async t=>{
 const f=fixture(t);f.db.exec('UPDATE connect_tokens SET last_report_at=NULL WHERE user_id=1');f.env.WX_REMINDERS_ENABLED='0';await connectionReminderMeta(f.env,1,null);f.db.exec('UPDATE connect_tokens SET last_report_at=1 WHERE user_id=1');
 assert.equal((await reminderStatus(f.env,1)).reminder_prompt_eligible,false);assert.equal((await f.reserve()).status,503);
 f.env.WX_REMINDERS_ENABLED='1';assert.equal((await reminderStatus(f.env,1)).reminder_prompt_eligible,true);
});
test('日报预约下个北京时间09:00，覆盖前一自然日；跨月跨年和闰年边界正确',()=>{
 assert.deepEqual(nextDaily(now-1),{report_day:'2026-10-18',scheduled_at:now});
 assert.deepEqual(nextDaily(now),{report_day:'2026-10-19',scheduled_at:now+86400000});
 assert.equal(nextDaily(Date.parse('2026-10-19T00:00:00+08:00')).report_day,'2026-10-18');
 assert.equal(nextDaily(Date.parse('2027-01-01T08:00:00+08:00')).report_day,'2026-12-31');
 assert.equal(nextDaily(Date.parse('2024-03-01T08:00:00+08:00')).report_day,'2024-02-29');
});
test('接口必须本人登录，状态不泄露openid和密钥，预约要求真实接入',async t=>{
 const f=fixture(t);const req=token=>new Request('https://rank.test/api/reminders',{headers:token?{authorization:'Bearer '+token}:{}});
 assert.equal((await worker.fetch(req(),f.env)).status,401);const status=await (await worker.fetch(req('session-1'),f.env)).json();assert.equal(status.kinds.length,2);assert.doesNotMatch(JSON.stringify(status),/private-|test-secret|openid|device_id/);
 f.db.exec('UPDATE connect_tokens SET last_report_at=NULL WHERE user_id=1');assert.equal((await f.reserve()).status,409);
 assert.equal((await reserveReminder(f.env,1,'daily',{request_id:'short'},now)).status,400);
});
test('一人每项仅一个预约，同请求重试不重复；取消后旧请求不复活，不能取消别人',async t=>{
 const f=fixture(t);await f.reserve();const job=f.job();await f.reserve();assert.equal(f.job().id,job.id);
 assert.equal((await cancelReminder(f.env,2,'daily',{id:job.id},now)).status,409);
 assert.equal((await cancelReminder(f.env,1,'daily',{id:job.id},now)).status,200);await f.reserve();assert.equal(f.job().state,'cancelled');
 await f.reserve('daily',1,now,'request_fixture_0002');assert.notEqual(f.job().id,job.id);assert.equal(f.job().state,'pending');
 f.db.exec("UPDATE reminder_jobs SET state='sending'");assert.equal((await f.reserve('daily',1,now,'request_fixture_0003')).status,409);assert.equal((await cancelReminder(f.env,1,'daily',{id:f.job().id},now)).status,409);
});
test('日报只读取本人选中设备和预约日期，零记录跳过，真实零用量发送零',async t=>{
 const f=fixture(t);await f.reserve();f.seed();f.seed(2,'2026-10-18',9999);f.seed(1,'2026-10-18',9999,'old');f.seed(1,'2026-10-19',9999);
 assert.equal((await f.run(now-1)).processed,0);assert.equal((await f.run()).processed,1);const p=f.sent[0];
 assert.equal(p.touser,'private-1');assert.equal(p.data.thing3.value,'2.58亿 · 1次');assert.equal(p.data.thing2.value,'10.18 Token日报');
 assert.equal(p.page,'pages/daily/daily?day=2026-10-18');assert.equal(f.job().state,'sent');assert.equal((await f.run()).processed,0);
 await f.reserve('daily',2);await f.run();assert.equal(f.sent.length,2);
 await f.reserve('daily',2,now,'request_fixture_0002');await f.run(now+86400000);assert.equal(f.job('daily',2).state,'skipped');assert.equal(f.job('daily',2).error_code,'NO_DAY_USAGE');
 await f.reserve('daily',1,now,'request_fixture_0003');await f.run(now+86400000);assert.equal(f.sent.at(-1).data.thing3.value,'9999 · 1次');
 await f.reserve('daily',2,now+86400000,'request_fixture_0003');f.seed(2,'2026-10-20',0);f.db.exec("UPDATE daily_totals SET requests=0 WHERE user_id=2 AND day='2026-10-20'");await f.run(now+2*86400000);assert.equal(f.sent.at(-1).data.thing3.value,'0 · 0次');
});
test('过期日报不补发为其他日期，也不变成每天无限发送',async t=>{
 const f=fixture(t);await f.reserve();f.seed();await f.run(now+86400000);assert.equal(f.sent.length,0);assert.equal(f.job().error_code,'DAILY_EXPIRED');await f.run(now+2*86400000);assert.equal(f.sent.length,0);
});
test('日报摘要同时有用量和次数，亿单位与微信20字上限兼容',()=>{
 assert.equal(dailySummary(258000000,1382),'2.58亿 · 1382次');
 for(const tokens of [0,9999,10000,1e8,1e12,Number.MAX_SAFE_INTEGER])for(const calls of [0,1382,1e8,Number.MAX_SAFE_INTEGER])assert.ok([...dailySummary(tokens,calls)].length<=20);
});
test('并发定时任务只领取发送一次；模板变更要求再次授权',async t=>{
 const f=fixture(t);await f.reserve();f.seed();await Promise.all([f.run(),f.run()]);assert.equal(f.sent.length,1);
 await f.reserve('daily',1,now-60*minute,'request_fixture_0002');f.env.WX_REMINDER_TEMPLATES=JSON.stringify({...config,daily:{...config.daily,template_id:'z'.repeat(43)}});await f.run();assert.equal(f.job().state,'needs_permission');assert.equal(f.sent.length,1);
});
test('连续失败15分钟才提醒，正常心跳、主动停止、失联和另一设备不触发',async t=>{
 const f=fixture(t);f.seed();await f.reserve('sync_error',1,now-30*minute);
 await f.agent('error',now-15*minute);await f.agent('error',now-5*minute);await f.run(now-1);assert.equal(f.sent.length,0);await f.run(now);assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.thing1.value,'用量上传失败');
 await f.reserve('sync_error',1,now,'request_fixture_0002');await f.agent('error',now+20*minute);await f.run(now+20*minute);assert.equal(f.sent.length,1,'一天最多一次');
 await f.reserve('sync_error',2,now-60*minute);await f.run(now+2*86400000);assert.equal(f.sent.length,1,'失联不能当作明确异常');
});
test('失败间隔大于15分钟重新计时，健康或停止清空失败，预约前旧故障不直接发送',async t=>{
 const f=fixture(t);f.seed();await f.reserve('sync_error',1,now-30*minute);await f.agent('error',now-30*minute);await f.agent('error',now);await f.run();assert.equal(f.sent.length,0);
 await f.agent('idle',now+minute);await f.agent('error',now+2*minute);assert.equal(f.db.prepare('SELECT error_since FROM reminder_failure_runs').get().error_since,now+2*minute);
 await f.agent('stopped',now+3*minute);await f.run(now+30*minute);assert.equal(f.sent.length,0);
 await f.agent('error',now+4*minute,'other');await f.agent('error',now+14*minute,'other');await f.agent('error',now+24*minute,'other');await f.run(now+24*minute);assert.equal(f.sent.length,0);
});
test('发送超时不盲重试，中断状态转待确认；微信权限耗尽状态清楚',async t=>{
 const f=fixture(t);await f.reserve();f.seed();let count=0;await runReminders(f.env,{now,send:async()=>{count++;throw Error('network private-url');}});assert.equal(f.job().state,'unknown');assert.equal(f.job().error_code,'SEND_UNCONFIRMED');await f.run();assert.equal(count,1);assert.equal(f.sent.length,0);
 await f.reserve('daily',1,now-60*minute,'request_fixture_0002');await runReminders(f.env,{now,send:async()=>({state:'needs_permission',code:'WX_43101'})});assert.equal(f.job().state,'needs_permission');
 f.db.exec("UPDATE reminder_jobs SET state='sending',attempted_at=1");await f.run();assert.equal(f.job().state,'unknown');
});
test('注销清除全部提醒资料并阻止迟到写入；停用用户不发送',async t=>{
 const f=fixture(t);f.seed();await f.reserve();await connectionReminderMeta(f.env,1,now);await f.reserve('sync_error');await f.agent();
 await deleteAccount(f.env,1);for(const table of ['reminder_jobs','reminder_preferences','reminder_failure_runs'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=1`).get().n,0);
 await assert.rejects(f.env.DB.prepare('INSERT INTO reminder_preferences VALUES(1,1,NULL)').run(),/ACCOUNT_NOT_FOUND/);await f.run();assert.equal(f.sent.length,0);
 await f.reserve('daily',2);f.seed(2);f.db.exec('UPDATE users SET disabled_at=1 WHERE id=2');await f.run();assert.equal(f.sent.length,0);
});
test('迁移可重复执行，不改现有用量和用户',t=>{
 const f=fixture(t);f.seed();const before=f.db.prepare('SELECT * FROM daily_totals').all();const sql=readFileSync(new URL('../migrations/0012_reminders.sql',import.meta.url),'utf8');f.db.exec(sql);f.db.exec(sql);assert.deepEqual(f.db.prepare('SELECT * FROM daily_totals').all(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,2);
});
test('模板字段不合规不发送，金额和原始日志不会混入通知',()=>{
 assert.throws(()=>templateData({fields:{thing1:'reason'}},{reason:'x'.repeat(21)}),/FIELD_TOO_LONG/);
 assert.throws(()=>templateData({fields:{number1:'tokens'}},{tokens:'2.58 亿'}),/FIELD_TYPE_MISMATCH/);
 assert.throws(()=>templateData({fields:{thing1:'title'}},{}),/DATA_UNAVAILABLE/);
});
test('微信发送复用令牌，只在明确过期时重取，拒绝和网络失败不重复消费授权',async()=>{
 const calls=[];let expired=true;const send=createReminderSender({now:()=>now,fetcher:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json(url.includes('stable_token')?{access_token:'secret-token',expires_in:7200}:expired?(expired=false,{errcode:42001}):{errcode:0});}});
 const env={WX_APPID:'a',WX_APPSECRET:'secret'},payload={touser:'u',template_id:'t',data:{thing1:{value:'日报'}}};
 assert.deepEqual(await send(env,payload),{state:'sent',code:null});await send(env,payload);assert.equal(calls.filter(c=>c.url.includes('stable_token')).length,2);assert.deepEqual(calls.at(-1).body,payload);
 const rejected=createReminderSender({fetcher:async url=>Response.json(url.includes('stable_token')?{access_token:'t'}:{errcode:43101})});assert.equal((await rejected(env,payload)).state,'needs_permission');
 let attempts=0;const uncertain=createReminderSender({fetcher:async url=>{if(url.includes('stable_token'))return Response.json({access_token:'t'});attempts++;throw Error('timeout');}});await assert.rejects(uncertain(env,payload),/timeout/);assert.equal(attempts,1);
});

test('日报迁移保留同步异常和日报预约、停止旧周报，不迁移用户授权或删除用量',async t=>{
 const f=fixture(t);f.seed();await f.reserve();await f.reserve('sync_error');
 f.db.prepare("INSERT INTO reminder_jobs SELECT user_id,'weekly','legacy','legacy-request',template_id,'pending',scheduled_at,week_start,created_at,updated_at,NULL,NULL,NULL FROM reminder_jobs WHERE kind='daily'").run();
 const daily=f.job(),sync=f.job('sync_error'),usage=f.db.prepare('SELECT * FROM daily_totals').all();
 const sql=readFileSync(new URL('../migrations/0013_daily_reminders.sql',import.meta.url),'utf8');f.db.exec(sql);f.db.exec(sql);
 assert.deepEqual(f.job(),daily);assert.deepEqual(f.job('sync_error'),sync);assert.deepEqual(f.db.prepare('SELECT * FROM daily_totals').all(),usage);
 const legacy=f.db.prepare("SELECT state,error_code FROM reminder_jobs WHERE kind='weekly'").get();assert.equal(legacy.state,'cancelled');assert.equal(legacy.error_code,'DAILY_REPLACED_WEEKLY');
 assert.equal((await reserveReminder(f.env,1,'weekly',{request_id:'legacy-request-new'},now)).status,410);
});
test('从原始0012检查约束升级，旧提醒逐项保留，新增日报可写且注销保护仍生效',async t=>{
 const f=fixture(t);f.db.exec('DROP TABLE reminder_jobs');f.db.exec(readFileSync(new URL('../migrations/0012_reminders.sql',import.meta.url),'utf8'));
 f.db.exec("INSERT INTO reminder_jobs(user_id,kind,id,request_id,template_id,state,scheduled_at,week_start,created_at,updated_at,last_sent_at) VALUES(1,'weekly','old-week','old-request','old-template','sent',1,'2026-10-12',1,1,1),(1,'sync_error','old-sync','sync-request','sync-template','pending',NULL,NULL,1,1,2)");
 const before=f.db.prepare('SELECT * FROM reminder_jobs ORDER BY kind').all();f.db.exec(readFileSync(new URL('../migrations/0013_daily_reminders.sql',import.meta.url),'utf8'));
 assert.deepEqual(f.db.prepare("SELECT * FROM reminder_jobs WHERE kind<>'daily' ORDER BY kind").all(),before);assert.equal((await f.reserve()).status,200);
 f.db.exec('DELETE FROM users WHERE id=2');await assert.rejects(f.env.DB.prepare("INSERT INTO reminder_jobs(user_id,kind,id,request_id,template_id,state,created_at,updated_at) VALUES(2,'daily','x','x','x','pending',1,1)").run(),/ACCOUNT_NOT_FOUND/);
});
