import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { beijingDay } from '../src/lib.js';
function fixture(t, count = 6) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); t.after(() => db.close());
  const env = { DB: { prepare(sql) {
    let values = [];
    const args = () => Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
    return { bind(...items) { values = items; return this; }, async first() { return db.prepare(sql).get(args()) || null; },
      async all() { return { results: db.prepare(sql).all(args()) }; }, async run() { return db.prepare(sql).run(args()); } };
  }, async batch(statements) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } };
  for (let id = 1; id <= count; id++) {
    db.prepare('INSERT INTO users(id,openid,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, 'private-openid-' + id, '用户' + id, id + '.png');
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-' + id, id, Date.now() + 3600000);
  }
  function seed(uid, offset, tokens, tools, models = [['M', tokens]], device = 'selected') {
    const day = beijingDay(Date.now() + offset * 86400000);
    db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid, device, day, tokens, 0, 0, tokens, 0, tokens ? 2 : 0,
      JSON.stringify(models), JSON.stringify(tools), Date.now(), Date.now());
    db.prepare('INSERT OR IGNORE INTO usage_sync_state VALUES(?,?,?,?)').run(uid, 'selected', Date.now(), Date.now());
    return day;
  }
  const request = async (path, uid = null, headers = {}) => {
    const response = await worker.fetch(new Request('https://rank.test' + path, { headers: { ...(uid ? { authorization: 'Bearer session-' + uid } : {}), ...headers } }), env);
    return { status: response.status, data: await response.json() };
  };
  return { db, env, seed, request };
}
function basic(t) {
  const f = fixture(t); f.seed(1, 0, 100, [['A',60],['B',20]], [['X',80],['Y',20]]); f.seed(2, 0, 100, [['A',10],['B',90]], [['Y',100]]);
  f.seed(3, 0, 10000, [['A',10000]]); f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=3');
  f.seed(4, 0, 10000, [['A',10000]]); f.db.exec('UPDATE users SET disabled_at=1 WHERE id=4');
  f.seed(5, 0, 10000, [['A',10000]]); f.db.exec('DELETE FROM usage_sync_state WHERE user_id=5');
  f.seed(1, 0, 99999, [['private-wrong-device',99999]], [['wrong-model',99999]], 'old');
  return f;
}
test('个人分析只读当前账号与选定设备，公开分布遵守隐藏和停用设置', async t => {
  const f = basic(t);
  assert.equal((await f.request('/api/my/analysis')).status, 401);
  const mine = await f.request('/api/my/analysis?user_id=2&period=day&dimension=tools', 1);
  assert.equal(mine.status, 200); assert.equal(mine.data.summary.tokens, 100); assert.equal(mine.data.scope, 'mine');
  const result = await f.request('/api/insights?period=day&dimension=tools');
  assert.equal(result.status, 200); assert.equal(result.data.summary.tokens, 200); assert.equal(result.data.summary.users, 2);
  const byName = Object.fromEntries(result.data.items.map(row => [row.name, row]));
  assert.equal(byName.A.tokens, 70); assert.equal(byName.A.users, 2); assert.equal(byName.A.preferred_users, 1); assert.equal(byName.A.percent, 35);
  assert.equal(byName.B.tokens, 110); assert.equal(byName.B.preferred_users, 1); assert.equal(byName['其他 / 未分类'].tokens, 20);
  assert.doesNotMatch(JSON.stringify(result.data), /openid|user_id|uid|session|private-wrong-device|nickname|avatar_path/);
  const board = await f.request('/api/leaderboard'); assert.equal(board.data.entries.reduce((sum,row)=>sum+row.tokens,0), result.data.summary.tokens);
  const models = await f.request('/api/insights?dimension=models');
  assert.equal(models.data.items.find(row=>row.name==='X').tokens,80); assert.equal(models.data.items.find(row=>row.name==='Y').tokens,120);
});
test('缺失分类保留缺口，未知份额最高时不猜测用户偏好', async t => {
  const f = basic(t); f.db.prepare('UPDATE daily_totals SET tools_json=? WHERE user_id=2').run(JSON.stringify([['A',10]]));
  const result = (await f.request('/api/insights')).data;
  assert.equal(result.items.find(row=>row.name==='A').preferred_users,1);
  assert.equal(result.items.find(row=>row.unclassified).preferred_users,1);
  assert.equal(result.items.reduce((sum,row)=>sum+row.preferred_users,0),result.summary.users);
  const users = await f.request('/api/insights/users?name=A');
  assert.equal(users.status,200); assert.deepEqual(users.data.entries.map(row=>row.nickname),['用户1']);
  assert.equal(users.data.entries[0].tokens,60); assert.equal(users.data.entries[0].percent,60);
  assert.doesNotMatch(JSON.stringify(users.data), /user_id|openid|avatar_path|session|"id"|uid/);
});
test('偏好按所选日期聚合，趋势包含各日真实公开样本，不把未同步补成零', async t => {
  const f = fixture(t); f.seed(1,0,100,[['A',40],['B',60]]); const yesterday=f.seed(1,-1,100,[['A',100]]);
  f.seed(2,-1,250,[['B',250]]); f.seed(1,-2,0,[]); f.seed(1,1,999,[['future',999]]);
  const day=(await f.request('/api/insights')).data, week=(await f.request('/api/insights?period=week')).data;
  assert.equal(day.items.find(row=>row.name==='B').preferred_users,1);
  assert.equal(week.items.find(row=>row.name==='A').preferred_users,1); assert.equal(week.summary.tokens,450);
  assert.equal(day.daily.find(row=>row.day===yesterday).tokens,350);
  assert.equal(day.daily.at(-3).reported,true); assert.equal(day.daily.at(-3).tokens,0);
  assert.equal(day.daily[0].reported,false); assert.equal(day.daily[0].tokens,null);
  assert.ok(!week.items.some(row=>row.name==='future'));
});
test('损坏或异常明细不使分析失败；重叠明细明确标记且占比归一', async t => {
  const f=fixture(t); f.seed(1,0,100,[]);
  for(const text of ['broken','["bad",1,null,[false,4],["negative",-5]]','{"not-an-array":["A",999]}']){
    f.db.prepare('UPDATE daily_totals SET tools_json=?').run(text);
    const result=await f.request('/api/insights'); assert.equal(result.status,200);
    assert.equal(result.data.items.find(row=>row.unclassified).tokens,100);
  }
  f.db.prepare('UPDATE daily_totals SET tools_json=?').run('[["A",200],"bad"]');
  const overlap=(await f.request('/api/insights')).data;
  assert.equal(overlap.summary.tokens,100); assert.equal(overlap.summary.breakdown_tokens,200); assert.equal(overlap.has_overlap,true);
  assert.equal(overlap.items[0].percent,100);
});
test('常用用户分页保持快照，隐私变化使旧页失效，身份和模型名不成为查询注入', async t => {
  const f=fixture(t,62);for(let id=1;id<=62;id++)f.seed(id,0,100+id,[['A',100+id]]);
  const first=await f.request('/api/insights/users?name=A'); assert.equal(first.status,200); assert.equal(first.data.entries.length,50); assert.equal(first.data.total,62);
  const url='/api/insights/users?name=A&offset=50&snapshot='+first.data.snapshot;
  const next=await f.request(url); assert.equal(next.data.entries.length,12); assert.equal(next.data.entries[0].rank,51);
  f.db.exec('UPDATE users SET rank_hidden=1 WHERE id=1'); assert.equal((await f.request(url)).status,409);
  assert.equal((await f.request('/api/insights/users?name=A&offset=50')).status,400);
  assert.equal((await f.request('/api/insights/users?name='+encodeURIComponent("A' OR 1=1"))).status,404);
  assert.equal((await f.request('/api/insights?dimension=tools_json')).status,400);
});
test('预留激励入口默认免费，未来未接验证器时拒绝客户端伪造解锁', async t => {
  const f=basic(t);assert.equal((await f.request('/api/insights/users?name=A')).status,200);
  for(const mode of ['rewarded','typo']){
    f.env.INSIGHTS_AUDIENCE_ACCESS=mode;
    const denied=await f.request('/api/insights/users?name=A&unlocked=1',1,{'x-insight-grant':'client-made-up'});
    assert.equal(denied.status,403);assert.equal(denied.data.code,'INSIGHT_ACCESS_REQUIRED');
    assert.equal((await f.request('/api/insights')).status,200);
    assert.equal((await f.request('/api/my/analysis',1)).status,200);
  }
});
test('分析及常用用户查询只读，不创建账号、不修改或清理现有用量', async t => {
  const f=basic(t);const tables=['users','daily_totals','usage_sync_state','usage_shares','mp_sessions'];
  const before=tables.map(table=>f.db.prepare('SELECT * FROM '+table).all());
  for(const period of ['day','week','month','all'])for(const dimension of ['tools','models']){
    assert.equal((await f.request(`/api/insights?period=${period}&dimension=${dimension}`)).status,200);
    assert.equal((await f.request(`/api/my/analysis?period=${period}&dimension=${dimension}`,1)).status,200);
  }
  await f.request('/api/insights/users?name=A');tables.forEach((table,i)=>assert.deepEqual(f.db.prepare('SELECT * FROM '+table).all(),before[i]));
});
