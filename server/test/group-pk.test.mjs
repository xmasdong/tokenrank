import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { beijingDay } from '../src/lib.js';

function fixture(t, count = 3) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
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
    db.prepare('INSERT INTO users(id,openid,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, 'private-' + id, '用户' + id, id + '.png');
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-' + id, id, Date.now() + 3600000);
  }
  db.exec("INSERT INTO rank_groups VALUES('g1','群榜',1,'real-group-hash',1)");
  for (let id = 1; id <= count; id++) if (id !== 3) db.prepare("INSERT INTO rank_group_members VALUES('g1',?,1,0)").run(id);
  function seed(uid, offset, tokens, device = 'selected') {
    const day = beijingDay(Date.now() + offset * 86400000);
    db.prepare('INSERT INTO daily_totals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(uid, device, day, tokens, 0, 0, tokens, 0, tokens ? 2 : 0,
      JSON.stringify([['M', tokens]]), JSON.stringify([['Codex', tokens]]), Date.now(), Date.now());
    db.prepare('INSERT OR IGNORE INTO usage_sync_state VALUES(?,?,?,?)').run(uid, 'selected', Date.now(), Date.now());
    return day;
  }
  const request = async (path, body = null, uid = 1) => {
    const response = await worker.fetch(new Request('https://rank.test' + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(uid ? { authorization: 'Bearer session-' + uid } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, data: await response.json() };
  };
  const board = async (period = 'day', uid = 1) => (await request('/api/leaderboard?scope=group&id=g1&period=' + period, null, uid)).data;
  const pk = (board, rank = 1, uid = 1) => request('/api/groups/g1/compare', { period: board.period, rank, snapshot: board.snapshot }, uid);
  return { db, seed, request, board, pk };
}

test('群榜 PK 与选中排名、周期、选定设备一致，只返回双人摘要且完全只读', async t => {
  const f = fixture(t); f.seed(1, 0, 100); f.seed(1, -1, 20); f.seed(2, 0, 300); f.seed(2, -1, 50);
  f.seed(2, 0, 99999, 'old'); f.seed(3, 0, 99999);
  const board = await f.board('week'), before = f.db.prepare('SELECT total_changes() AS n').get().n;
  const result = await f.pk(board);
  assert.equal(result.status, 200); assert.equal(result.data.transient, true);
  assert.equal(result.data.comparison.source.user.nickname, '用户2'); assert.equal(result.data.user.nickname, '用户1');
  assert.equal(result.data.comparison.source.usage.summary.tokens, 350); assert.equal(result.data.usage.summary.tokens, 120);
  assert.equal(result.data.comparison.source.usage.from, result.data.usage.from);
  assert.equal(result.data.usage.summary.active_days, 2); assert.equal(result.data.usage.token_basis, 'upstream_total');
  assert.doesNotMatch(JSON.stringify(result.data), /"id"|user_id|uid|openid|session|daily|cost_json|group_id/);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_shares').get().n, 0);
});

test('群榜 PK 拒绝未登录、非成员、缺资料、自比及伪造参数', async t => {
  const f = fixture(t); f.seed(1, 0, 100); f.seed(2, 0, 300);
  const board = await f.board();
  assert.equal((await f.pk(board, 1, null)).status, 401); assert.equal((await f.pk(board, 1, 3)).status, 403);
  assert.equal((await f.pk(board, 2)).data.code, 'SELF_COMPARISON');
  for (const patch of [{ rank: 0 }, { rank: '1' }, { rank: 1.2 }, { snapshot: 'fake' }, { period: 'custom' }])
    assert.equal((await f.request('/api/groups/g1/compare', { period: 'day', rank: 1, snapshot: board.snapshot, ...patch })).status, 400);
  f.db.exec('UPDATE users SET avatar_path=NULL WHERE id=1'); assert.equal((await f.pk(board)).status, 428);
});

test('榜单名次、资料或隐藏设置变更后旧 PK 入口失效，不会切换成另一位群友', async t => {
  for (const change of ["UPDATE daily_totals SET tokens=400 WHERE user_id=1", "UPDATE users SET nickname='新昵称' WHERE id=2",
    'UPDATE users SET rank_hidden=1 WHERE id=2', 'UPDATE rank_group_members SET hidden=1 WHERE user_id=2',
    'UPDATE users SET disabled_at=1 WHERE id=2']) {
    const f = fixture(t); f.seed(1, 0, 100); f.seed(2, 0, 300); const board = await f.board(); f.db.exec(change);
    const stale = await f.pk(board); assert.equal(stale.status, 409); assert.equal(stale.data.code, 'BOARD_CHANGED');
    assert.ok(!stale.data.comparison);
  }
});

test('无同期上报与真实零上报分开，累计用同一起止范围且保留缺头像的群友', async t => {
  const f = fixture(t); f.seed(2, 0, 300); f.seed(1, -8, 100);
  assert.equal((await f.pk(await f.board())).data.code, 'NO_PERIOD_USAGE');
  f.seed(1, 0, 0); let result = await f.pk(await f.board()); assert.equal(result.status, 200); assert.equal(result.data.usage.summary.tokens, 0);
  f.db.exec('UPDATE users SET nickname=NULL,avatar_path=NULL WHERE id=2');
  result = await f.pk(await f.board('all'));
  assert.equal(result.status, 200); assert.equal(result.data.comparison.source.user.avatar_url, null);
  assert.equal(result.data.usage.from, beijingDay(Date.now() - 8 * 86400000));
  assert.equal(result.data.usage.from, result.data.comparison.source.usage.from); assert.equal(result.data.usage.summary.tokens, 100);
});

test('群榜第 50 名之后也按完整名次定位，不能越过群边界选取广场用户', async t => {
  const f = fixture(t, 54); for (let id = 1; id <= 54; id++) f.seed(id, 0, 1000 - id);
  const board = await f.board(); assert.equal(board.entries.length, 50);
  const result = await f.pk(board, 52); assert.equal(result.status, 200);
  assert.equal(result.data.comparison.source.user.nickname, '用户53'); assert.equal(result.data.comparison.source.usage.summary.tokens, 947);
  assert.equal((await f.pk(board, 54)).status, 404);
});
