import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { subscriptionFigures, normalizeSubscription, SUBSCRIPTION_LIMIT } from '../src/subscriptions.js';
import { beijingDay, beijingDaysAgo } from '../src/lib.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  function prepare(sql) {
    let args = [];
    const params = () => Object.fromEntries(args.map((value, i) => [String(i + 1), value]));
    return { bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(params()) ?? null; },
      async all() { return { results: db.prepare(sql).all(params()) }; },
      async run() { return { meta: { changes: db.prepare(sql).run(params()).changes } }; } };
  }
  const env = { DB: { prepare } };
  for (const id of [1, 2]) {
    db.prepare('INSERT INTO users(id,openid,created_at,updated_at) VALUES(?,?,1,1)').run(id, 'private-' + id);
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-' + id, id, Date.now() + 86400000);
  }
  const request = (method = 'GET', body, token = 'session-1', path = '/api/subscriptions') => worker.fetch(new Request('https://rank.test' + path, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env);
  return { db, env, request };
}
const claude = (extra = {}) => ({ name: 'Claude', plan: 'Max', price: 100, currency: 'USD', cycle: 'month', start_day: beijingDaysAgo(40), ...extra });

test('每天成本、月均、年均和累计花费按周期换算；续费当天计入新一期，未来开始不计费', () => {
  const sub = { price_minor: 2000, cycle: 'month', custom_days: null, start_day: '2026-09-21', status: 'active', ended_day: null };
  assert.deepEqual(subscriptionFigures(sub, '2026-10-20'), { cycle_days: 30, daily_minor: 66.67, monthly_minor: 2029, yearly_minor: 24333,
    paid_periods: 1, spent_minor: 2000, next_renewal_day: '2026-10-21' });
  const renewed = subscriptionFigures(sub, '2026-10-21');
  assert.equal(renewed.paid_periods, 2); assert.equal(renewed.spent_minor, 4000); assert.equal(renewed.next_renewal_day, '2026-11-20');
  const stopped = subscriptionFigures({ ...sub, status: 'cancelled', ended_day: '2026-10-01' }, '2026-12-01');
  assert.equal(stopped.spent_minor, 2000); assert.equal(stopped.next_renewal_day, null);
  assert.equal(subscriptionFigures({ ...sub, cycle: 'custom', custom_days: 10, price_minor: 900 }, '2026-10-20').daily_minor, 90);
  assert.equal(subscriptionFigures({ ...sub, start_day: '2026-11-01' }, '2026-10-20').spent_minor, 0);
});

test('拒绝空名称、非数字或越界价格、未知币种与周期、未来开始日和停用日早于开始日', () => {
  const today = '2026-10-21', ok = { name: ' Cursor ', price: 19.99, currency: 'USD', cycle: 'month', start_day: '2026-10-01' };
  const { value } = normalizeSubscription(ok, today);
  assert.equal(value.name, 'Cursor'); assert.equal(value.price_minor, 1999); assert.equal(value.status, 'active'); assert.equal(value.ended_day, null);
  for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { price: 0 }, { price: '20' }, { price: 2e6 }, { currency: 'EUR' }, { cycle: 'daily' },
    { cycle: 'custom' }, { cycle: 'custom', custom_days: 0 }, { start_day: '2026-10-22' }, { start_day: '2026-02-30' },
    { status: 'cancelled', ended_day: '2026-09-01' }, { status: 'gone' }, { notes: 'x'.repeat(101) }]) {
    assert.ok(normalizeSubscription({ ...ok, ...bad }, today).error, JSON.stringify(bad));
  }
  assert.equal(normalizeSubscription({ ...ok, status: 'paused' }, today).value.ended_day, today);
  assert.equal(normalizeSubscription(null, today).error, '订阅内容格式有误');
});

test('仅本人读写自己的订阅；他人无法修改或删除，汇总按币种分开', async t => {
  const f = fixture(t);
  assert.equal((await f.request('GET', undefined, null)).status, 401);
  let res = await f.request('POST', claude());
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.items.length, 1); assert.equal(data.items[0].price_minor, 10000); assert.equal(data.items[0].paid_periods, 2);
  res = await f.request('POST', { name: '通义灵码', price: 59, currency: 'CNY', cycle: 'month', start_day: beijingDay() });
  data = await res.json();
  assert.deepEqual(data.summary.currencies.map(c => [c.currency, c.active_count, c.monthly_minor]), [['CNY', 1, 5987], ['USD', 1, 10147]]);
  const id = data.items.find(i => i.currency === 'USD').id;
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.deepEqual((await (await f.request('GET', undefined, 'session-2')).json()).items, []);
  assert.equal((await f.request('POST', claude({ price: 1 }), 'session-2', '/api/subscriptions/' + id)).status, 404);
  assert.equal((await f.request('DELETE', undefined, 'session-2', '/api/subscriptions/' + id)).status, 404);
  data = await (await f.request('POST', claude({ status: 'cancelled' }), 'session-1', '/api/subscriptions/' + id)).json();
  const cancelled = data.items.find(i => i.id === id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.ended_day, beijingDay()); assert.equal(data.summary.inactive_count, 1);
  assert.equal(data.summary.currencies.find(c => c.currency === 'USD').active_count, 0);
  data = await (await f.request('DELETE', undefined, 'session-1', '/api/subscriptions/' + id)).json();
  assert.equal(data.items.length, 1);
  assert.equal((await f.request('POST', 'not json')).status, 400);
  assert.equal((await f.request('POST', { ...claude(), notes: 'x'.repeat(3000) })).status, 413);
  assert.equal((await f.request('PUT', claude())).status, 405);
});

