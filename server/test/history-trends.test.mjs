import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { beijingDay } from '../src/lib.js';
import { addDays, calendarMonth, calendarReport, weeklyRange, weeklyReport, buildWeekly, mondayOf, dailyReport, buildDaily } from '../src/history.js';
import { trendQuery, trendReport } from '../src/trends.js';
function fixture(t, count = 6) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); t.after(() => db.close());
  const env = { DB: { prepare(sql) {
    let values = []; const args = () => Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
    return { bind(...items) { values = items; return this; }, async first() { return db.prepare(sql).get(args()) || null; },
      async all() { return { results: db.prepare(sql).all(args()) }; }, async run() { return db.prepare(sql).run(args()); } };
  }, async batch(statements) {
    db.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } };
  for (let uid = 1; uid <= count; uid++) {
    db.prepare('INSERT INTO users(id,openid,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(uid, 'private-' + uid, '用户' + uid, uid + '.png');
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-' + uid, uid, Date.now() + 3600000);
  }
  function seed(uid, day, tokens, { device = 'selected', tools = [['A', tokens]], models = [['M', tokens]] } = {}) {
    db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid, device, day, tokens, 0, 0, tokens, 0, tokens ? 2 : 0, JSON.stringify(models), JSON.stringify(tools), 1, 1);
    db.prepare('INSERT OR IGNORE INTO usage_sync_state VALUES(?,?,1,1)').run(uid, 'selected');
  }
  async function request(path, uid = null, body = null) {
    const response = await worker.fetch(new Request('https://rank.test' + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(uid ? { authorization: 'Bearer session-' + uid } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, data: await response.json() };
  }
  return { db, env, seed, request };
}
const fixed = Date.parse('2026-10-16T10:00:00+08:00');
test('日历及自然周按北京时间，闰月和跨年边界正确，未来与无效日期不回退伪造周期', () => {
  assert.equal(calendarMonth('', Date.parse('2026-09-30T16:01:00Z')).month, '2026-10');
  assert.equal(calendarMonth('2024-02', fixed).end, '2024-02-29');
  for (const month of ['2026-13','2026-1','2026-11','2025-02-30']) assert.equal(calendarMonth(month, fixed), null);
  assert.equal(weeklyRange('', fixed).from, '2026-10-05'); assert.equal(weeklyRange('', fixed).through, '2026-10-11');
  assert.equal(weeklyRange('2026-10-12', fixed).through, '2026-10-16'); assert.equal(weeklyRange('2026-10-12', fixed).complete, false);
  assert.equal(weeklyRange('', Date.parse('2026-01-04T16:01:00Z')).from, '2025-12-29');
  for (const date of ['2026-10-06','2026-10-19','2026-02-30','invalid']) assert.equal(weeklyRange(date, fixed), null);
});
test('日历只读本账号选中设备，零上报、缺记录、未来日期分开；隐藏排名不隐藏自己的数据', async t => {
  const f = fixture(t); f.seed(1,'2026-10-01',0); f.seed(1,'2026-10-03',258000000); f.seed(1,'2026-10-17',999999);
  f.seed(2,'2026-10-03',999999); f.seed(1,'2026-10-03',999999,{device:'old'}); f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=1');
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const result = await (await calendarReport(f.env,1,'2026-10',fixed)).json();
  assert.equal(result.summary.tokens,258000000); assert.equal(result.summary.reported_days,2); assert.equal(result.summary.active_days,1);
  assert.deepEqual(result.daily[0],{day:'2026-10-01',reported:true,future:false,tokens:0,requests:0});
  assert.equal(result.daily[1].tokens,null); assert.equal(result.daily[1].reported,false); assert.equal(result.daily[16].future,true); assert.equal(result.daily[16].tokens,null);
  assert.equal(result.next_month,null); assert.equal(result.previous_month,'2026-09');
  const empty = await (await calendarReport(f.env,1,'2026-09',fixed)).json(); assert.equal(empty.summary.tokens,null);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal((await f.request('/api/my/calendar')).status,401);
  assert.equal((await f.request('/api/my/calendar?month=bad',1)).status,400);
  const own = await f.request('/api/my/calendar?month=2026-10&user_id=2',1); assert.equal(own.data.summary.tokens >= 258000000,true);
});
test('周报精确聚合完整自然周，真实零日参与覆盖，环比只在双方七天记录齐全时计算', () => {
  const range=weeklyRange('2026-10-05',fixed), rows=[];
  for(let i=0;i<14;i++) rows.push({day:addDays('2026-09-28',i),tokens:i<7?100:i===7?0:200,requests:i===7?0:2,tools_json:'[["A",100]]',models_json:'[["M",100]]',updated_at:1});
  const report=buildWeekly(rows,range); assert.equal(report.summary.tokens,1200); assert.equal(report.weekly.previous_tokens,700);
  assert.equal(report.from,'2026-10-05'); assert.equal(report.to,'2026-10-11'); assert.equal(report.weekly.change_tokens,500); assert.equal(report.weekly.change_percent,71.4);
  assert.equal(report.weekly.reported_days,7); assert.equal(report.summary.active_days,6); assert.equal(report.weekly.peak.day,'2026-10-06'); assert.equal(report.weekly.top_model.name,'M');
  assert.equal(buildWeekly(rows.slice(1),range).weekly.comparison_status,'incomplete'); assert.equal(buildWeekly(rows.slice(1),range).weekly.change_tokens,null);
  const zero=buildWeekly(rows.map(row=>({...row,tokens:row.day<range.from?0:row.tokens})),range);
  assert.equal(zero.weekly.comparison_status,'zero_base'); assert.equal(zero.weekly.change_percent,null); assert.equal(zero.weekly.change_tokens,1200);
  const current=buildWeekly([{...rows[0],day:'2026-10-12'}],weeklyRange('2026-10-12',fixed));
  assert.equal(current.weekly.comparison_status,'ongoing'); assert.equal(current.daily.at(-1).future,true); assert.equal(current.daily.at(-1).tokens,null);
});
test('周报分享从服务器生成快照，保留所选周的群成绩，不泄露私有日明细；旧版本与非成员被拒绝', async t => {
  const f=fixture(t), start=weeklyRange().from;
  for(let i=0;i<14;i++) { f.seed(1,addDays(start,i-7),100); f.seed(2,addDays(start,i-7),200); }
  f.db.exec("INSERT INTO rank_groups VALUES('g1','周报群',1,'real-group',1); INSERT INTO rank_group_members VALUES('g1',1,1,0),('g1',2,1,0)");
  const report=await f.request('/api/my/weekly',1); assert.equal(report.status,200); assert.equal(report.data.groups[0].id,'g1');
  assert.equal((await f.request('/api/my/weekly')).status,401);
  const payload={style:'weekly',week:start,week_snapshot:report.data.snapshot,group_id:'g1',tokens:999999};
  const shared=await f.request('/api/shares',1,payload); assert.equal(shared.status,200); assert.equal(shared.data.style,'weekly'); assert.equal(shared.data.usage.summary.tokens,700);
  assert.equal(shared.data.usage.group_standing.rank,2); assert.equal(shared.data.usage.group_standing.participants,2); assert.equal(shared.data.usage.weekly.reported_days,7);
  assert.doesNotMatch(JSON.stringify(shared.data), /user_id|openid|session|device_id|daily|group_id|groups|input_tokens|cost_json|week_snapshot/);
  assert.equal((await f.request('/api/shares',1,payload)).data.id,shared.data.id);
  const publicRecord=await f.request('/api/shares/'+shared.data.id); assert.deepEqual(publicRecord.data,shared.data);
  assert.equal((await f.request('/api/shares',1,{...payload,group_id:'foreign'})).status,403);
  const sharesBefore=f.db.prepare('SELECT COUNT(*) n FROM usage_shares').get().n;
  f.db.exec('UPDATE daily_totals SET tokens=101,updated_at=2 WHERE user_id=1');
  const stale=await f.request('/api/shares',1,payload); assert.equal(stale.status,409); assert.equal(stale.data.code,'WEEK_CHANGED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_shares').get().n,sharesBefore);
  const oldPublic=await f.request('/api/shares/'+shared.data.id); assert.equal(oldPublic.data.usage.summary.tokens,700);
});
test('未上报周不生成空周报，旧协议要求更新，私有日历周报 GET 不改变任何现存表', async t => {
  const f=fixture(t); f.seed(1,beijingDay(),100);
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  await f.request('/api/my/calendar',1); const week=await f.request('/api/my/weekly',1); assert.equal(week.data.has_history,false);
  await f.request('/api/insights/trends'); assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal((await f.request('/api/shares',1,{style:'weekly',week:week.data.from,week_snapshot:week.data.snapshot})).status,400);
  f.db.exec("INSERT INTO daily_stats VALUES(3,'2026-10-01',100,0,0,1,'[]','[]',1)");
  assert.equal((await f.request('/api/my/calendar',3)).status,409); assert.equal((await f.request('/api/my/weekly',3)).status,409);
});
test('趋势区间为截至昨日完整的相邻7/30天；分享固定结束日，非法参数拒绝', () => {
  const query = qs => trendQuery(new URL('https://rank.test?'+qs),fixed);
  const q=query(''); assert.equal(q.from,'2026-10-09'); assert.equal(q.end,'2026-10-15'); assert.equal(q.previous_from,'2026-10-02'); assert.equal(q.previous_to,'2026-10-08');
  const month=query('period=month'); assert.equal(month.from,'2026-09-16'); assert.equal(month.previous_to,'2026-09-15');
  for(const qs of ['end=2026-10-16','end=2026-02-30','period=day','dimension=sql','metric=preferred_users','offset=50','offset=-1','end=bad']) assert.equal(query(qs),null,qs);
  assert.equal(query('end=2026-10-10').end,'2026-10-10');
});
test('趋势排名按每项使用人数去重及Token双口径，排除隐藏、停用、未初始化与非当前设备；上期缺记录不伪造增长', async t => {
  const f=fixture(t), end=addDays(beijingDay(),-1), old=addDays(end,-7);
  f.seed(1,end,100,{tools:[['A',10],['B',90]],models:[['X',100]]}); f.seed(1,addDays(end,-1),100,{tools:[['A',100]]});
  f.seed(2,end,500,{tools:[['B',500],['C',1]],models:[['Y',500]]}); f.seed(1,old,200,{tools:[['A',200]]}); f.seed(2,old,800,{tools:[['B',800]]});
  f.seed(3,end,99999); f.seed(4,end,99999); f.seed(5,end,99999); f.seed(1,end,99999,{device:'old',tools:[['private-device',99999]]});
  f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=3; UPDATE users SET disabled_at=1 WHERE id=4; DELETE FROM usage_sync_state WHERE user_id=5');
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  const people=(await f.request('/api/insights/trends')).data;
  assert.equal(people.summary.tokens,700); assert.equal(people.summary.users,2); assert.equal(people.entries[0].name,'B'); assert.equal(people.entries[0].users,2);
  assert.equal(people.entries.find(row=>row.name==='A').users,1); assert.equal(people.entries.find(row=>row.name==='C').previous_rank,null);
  assert.equal(people.entries.find(row=>row.name==='C').value_change,null); assert.ok(!people.entries.some(row=>row.name==='private-device'));
  assert.doesNotMatch(JSON.stringify(people),/uid|user_id|nickname|avatar|openid|session|device/);
  assert.equal((await f.request('/api/insights/trends?metric=tokens')).data.entries[0].tokens,590);
  const models=(await f.request('/api/insights/trends?dimension=models')).data; assert.equal(models.entries[0].name,'Y'); assert.equal(models.summary.tokens,700);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
test('趋势工具及模型分别计算位次变化，两期样本数独立、不包含今日未完成记录', async t => {
  const f=fixture(t), end=addDays(beijingDay(),-1), old=addDays(end,-7);
  f.seed(1,end,100,{tools:[['A',100]],models:[['X',100]]}); f.seed(2,end,100,{tools:[['A',100]],models:[['X',100]]});
  f.seed(1,old,100,{tools:[['A',1],['B',99]],models:[['X',1],['Y',99]]}); f.seed(1,beijingDay(),99999,{tools:[['TODAY',99999]]});
  for(const dimension of ['tools','models']) { const r=(await f.request('/api/insights/trends?metric=tokens&dimension='+dimension)).data;
    assert.equal(r.summary.users,2); assert.equal(r.previous_summary.users,1); assert.equal(r.entries[0].rank_change,1); assert.equal(r.entries[0].value_change,199); assert.equal(r.entries.length,1); }
});
test('趋势多页使用同一快照，隐私或上报变化拒绝旧页；损坏明细不会中断查询', async t => {
  const f=fixture(t), end=addDays(beijingDay(),-1);
  for(let i=0;i<8;i++)f.seed(1,addDays(end,-i%7),100,{tools:Array.from({length:8},(_,j)=>['T'+(i*8+j),1]),device:i===7?'old':'selected'});
  // 7 retained days × 8 named items gives a genuine 56-item aggregate.
  const first=(await f.request('/api/insights/trends')).data; assert.equal(first.entries.length,50); assert.equal(first.total,56);
  const path='/api/insights/trends?end='+first.to+'&offset=50&snapshot='+first.snapshot;
  const next=await f.request(path); assert.equal(next.status,200); assert.equal(next.data.entries.length,6); assert.equal(next.data.entries[0].rank,51);
  f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=1'); assert.equal((await f.request(path)).status,409);
  f.db.exec('UPDATE users SET rank_hidden=0 WHERE id=1');
  for(const text of ['broken','["bad",1,null,[false,4],["negative",-5]]','{"not":"array"}']) {
    f.db.prepare('UPDATE daily_totals SET tools_json=?').run(text); const r=await f.request('/api/insights/trends'); assert.equal(r.status,200); assert.equal(r.data.entries.length,0); assert.equal(r.data.summary.tokens,700);
  }
});

test('日报固定已经结束的北京时间日期，真实工具模型和含缓存总量只取本人选中设备',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-15',258000000);f.seed(1,'2026-10-15',9999,{device:'old'});f.seed(2,'2026-10-15',9999);f.seed(1,'2026-10-16',9999);
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 const report=await (await dailyReport(f.env,1,'',fixed)).json();assert.equal(report.day,'2026-10-15');assert.equal(report.summary.tokens,258000000);assert.equal(report.summary.requests,2);
 assert.equal(report.top_tool.name,'A');assert.equal(report.top_model.name,'M');assert.equal(report.models[0].tokens,258000000);assert.equal(report.previous_day,null);assert.equal(report.next_day,null);assert.equal(report.daily.length,1);
 f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=1');assert.equal((await (await dailyReport(f.env,1,'2026-10-15',fixed)).json()).summary.tokens,258000000);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before+1);
});
test('日报缺记录用null，真实零用量用0；不将今天或无效日期当成昨日',async t=>{
 const f=fixture(t);f.seed(1,'2026-10-14',0);
 const zero=await (await dailyReport(f.env,1,'2026-10-14',fixed)).json();assert.equal(zero.has_history,true);assert.equal(zero.summary.tokens,0);assert.equal(zero.summary.requests,0);assert.equal(zero.next_day,'2026-10-15');
 const missing=await (await dailyReport(f.env,1,'2026-10-15',fixed)).json();assert.equal(missing.has_history,false);assert.equal(missing.summary.tokens,null);assert.equal(missing.summary.requests,null);assert.equal(missing.top_tool,null);
 for(const day of ['2026-10-16','2026-10-17','2026-02-30','invalid'])assert.equal((await dailyReport(f.env,1,day,fixed)).status,400);
});
test('日报接口要求本人会话，保留旧统计口径更新提示',async t=>{
 const f=fixture(t);assert.equal((await f.request('/api/my/daily?day=2026-10-15')).status,401);
 f.seed(1,'2026-10-15',100);assert.equal((await f.request('/api/my/daily?day=2026-10-15',1)).data.summary.tokens,100);
 f.db.prepare("INSERT INTO daily_stats(user_id,day,tokens,updated_at) VALUES(3,'2026-10-15',99,1)").run();assert.equal((await dailyReport(f.env,3,'2026-10-15',fixed)).status,409);
});
