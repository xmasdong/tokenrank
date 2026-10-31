import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {buildAchievements,loadAchievements,claimAchievements} from '../src/achievements.js';
import {storeTotalReport} from '../src/report.js';
import {deleteAccount} from '../src/account.js';
import {readShare} from '../src/shares.js';
const now=Date.parse('2026-10-30T04:00:00Z');
const row=(day,tokens,extra={})=>({day,tokens,requests:100,models_json:'[["Model A",1]]',tools_json:'[["Codex",1]]',source_at:1,updated_at:1,...extra});
const ready={device_id:'device',source_at:1,disabled_at:null};
const badge=(data,id)=>data.families.flatMap(f=>f.badges).find(b=>b.id===id);
function fixture(t,legacy=false){
 const db=new DatabaseSync(':memory:');const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');db.exec(legacy?schema.split('-- Achievement display receipts')[0]:schema);t.after(()=>db.close());
 const f={db,beforeClaim:null};
 function prepare(sql){let values=[];const args=()=>Object.fromEntries(values.map((v,i)=>[String(i+1),v]));return {sql,bind(...a){values=a;return this;},async first(){return db.prepare(sql).get(args())||null;},async all(){return {results:db.prepare(sql).all(args())};},_run(){const r=db.prepare(sql).run(args());return {meta:{changes:r.changes}};},async run(){if(sql.startsWith('INSERT INTO achievement_displays')&&f.beforeClaim){const fn=f.beforeClaim;f.beforeClaim=null;fn();}return this._run();}};}
 f.env={DB:{prepare,async batch(stmts){db.exec('BEGIN');try{const r=stmts.map(s=>s._run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 for(const id of [1,2]){db.prepare('INSERT INTO users(id,openid,nickname,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'open-'+id,'用户'+id,now,now);db.prepare('INSERT INTO usage_sync_state VALUES(?,?,?,?)').run(id,'device',1,now);db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+id,id,Date.now()+60000);db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,?)').run('connect-'+id,id,now);}
 f.seed=(id,day,tokens,extra={})=>{const r=row(day,tokens,extra);db.prepare("INSERT OR REPLACE INTO daily_totals VALUES(?, ?, ?, ?, ?,0,0,0,?,?,?, ?,?,NULL,NULL)").run(id,extra.device_id||'device',day,tokens,tokens,r.requests,r.models_json,r.tools_json,r.source_at,r.updated_at);};
 f.request=(path,method='GET',body,token='session-1')=>worker.fetch(new Request('https://rank.test'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),f.env);
 f.report=(time,extra={})=>storeTotalReport(f.env,{user_id:1,token:'connect-1'},{v:2,timezone:'Asia/Shanghai',token_basis:'upstream_total',device_id:'device',source_at:time,full:true,complete:true,days:[{day:'2026-10-01',tokens:1,input_tokens:1,output_tokens:0,cache_read:0,cache_write:0,requests:1,models:[],tools:[]}],...extra},time);
 return f;
}
test('真实总量只计一次缓存、日桶去重、剔除未来日期，门槛按首次跨越的记录日计算',()=>{
 const data=buildAchievements([row('2026-10-01',8e7),row('2026-10-02',2e8,{cache_read:9e8}),row('2026-10-02',1,{source_at:0}),row('2026-11-01',1e12)],[],[],ready,now);
 assert.equal(badge(data,'total:100000000').current,2.8e8);assert.equal(badge(data,'total:100000000').achieved_day,'2026-10-02');assert.equal(badge(data,'peak:100000000').achieved_day,'2026-10-02');assert.equal(badge(data,'total:1000000000').earned,false);
 assert.equal(data.families.length,12);assert.equal(data.families.filter(f=>!f.enabled).length,4);
 assert.equal(buildAchievements([],[],[],null,now).earned_count,0);
});
test('活跃连续与真实上传连续独立；历史日期、零日和重复上传不能伪造上传记录',()=>{
 const rows=[row('2026-10-01',1),row('2026-10-02',1),row('2026-10-03',0,{requests:0}),row('2026-10-04',1)];
 let data=buildAchievements(rows,[],[],ready,now);assert.equal(badge(data,'active:3').earned,false);assert.equal(badge(data,'uploads:3').current,0);
 data=buildAchievements([...rows,row('2026-10-03',0,{requests:1,source_at:2})],[{day:'2026-10-28'},{day:'2026-10-29'},{day:'2026-10-29'},{day:'2026-10-30'}],[],ready,now);
 assert.equal(badge(data,'active:3').achieved_day,'2026-10-03');assert.equal(badge(data,'uploads:3').achieved_day,'2026-10-30');assert.equal(badge(data,'uploads:3').current,3);
});
test('只计正用量的可识别模型和工具；损坏与未分类项不虚构种类',()=>{
 const data=buildAchievements([row('2026-10-01',10,{models_json:'[["A",2],["B",0],["其他 / 未分类",8]]',tools_json:'bad'}),row('2026-10-02',10,{models_json:'[["A",2],["C",1],["D",1]]',tools_json:'[["Claude Code",2],["Codex",3]]'})],[],[],ready,now);
 assert.equal(badge(data,'models:3').current,3);assert.equal(badge(data,'models:3').achieved_day,'2026-10-02');assert.equal(badge(data,'tools:2').earned,true);
});
test('选定设备和启用状态限制成就；客户端不能查询或确认别人的成就',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',2e8);f.seed(1,'2026-10-02',1e12,{device_id:'old-device'});f.seed(2,'2026-10-01',1e12);
 const data=await(await f.request('/api/my/achievements?user_id=2')).json();assert.equal(badge(data,'total:100000000').current,2e8);
 assert.equal((await f.request('/api/my/achievements','GET',null,'')).status,401);
 f.db.exec('UPDATE users SET disabled_at=1 WHERE id=1');assert.equal((await f.request('/api/my/achievements')).status,403);assert.equal((await f.request('/api/my/achievements/claim','POST',{})).status,403);
});
test('整批首次解锁由账号唯一键保证只展示一次，最高一枚优先，跨手机重复请求不重复',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',1e11,{requests:100000});
 const first=await(await claimAchievements(f.env,1,now)).json(),second=await(await claimAchievements(f.env,1,now)).json();
 assert.equal(first.badge.id,'total:100000000000');assert.ok(first.count>1);assert.equal(second.count,0);
 assert.equal((await loadAchievements(f.env,1,now)).data.pending.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_displays WHERE user_id=2').get().n,0);
});
test('数据修正会撤回不再满足的当前成就；已展示回执不强行保留错误数值',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',1e11);await claimAchievements(f.env,1,now);
 f.db.exec('UPDATE daily_totals SET tokens=1,source_at=2,updated_at=2 WHERE user_id=1');
 assert.equal(badge((await loadAchievements(f.env,1,now)).data,'total:100000000000').earned,false);
 f.db.exec('UPDATE daily_totals SET tokens=100000000000,source_at=3 WHERE user_id=1');
 assert.equal((await(await claimAchievements(f.env,1,now)).json()).count,0);
});
test('两台手机并发领取时只有一台获得整批展示资格',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',1e11,{requests:100000});
 const responses=await Promise.all([claimAchievements(f.env,1,now),claimAchievements(f.env,1,now)]);
 const claims=await Promise.all(responses.map(r=>r.json()));
 assert.equal(claims.filter(r=>r.count>0).length,1);
 assert.equal(claims.reduce((n,r)=>n+r.count,0),f.db.prepare('SELECT COUNT(*) n FROM achievement_displays WHERE user_id=1').get().n);
});
test('领取前数据发生变化时不展示过期成就，注销不能被迟到的领取重建资料',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',1e11);
 f.beforeClaim=()=>f.db.exec('UPDATE daily_totals SET tokens=0,source_at=2,updated_at=2 WHERE user_id=1');
 assert.equal((await(await claimAchievements(f.env,1,now)).json()).count,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_displays').get().n,0);
 f.db.exec('UPDATE daily_totals SET tokens=100000000000 WHERE user_id=1');await deleteAccount(f.env,1);
 assert.equal((await(await claimAchievements(f.env,1,now)).json()).count,0);
});
test('上传只在完整接受后按北京时间记一天；五分钟重报不重复，分片和拒绝不计',async t=>{
 const f=fixture(t),midnight=Date.parse('2026-10-30T15:59:00Z');
 assert.equal((await f.report(midnight,{complete:false})).status,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days').get().n,0);
 assert.equal((await f.report(midnight+1)).status,200);assert.equal((await f.report(midnight+2)).status,200);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days').get().n,1);
 assert.equal((await f.report(midnight+120000)).status,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days').get().n,2);
 assert.equal((await f.report(midnight-1)).status,409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days').get().n,2);
});
test('完整重建分片不计上传日，提交成功才记；失败重试与普通回传共享同一天',async t=>{
 const f=fixture(t),a='a'.repeat(32),meta={client_version:'0.2.20',collector_version:'1.9.0'};
 const part=(i,days=1)=>({...meta,complete:i===1,replace:{id:a,batch_index:i,batch_count:2,total_days:2},days:[{day:'2026-10-0'+days,tokens:1,input_tokens:1,output_tokens:0,cache_read:0,cache_write:0,requests:1,models:[],tools:[]}]});
 assert.equal((await f.report(now,part(0))).status,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days').get().n,0);
 assert.equal((await f.report(now,part(1,2))).status,200);assert.equal((await f.report(now,part(1,2))).status,200);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days').get().n,1);
});
test('成就分享只接受服务端已达成快照，免登录读取作者，修正/撤销/注销后失效',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',1e11);const data=await(await f.request('/api/my/achievements')).json();
 const body={style:'milestone',badge_id:'total:100000000000',achievement_snapshot:data.snapshot};
 assert.equal((await f.request('/api/shares','POST',{...body,achievement_snapshot:'old'})).status,409);
 const response=await f.request('/api/shares','POST',body);assert.equal(response.status,200);const record=await response.json();
 assert.equal(record.style,'milestone');assert.equal(record.usage.milestone.current,1e11);assert.equal(record.user.nickname,'用户1');
 const text=JSON.stringify(record);assert.doesNotMatch(text,/openid|session_key|device_id|claim_id|user_id|first_report_at/);
 assert.equal((await f.request('/api/shares/'+record.id,'GET',null,'')).status,200);
 f.db.exec('UPDATE daily_totals SET tokens=1 WHERE user_id=1');assert.equal(await readShare(f.env,record.id),null);
 await deleteAccount(f.env,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_displays WHERE user_id=1').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_upload_days WHERE user_id=1').get().n,0);
});
test('迁移幂等，并阻止注销后的新成就回执与上传日落库',async t=>{
 const f=fixture(t);f.db.exec(readFileSync(new URL('../migrations/0018_achievements.sql',import.meta.url),'utf8'));await deleteAccount(f.env,1);
 assert.throws(()=>f.db.prepare("INSERT INTO achievement_upload_days VALUES(1,'2026-10-30',1)").run(),/ACCOUNT_NOT_FOUND/);
 assert.throws(()=>f.db.prepare("INSERT INTO achievement_displays VALUES(1,'connect:1',1,1,'2026-10-30','x')").run(),/ACCOUNT_NOT_FOUND/);
});

test('成就路由已注册而非404，读取无写入，错误方法拒绝且不消耗首次展示资格',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-01',1e8);
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal((await f.request('/api/my/achievements','GET',null,'')).status,401);
 const response=await f.request('/api/my/achievements');assert.equal(response.status,200);
 const data=await response.json();assert.ok(data.pending.length>0);assert.equal(data.token_basis,'upstream_total');
 assert.equal((await f.request('/api/my/achievements','POST',{})).status,405);
 assert.equal((await f.request('/api/my/achievements/claim')).status,405);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM achievement_displays').get().n,0);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('从尚无成就表的正式旧结构升级，仅新增成就结构，保留现有用户和用量',async t=>{
 const f=fixture(t,true);f.seed(1,'2026-10-01',2e8);
 const before=f.db.prepare('SELECT COUNT(*) n,SUM(tokens) tokens FROM daily_totals').get(),users=f.db.prepare('SELECT COUNT(*) n FROM users').get().n;
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='achievement_upload_days'").get().n,0);
 const migration=readFileSync(new URL('../migrations/0018_achievements.sql',import.meta.url),'utf8');f.db.exec(migration);f.db.exec(migration);
 assert.deepEqual(f.db.prepare('SELECT COUNT(*) n,SUM(tokens) tokens FROM daily_totals').get(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,users);
 const response=await f.request('/api/my/achievements');assert.equal(response.status,200);const data=await response.json();assert.equal(badge(data,'total:100000000').current,2e8);assert.equal(badge(data,'uploads:3').current,0);
});