test('超过上限返回 409；停用账号不能写入', async t => {
  const f = fixture(t);
  for (let i = 0; i < SUBSCRIPTION_LIMIT; i++) assert.equal((await f.request('POST', claude({ name: 'S' + i }))).status, 200);
  const res = await f.request('POST', claude());
  assert.equal(res.status, 409); assert.equal((await res.json()).code, 'SUBSCRIPTION_LIMIT');
  f.db.prepare('UPDATE users SET disabled_at=1 WHERE id=2').run();
  assert.equal((await f.request('POST', claude(), 'session-2')).status, 403);
});

test('近 30 天 API 等值估算只和美元订阅月费比较，没有费用数据时不给倍数', async t => {
  const f = fixture(t);
  let data = await (await f.request('POST', claude({ price: 200 }))).json();
  assert.equal(data.value.ratio, null); assert.equal(data.value.usd_monthly_minor, 20293);
  f.db.prepare('INSERT INTO usage_sync_state VALUES(1,?,1,1)').run('device-1');
  const cost = { basis: 'token_watcher_api_estimate', currency: 'USD', usd_micros: 1_294_610_000, models: [['claude-opus-5-5', 1_294_610_000]], unpriced_models: [], unpriced_tokens: 0 };
  f.db.prepare(`INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at,cost_json)
    VALUES(1,'device-1',?,1000,10,10,980,0,5,'[]','[]',1,1,?)`).run(beijingDay(), JSON.stringify(cost));
  f.db.prepare(`INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at,cost_json)
    VALUES(1,'device-1',?,1000,10,10,980,0,5,'[]','[]',1,1,?)`).run(beijingDaysAgo(40), JSON.stringify(cost));
  data = await (await f.request('GET')).json();
  assert.equal(data.value.api_usd_micros, 1_294_610_000); assert.equal(data.value.ratio, 6.4); assert.equal(data.value.from, beijingDaysAgo(29));
  await f.request('POST', { name: 'Kimi', price: 199, currency: 'CNY', cycle: 'month', start_day: beijingDay() });
  assert.equal((await (await f.request('GET')).json()).value.ratio, 6.4);
});

test('近 7 天每天的 API 等值和是否回本；按厂商归属今天的价值，Cursor 这类多模型工具不归属', async t => {
  const f = fixture(t);
  await f.request('POST', claude({ price: 200 }));
  await f.request('POST', { name: 'Cursor', plan: 'Pro', price: 20, currency: 'USD', cycle: 'month', start_day: beijingDaysAgo(3) });
  f.db.prepare('INSERT INTO usage_sync_state VALUES(1,?,1,1)').run('device-1');
  const day = (d, models) => {
    const total = models.reduce((a, [, m]) => a + m, 0);
    const cost = { basis: 'token_watcher_api_estimate', currency: 'USD', usd_micros: total, models, unpriced_models: [], unpriced_tokens: 0 };
    f.db.prepare(`INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at,cost_json)
      VALUES(1,'device-1',?,1000,10,10,980,0,5,'[]','[]',1,1,?)`).run(d, JSON.stringify(cost));
  };
  day(beijingDay(), [['claude-opus-5-5', 30_000_000], ['gpt-6.1-sol', 5_000_000]]);
  day(beijingDaysAgo(1), [['gpt-6.1-sol', 2_000_000]]);
  const data = await (await f.request('GET')).json();
  assert.equal(data.days.length, 7); assert.equal(data.days[6].day, beijingDay());
  // daily cost: 20000/30 + 2000/30 = 733.33 cents
  assert.equal(data.today_value.usd_daily_minor, 733.33); assert.equal(data.today_value.api_usd_micros, 35_000_000);
  assert.equal(data.today_value.ratio, 4.8); assert.equal(data.today_value.paid_back, true);
  assert.equal(data.days[5].paid_back, false); assert.equal(data.days[0].api_usd_micros, null); assert.equal(data.days[0].paid_back, null);
  const byName = Object.fromEntries(data.items.map(i => [i.name, i]));
  assert.equal(byName.Claude.provider, 'anthropic'); assert.equal(byName.Claude.today_usd_micros, 30_000_000); assert.equal(byName.Claude.paid_back_today, true);
  assert.equal(byName.Cursor.provider, null); assert.equal(byName.Cursor.today_usd_micros, null); assert.equal(byName.Cursor.paid_back_today, null);
});
