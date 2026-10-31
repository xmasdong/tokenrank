import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {beijingDay,beijingDaysAgo} from '../src/lib.js';
import {loadGroupInsights} from '../src/group-insights.js';
function fixture(t,count=6){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const env={DB:{prepare(sql){let values=[];const args=()=>Object.fromEntries(values.map((v,i)=>[String(i+1),v]));return{bind(...v){values=v;return this;},async first(){return db.prepare(sql).get(args())||null;},async all(){return{results:db.prepare(sql).all(args())};},async run(){return db.prepare(sql).run(args());}};},async batch(stmts){db.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.all());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 for(let i=1;i<=count;i++){db.prepare('INSERT INTO users(id,openid,nickname,created_at,updated_at) VALUES(?,?,?,1,1)').run(i,'secret-'+i,'成员'+i);db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+i,i,Date.now()+3600000);db.prepare('INSERT INTO usage_sync_state VALUES(?,?,1,1)').run(i,'selected');}
 db.exec("INSERT INTO rank_groups VALUES('g1','群一',1,'secret-real-group',1)");
 function join(uid,hidden=0){db.prepare('INSERT INTO rank_group_members VALUES(?, ?,1,?)').run('g1',uid,hidden);}
 function seed(uid,day,tokens,{device='selected',tool='Tool',model='Model',cost=null}={}){db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,cost_json,source_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,1)').run(uid,device,day,tokens,0,0,tokens,0,tokens?2:0,JSON.stringify([[model,tokens]]),JSON.stringify([[tool,tokens]]),cost&&JSON.stringify(cost));}
 async function req(path,uid=null,body=null){const r=await worker.fetch(new Request('https://rank.test'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(uid?{authorization:'Bearer session-'+uid}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);return{status:r.status,data:await r.json()};}
 return{db,env,join,seed,req};
}
const cost=amount=>({basis:'token_watcher_api_estimate',currency:'USD',usd_micros:amount,models:[['Model',amount]],unpriced_models:[],unpriced_tokens:0});
test('群分析与群榜同一公开范围，保留无头像成员，排除其他群/设备/隐藏/禁用/未来数据',async t=>{
 const f=fixture(t),today=beijingDay();for(let i=1;i<=5;i++)f.join(i,i===3?1:0);
 f.seed(1,today,100,{cost:cost(1000000)});f.seed(2,today,200,{model:'Other',cost:cost(2000000)});
 f.seed(1,today,900,{device:'old'});f.seed(3,today,300);f.seed(4,today,400);f.seed(5,today,500);f.seed(6,today,600);f.seed(1,'2099-01-01',999);
 f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=4;UPDATE users SET disabled_at=1 WHERE id=5');
 assert.equal((await f.req('/api/groups/g1/insights')).status,401);assert.equal((await f.req('/api/groups/g1/insights',6)).status,403);assert.equal((await f.req('/api/groups/g1/insights?period=all',1)).status,400);
 const before=f.db.prepare('SELECT total_changes() n').get().n,r=await f.req('/api/groups/g1/insights',1);
 assert.equal(r.status,200);assert.equal(r.data.summary.tokens,300);assert.equal(r.data.summary.cache_read,300);assert.equal(r.data.summary.active_users,2);assert.equal(r.data.group.members,5);assert.equal(r.data.summary.reported_users,2);
 assert.equal(r.data.cost.usd_micros,3000000);assert.equal(r.data.models.items[0].name,'Other');assert.equal(r.data.tools.items[0].users,2);assert.equal(r.data.tools.items[0].preferred_users,2);
 // The group statistics do not require avatar/nickname completion of members.
 assert.doesNotMatch(JSON.stringify(r.data),/user_id|device_id|secret|contributors|nickname|avatar|source_at/);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal((await f.req('/api/groups/g1/insights',5)).status,403);
});
test('完整汇总超过50人的群；每日相加，不丢同日成员，真实零与缺记录可区分',async t=>{
 const f=fixture(t,62),today=beijingDay(),yesterday=beijingDaysAgo(1);for(let i=1;i<=61;i++){f.join(i);f.seed(i,today,i===61?0:10,{cost:i<3?cost(0):null});}
 f.seed(1,yesterday,30,{tool:'Yesterday',model:'Yesterday'});
 const r=await f.req('/api/groups/g1/insights?period=week',1);assert.equal(r.data.summary.tokens,630);assert.equal(r.data.summary.reported_users,61);assert.equal(r.data.summary.active_users,60);assert.equal(r.data.summary.active_days,2);
 assert.equal(r.data.tools.items.find(x=>x.name==='Yesterday').preferred_users,1);assert.equal(r.data.tools.items.find(x=>x.name==='Tool').preferred_users,59);
 const days=r.data.models.daily;assert.equal(days.at(-1).tokens,600);assert.equal(days.at(-1).reported_users,61);assert.equal(days.at(-2).tokens,30);assert.equal(days.at(-3).tokens,null);assert.equal(days.at(-3).reported,false);
 assert.equal(r.data.cost.status,'partial');assert.equal(r.data.cost.usd_micros,0);assert.equal(r.data.cost.missing_user_days,59);assert.equal(r.data.cost.missing_days,2);
});
test('北京时间今日、7天、30天口径与趋势分开，无数据不虚构价格或偏好',async t=>{
 const f=fixture(t),now=Date.parse('2026-10-31T00:01:00+08:00');f.join(1);f.seed(1,'2026-10-24',99);f.seed(1,'2026-10-25',50);f.seed(1,'2026-10-30',0);f.seed(1,'2026-10-01',999);
 const day=(await loadGroupInsights(f.env,1,'g1','day',now)).report;assert.equal(day.summary.tokens,0);assert.equal(day.summary.reported_users,0);assert.equal(day.models.items.length,0);assert.equal(day.cost.usd_micros,null);assert.equal(day.models.daily.at(-1).tokens,null);assert.equal(day.models.daily.at(-2).tokens,0);
 assert.equal((await loadGroupInsights(f.env,1,'g1','week',now)).report.summary.tokens,50);assert.equal((await loadGroupInsights(f.env,1,'g1','month',now)).report.summary.tokens,149);
});
test('分享固定来源群聚合快照且可匿名读取；不接受客户端伪造数值，隐私变化立即撤销访问',async t=>{
 const f=fixture(t);f.join(1);f.join(2);f.seed(1,beijingDay(),100);f.seed(2,beijingDay(),200);
 const r=await f.req('/api/groups/g1/insights',1),url='/api/groups/g1/insights/share';
 assert.equal((await f.req(url,null,{period:'day',snapshot:r.data.snapshot})).status,401);assert.equal((await f.req(url,3,{period:'day',snapshot:r.data.snapshot})).status,403);
 assert.equal((await f.req(url,1,{period:'day',snapshot:'bad'})).status,409);
 const body={period:'day',snapshot:r.data.snapshot,report:{summary:{tokens:99999}},group_id:'foreign'},s=await f.req(url,1,body);
 assert.equal(s.status,200);assert.equal(s.data.style,'group-insights');assert.equal(s.data.report.summary.tokens,300);assert.equal(s.data.report.group.name,'群一');assert.equal((await f.req(url,1,body)).data.id,s.data.id);
 assert.doesNotMatch(JSON.stringify(s.data),/"(?:group_id|user_id|device_id|contributors|_group)"|secret/);
 const anon=await f.req('/api/shares/'+s.data.id);assert.deepEqual(anon.data,s.data);
 assert.equal((await f.req('/api/shares/'+s.data.id+'/compare',3,{})).status,400);
 f.seed(3,beijingDay(),999);assert.equal((await f.req('/api/shares/'+s.data.id)).data.report.summary.tokens,300);
 f.db.exec("UPDATE rank_group_members SET hidden=1 WHERE group_id='g1' AND user_id=2");assert.equal((await f.req('/api/shares/'+s.data.id)).status,404);
});
test('分享对退群/禁用/全站隐藏、撤销和过期生效，无参与人也不允许脱离创建者成员身份',async t=>{
 for(const mutation of ["DELETE FROM rank_group_members WHERE user_id=2","UPDATE users SET rank_hidden=1 WHERE id=2","UPDATE users SET disabled_at=1 WHERE id=2","DELETE FROM rank_group_members WHERE user_id=1"]){
  const f=fixture(t);f.join(1);f.join(2);f.seed(2,beijingDay(),1);const r=await f.req('/api/groups/g1/insights',1);const s=await f.req('/api/groups/g1/insights/share',1,{period:'day',snapshot:r.data.snapshot});f.db.exec(mutation);assert.equal((await f.req('/api/shares/'+s.data.id)).status,404);
 }
});

test('群快照撤销、过期不再公开；零记录群仍须创建者保持成员身份',async t=>{
 const f=fixture(t);f.join(1);const r=await f.req('/api/groups/g1/insights',1),body={period:'day',snapshot:r.data.snapshot};
 const a=await f.req('/api/groups/g1/insights/share',1,body);assert.equal(a.status,200);assert.equal(a.data.report.summary.tokens,0);
 assert.equal((await f.req('/api/shares/'+a.data.id+'/revoke',1,{})).status,200);assert.equal((await f.req('/api/shares/'+a.data.id)).status,404);
 const b=await f.req('/api/groups/g1/insights/share',1,body);f.db.prepare('UPDATE usage_shares SET expires_at=1 WHERE id=?').run(b.data.id);assert.equal((await f.req('/api/shares/'+b.data.id)).status,404);
 const c=await f.req('/api/groups/g1/insights/share',1,body);f.db.exec('DELETE FROM rank_group_members WHERE user_id=1');assert.equal((await f.req('/api/shares/'+c.data.id)).status,404);
});
