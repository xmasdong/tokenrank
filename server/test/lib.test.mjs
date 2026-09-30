import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToken, groupId, sanitizeName, clampDay, utcDay, daysAgo, bearerToken } from '../src/lib.js';

test('hexToken: 32 位小写 hex，随机', () => {
  const a = hexToken(16), b = hexToken(16);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('groupId: 8 位、无易混字符、随机', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = groupId();
    assert.match(id, /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
    assert.ok(!/[01ol]/.test(id));
    seen.add(id);
  }
  assert.equal(seen.size, 200);
});

test('utcDay/daysAgo: UTC 自然日边界', () => {
  const now = Date.UTC(2026, 8, 27, 23, 30); // 2026-09-27T23:30Z
  assert.equal(utcDay(now), '2026-09-27');
  assert.equal(daysAgo(6, now), '2026-09-21');
  assert.equal(daysAgo(29, now), '2026-08-29');
});

test('sanitizeName: 合法昵称保留，链接/@/黑名单/超长拒为 null', () => {
  assert.equal(sanitizeName('  圣诞  东 '), '圣诞 东');
  assert.equal(sanitizeName('张三'), '张三');
  assert.equal(sanitizeName('看这个 https://x.com'), null);
  assert.equal(sanitizeName('加我微信 abc.com'), null);
  assert.equal(sanitizeName('找我@a'), null);
  assert.equal(sanitizeName('我是官方'), null);
  assert.equal(sanitizeName(''.padEnd(17, '长')), null);
  assert.equal(sanitizeName(''), null);
  // 零宽字符被剥掉后合法
  assert.equal(sanitizeName('a\u200bb'), 'ab');
});

test('clampDay: 负数归零、上限截断、明细裁剪', () => {
  const c = clampDay({
    day: '2026-09-27',
    tokens: -5, requests: 1e9, cache_read: 5e12,
    models: Array.from({ length: 12 }, (_, i) => [`m${i}`, 100]).concat('bad'),
    tools: [['zcode', -3]],
  });
  assert.equal(c.tokens, 0);
  assert.equal(c.requests, 1e6);
  assert.equal(c.cache_read, 1e12);
  assert.equal(c.models.length, 8);
  assert.equal(c.tools[0][1], 0);
  assert.equal(clampDay({ day: 'nope' }).day, null);
  assert.equal(clampDay(null).tokens, 0);
});

test('bearerToken: 大小写 Bearer 与缺失', () => {
  const req = (h) => ({ headers: { get: (k) => (k === 'authorization' ? h : null) } });
  assert.equal(bearerToken(req('Bearer abc')), 'abc');
  assert.equal(bearerToken(req('bearer abc')), 'abc');
  assert.equal(bearerToken(req('Basic abc')), null);
  assert.equal(bearerToken(req('')), null);
});
