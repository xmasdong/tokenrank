import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsage, usageWindow } from '../src/usage.js';
const now = Date.parse('2026-09-27T16:05:00Z');
const row = (day, tokens, extra = {}) => ({ day, tokens, requests: 2, cache_read: 800, cache_write: 20,
  models_json: JSON.stringify([['model-a', tokens]]), tools_json: JSON.stringify([['Codex', tokens]]), updated_at: 10, ...extra });

test('用量周期使用北京时间；今日趋势含前六天，但总量只算今日', () => {
  const data = buildUsage([row('2026-09-22', 50), row('2026-09-27', 70), row('2026-09-28', 100), row('2026-09-29', 999)], 'day', now);
  assert.equal(data.summary.tokens, 100); assert.equal(data.summary.requests, 2);
  assert.equal(data.summary.cache_read, 800); assert.equal(data.summary.cache_write, 20);
  assert.equal(data.daily.length, 7); assert.equal(data.daily[0].tokens, 50);
  assert.equal(data.daily[1].tokens, 0); assert.equal(data.daily[5].tokens, 70);
  assert.equal(data.daily[6].tokens, 100); assert.equal(data.summary.active_days, 1);
  assert.equal(usageWindow('day', now - 600000).to, '2026-09-27');
});

test('近7天、近30天和累计边界明确；累计趋势只展示最近30天', () => {
  const rows = [row('2026-07-01', 11), row('2026-08-30', 20), row('2026-09-21', 30), row('2026-09-22', 40), row('2026-09-28', 50)];
  assert.equal(buildUsage(rows, 'week', now).summary.tokens, 90);
  assert.equal(buildUsage(rows, 'month', now).summary.tokens, 140);
  const all = buildUsage(rows, 'all', now);
  assert.equal(all.summary.tokens, 151); assert.equal(all.from, '2026-07-01');
  assert.equal(all.daily.length, 30); assert.equal(all.daily[0].tokens, 20);
  assert.equal(usageWindow('invalid', now).period, 'day');
});

test('跨日模型工具合并；缺失或损坏的明细计入未分类', () => {
  const data = buildUsage([
    row('2026-09-27', 100, { models_json: 'invalid', tools_json: 'null' }),
    row('2026-09-28', 200, { models_json: JSON.stringify([['model-a', 50], ['model-a', 40], ['model-b', 10], ['bad', -5], null]), tools_json: '[]' }),
  ], 'week', now);
  assert.equal(data.models.find(m => m.name === 'model-a').tokens, 90);
  assert.equal(data.models.find(m => m.unclassified).tokens, 200);
  assert.equal(data.tools[0].tokens, 300); assert.equal(data.tools[0].percent, 100);
  assert.equal(data.summary.tokens, 300);
});

test('空历史真实返回零；请求但无 tokens 的天仍算活跃', () => {
  const empty = buildUsage([], 'all', now);
  assert.equal(empty.summary.tokens, 0); assert.equal(empty.summary.active_days, 0);
  assert.equal(empty.from, '2026-09-28'); assert.deepEqual(empty.models, []);
  assert.ok(empty.daily.every(d => d.tokens === 0));
  assert.equal(buildUsage([row('2026-09-28', 0)], 'day', now).summary.active_days, 1);
});

test('连续记录保留到昨天；中断后仍保留最长连续，零数据、重复日期及未来记录不算活跃', async () => {
  const { buildActivity } = await import('../src/usage.js');
  const rows = [row('2026-09-24', 1), row('2026-09-25', 1), row('2026-09-26', 0), row('2026-09-27', 1),
    row('2026-09-27', 1), row('2026-09-28', 0, {requests:0}), row('2026-09-29', 100), row('2026-02-30', 100)];
  const active = buildActivity(rows, now);
  assert.equal(active.active_days, 4); assert.equal(active.current_streak, 4);
  assert.equal(active.streak_as_of, '2026-09-27'); assert.equal(active.first_day, '2026-09-24');
  const broken = buildActivity(rows.slice(0,3), now);
  assert.equal(broken.current_streak, 0); assert.equal(broken.streak_as_of, null); assert.equal(broken.longest_streak, 3);
  assert.deepEqual(buildActivity([], now), {active_days:0,first_day:null,last_day:null,current_streak:0,streak_as_of:null,longest_streak:0});
  assert.equal(buildActivity([row('2026-08-31', 1), row('2026-09-01', 1)], now).longest_streak, 2);
});
