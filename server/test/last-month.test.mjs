import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { usageWindow, buildUsage } from '../src/usage.js';
import { trendQuery } from '../src/trends.js';

const at = date => Date.parse(date + 'T12:00:00+08:00');
test('上个月是完整北京时间自然月，覆盖大小月、闰年、跨年及月初边界', () => {
  for (const [date, from, to, days] of [
    ['2026-11-15','2026-10-01','2026-10-31',31],['2026-10-01','2026-09-01','2026-09-30',30],
    ['2026-03-31','2026-02-01','2026-02-28',28],['2028-03-01','2028-02-01','2028-02-29',29],
    ['2027-01-01','2026-12-01','2026-12-31',31],
  ]) assert.deepEqual(usageWindow('last_month',at(date)),{period:'last_month',from,to,trendDays:days});
  assert.equal(usageWindow('last_month',Date.parse('2026-10-31T15:59:59Z')).to,'2026-09-30');
  assert.equal(usageWindow('last_month',Date.parse('2026-10-31T16:00:00Z')).to,'2026-10-31');
  assert.equal(usageWindow('month',at('2026-11-15')).from,'2026-10-17');
});

function fixture(t) {
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
  const env={DB:{prepare(sql){let values=[];const args=()=>Object.fromEntries(values.map((v,i)=>[String(i+1),v]));return{
    bind(...v){values=v;return this;},async first(){return db.prepare(sql).get(args())||null;},async all(){return{results:db.prepare(sql).all(args())};},
    async run(){const r=db.prepare(sql).run(args());return{meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  };},async batch(stmts){const out=[];for(const s of stmts)out.push(await s.all());return out;}}};
  for(const id of [1,2]){
    db.prepare('INSERT INTO users(id,openid,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id,'private-'+id,'用户'+id,id+'.png');
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+id,id,Date.parse('2099-01-01'));
    db.prepare('INSERT INTO usage_sync_state VALUES(?,?,1,1)').run(id,'selected');
  }
  db.exec("INSERT INTO rank_groups VALUES('g1','自然月测试群',1,'private-group-id',1);INSERT INTO rank_group_members VALUES('g1',1,1,0),('g1',2,1,0)");
  function seed(uid,day,tokens,usd=0,device='selected'){
    const cost=JSON.stringify({basis:'token_watcher_api_estimate',currency:'USD',usd_micros:usd,models:[['M',usd]],unpriced_models:[],unpriced_tokens:0});
    db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,cost_json,tool_models_json,source_at,updated_at) VALUES(?,?,?,?,0,0,?,0,1,?,?,?,?,1,1)')
      .run(uid,device,day,tokens,tokens,JSON.stringify([['M',tokens]]),JSON.stringify([['Codex',tokens]]),cost,JSON.stringify([['Codex','M',tokens]]));
  }
  for(const id of [1,2]){seed(id,'2026-09-30',99999);seed(id,'2026-10-01',id===1?100:150,1000000);seed(id,'2026-10-31',id===1?200:250,2000000);seed(id,'2026-11-01',id===1?900:3);seed(id,'2026-10-01',999999,0,'old-device');}
  async function req(path,uid=1,body=null){const r=await worker.fetch(new Request('https://rank.test'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(uid?{authorization:'Bearer session-'+uid}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);return{status:r.status,data:await r.json()};}
  return{db,env,req};
}

test('个人、群榜、广场及两维度分析按同一个上月区间读取，保留31日趋势和估算金额', async t => {
  t.mock.method(Date,'now',()=>at('2026-11-15'));const f=fixture(t);
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  const personal=await f.req('/api/my/usage?period=last_month');assert.equal(personal.status,200);
  assert.equal(personal.data.from,'2026-10-01');assert.equal(personal.data.to,'2026-10-31');assert.equal(personal.data.summary.tokens,300);assert.equal(personal.data.cost.usd_micros,3000000);
  assert.equal(personal.data.daily.length,31);assert.equal(personal.data.daily[0].tokens,100);assert.equal(personal.data.daily.at(-1).tokens,200);assert.equal(personal.data.reported_days,2);
  assert.equal((await f.req('/api/my/usage?period=month')).data.summary.tokens,1100);
  for(const scope of ['global','group&id=g1']){const b=await f.req('/api/leaderboard?scope='+scope+'&period=last_month');assert.equal(b.status,200);assert.equal(b.data.period,'last_month');assert.deepEqual(b.data.entries.map(x=>x.tokens),[400,300]);assert.equal(b.data.me.tokens,300);}
  const ranking=await f.req('/api/my/rankings?period=last_month');assert.equal(ranking.data.global.tokens,300);assert.equal(ranking.data.groups[0].my_rank,2);
  for(const route of ['/api/my/analysis?','/api/insights?'])for(const dimension of ['tools','models']){
    const a=await f.req(route+'period=last_month&dimension='+dimension);assert.equal(a.status,200);assert.equal(a.data.from,'2026-10-01');assert.equal(a.data.to,'2026-10-31');assert.equal(a.data.summary.tokens,route.includes('/my/')?300:700);assert.equal(a.data.daily.length,31);assert.equal(a.data.daily[0].day,'2026-10-01');assert.equal(a.data.daily.at(-1).day,'2026-10-31');
  }
  const joint=await f.req('/api/my/analysis?period=last_month&dimension=models&tool=Codex');assert.equal(joint.status,200);assert.equal(joint.data.summary.tokens,300);assert.equal(joint.data.items[0].name,'M');assert.equal(joint.data.daily.length,31);
  const g=await f.req('/api/groups/g1/insights?period=last_month');assert.equal(g.status,200);assert.equal(g.data.summary.tokens,700);assert.equal(g.data.cost.usd_micros,6000000);assert.equal(g.data.models.daily.length,31);assert.equal(g.data.models.daily[0].tokens,250);assert.equal(g.data.models.daily.at(-1).tokens,450);assert.equal(g.data.models.daily[1].tokens,null);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('上月个人分享、账单、工具及群快照保留原月份；跨月查看和PK不会变成另一个月',async t=>{
  let now=at('2026-11-15');t.mock.method(Date,'now',()=>now);const f=fixture(t);
  for(const style of ['usage','receipt','tools']){
    const s=await f.req('/api/shares',1,{period:'last_month',style,group_id:'g1'});assert.equal(s.status,200);assert.equal(s.data.usage.summary.tokens,300);assert.equal(s.data.usage.from,'2026-10-01');assert.equal(s.data.usage.to,'2026-10-31');assert.equal(s.data.usage.group_standing.rank,2);
    if(style==='receipt')assert.equal(s.data.usage.cost.usd_micros,3000000);
    now=at('2026-12-15');const opened=await f.req('/api/shares/'+s.data.id,null);assert.equal(opened.data.usage.from,'2026-10-01');assert.equal(opened.data.usage.summary.tokens,300);
    const compared=await f.req('/api/shares/'+s.data.id+'/compare',2,{});assert.equal(compared.status,200);assert.equal(compared.data.usage.summary.tokens,400);assert.equal(compared.data.usage.from,'2026-10-01');assert.equal(compared.data.usage.to,'2026-10-31');
    now=at('2026-11-15');
  }
  const g=await f.req('/api/groups/g1/insights?period=last_month');const s=await f.req('/api/groups/g1/insights/share',1,{period:'last_month',snapshot:g.data.snapshot});assert.equal(s.status,200);
  now=at('2026-12-15');const opened=await f.req('/api/shares/'+s.data.id,null);assert.equal(opened.data.report.from,'2026-10-01');assert.equal(opened.data.report.to,'2026-10-31');assert.equal(opened.data.report.summary.tokens,700);
  now=at('2026-11-15');const board=(await f.req('/api/leaderboard?scope=group&id=g1&period=last_month')).data;
  const pk=await f.req('/api/groups/g1/compare',1,{period:'last_month',rank:1,snapshot:board.snapshot});assert.equal(pk.status,200);assert.equal(pk.data.usage.summary.tokens,300);assert.equal(pk.data.comparison.source.usage.summary.tokens,400);assert.equal(pk.data.usage.from,'2026-10-01');
});

test('上月趋势榜比较两个完整自然月，长短不同仍按月对齐；历史分享支持固定月末',async t=>{
  t.mock.method(Date,'now',()=>at('2026-11-15'));const q=end=>trendQuery(new URL('https://rank.test/?period=last_month'+(end?'&end='+end:'')));
  assert.deepEqual([q().from,q().end,q().previous_from,q().previous_to],['2026-10-01','2026-10-31','2026-09-01','2026-09-30']);assert.equal(q('2026-10-30'),null);
  const leap=trendQuery(new URL('https://rank.test/?period=last_month'),at('2028-03-01'));assert.equal(leap.from,'2028-02-01');assert.equal(leap.end,'2028-02-29');assert.equal(leap.previous_from,'2028-01-01');
  const f=fixture(t);const r=await f.req('/api/insights/trends?period=last_month&metric=tokens');assert.equal(r.status,200);assert.equal(r.data.summary.tokens,700);assert.equal(r.data.previous_summary.tokens,199998);
  const fixed=buildUsage([{day:'2026-10-01',tokens:5}], 'last_month',at('2026-12-15'),{from:'2026-10-01',to:'2026-10-31'});assert.equal(fixed.summary.tokens,5);assert.equal(fixed.daily.length,31);
});
