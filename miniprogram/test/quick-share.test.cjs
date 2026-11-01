const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { drawAchievementPoster, ACHIEVEMENT_HEIGHT } = require('../utils/achievement-poster');
const flush = () => new Promise(resolve => setImmediate(resolve));
const record = (period = 'day', rank = 52) => ({ id: (period === 'day' ? 'a' : 'b').repeat(24), user: { nickname: '本人' },
  usage: { period, from: '2026-10-10', to: '2026-10-16', summary: { tokens: 258000000 },
    activity: { current_streak: 7, active_days: 64 }, standing: { rank: 80, participants: 100 },
    group_standing: { name: '开发小组', rank, members: 138, participants: 123 } } });
function context() {
  const texts = [], images = [];
  const ctx = new Proxy({ measureText: s => ({ width: [...String(s)].length * 18 }), fillText: s => texts.push(String(s)),
    drawImage: (...args) => images.push(args) }, { get: (target, key) => key in target ? target[key] : () => {} });
  return { ctx, texts, images };
}
function fixture(createShare = async period => record(period)) {
  let now=Date.now();class Clock extends Date{static now(){return now;}}
  const exports = [], { ctx } = context(), mod = { exports: {} };
  const canvas = { getContext: () => ctx };
  const wx = { createSelectorQuery: () => ({ in() { return this; }, select() { return this; }, fields() { return this; }, exec(fn) { fn([{ node: canvas }]); } }),
    canvasToTempFilePath: o => exports.push(o) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/quick-share.js'), 'utf8'), { module: mod, Date:Clock,
    require: name => name === './share-avatar' ? { loadAvatarImage: async () => null }
      : name === './share-code' ? { loadCodeImage: async () => ({ officialCode: true }) } : require('../utils/' + name.slice(2)),
  });
  let epoch = 0;
  const p = { ...mod.exports.quickShare({ createShare, accountEpoch: () => epoch }, wx), data: { period: 'day' },
    setData(patch) { Object.assign(this.data, patch); } };
  return { p, exports, logout: () => epoch++, advance:ms=>now+=ms };
}

test('返回同一用量或周期复用已导出封面；onReady 重入不再重复导出 PNG',async()=>{
 const f=fixture();await f.p.prepareQuickShare();await flush();f.p.buildQuickCover();
 f.exports[0].success({tempFilePath:'cached-cover.png'});await flush();assert.equal(f.exports.length,1);
 f.p.clearQuickShare();await f.p.prepareQuickShare();await flush();assert.equal(f.exports.length,1);assert.equal(f.p.data.quickCoverPath,'cached-cover.png');
 f.p.clearQuickShare();f.p.data.period='week';await f.p.prepareQuickShare();await flush();assert.equal(f.exports.length,2);f.exports[1].success({tempFilePath:'week.png'});await flush();
 f.p.clearQuickShare();f.p.data.period='day';await f.p.prepareQuickShare();await flush();assert.equal(f.exports.length,2);assert.equal(f.p.data.quickCoverPath,'cached-cover.png');
});
test('封面过期或账号变化后重建，不能跨账号复用旧封面',async()=>{
 const f=fixture();await f.p.prepareQuickShare();await flush();f.exports[0].success({tempFilePath:'old.png'});await flush();
 f.advance(300001);f.p.clearQuickShare();await f.p.prepareQuickShare();await flush();assert.equal(f.exports.length,2);f.exports[1].success({tempFilePath:'fresh.png'});await flush();
 f.logout();f.p.clearQuickShare();await f.p.prepareQuickShare();await flush();assert.equal(f.exports.length,3);assert.equal(f.p.data.quickCoverPath,'');
});

test('群成绩封面与海报突出本人，前50名以外仍显示真实名次，不包含群友列表', () => {
  for (const cover of [true, false]) {
    const { ctx, texts, images } = context(), code = { code: true };
    drawAchievementPoster(ctx, { ...record(), cover, codeImage: code });
    assert.ok(texts.includes('本人')); assert.ok(texts.includes('开发小组'));
    assert.ok(texts.includes('52')); assert.ok(texts.includes('2.58')); assert.ok(texts.includes('亿'));
    assert.ok(texts.some(t => t.includes('123'))); assert.ok(texts.some(t => t.includes('64')));
    assert.ok(!texts.some(t => t.includes('前 5') || t.includes('成员')));
    const drawn = images.find(args => args[0] === code);
    assert.ok(drawn[2] + drawn[4] <= (cover ? 800 : ACHIEVEMENT_HEIGHT));
  }
  const { ctx, texts } = context();
  const zero = record(); zero.usage.summary.tokens = 0; zero.usage.group_standing.rank = null;
  drawAchievementPoster(ctx, { ...zero, cover: true, codeImage: {} });
  assert.ok(texts.includes('—')); assert.ok(!texts.includes('52'));
  assert.throws(() => drawAchievementPoster(ctx, record()), /小程序码/);
});

test('公开记录就绪即可直接转发，封面导出较慢或失败不会阻塞；同一页面不重复生成记录', async () => {
  let calls = 0;
  const { p, exports } = fixture(async period => { calls++; return record(period); });
  const first = p.prepareQuickShare({ groupId: 'g' });
  assert.equal(first, p.prepareQuickShare({ groupId: 'g' }));
  await first; await flush();
  assert.equal(p.data.quickShareReady, true); assert.equal(exports.length, 1);
  const card = p.quickShareCard();
  assert.equal(card.path, '/pages/record/record?id=' + 'a'.repeat(24));
  assert.match(card.title, /本人.*2.58 亿.*群内 #52/);
  assert.equal(card.imageUrl, '/assets/share-cover.png');
  exports[0].fail({}); await flush();
  assert.equal(p.data.quickShareReady, true); assert.equal(calls, 1);
});

test('切换周期、离开及注销后迟到的记录或封面不能覆盖当前分享', async () => {
  const waiting = [];
  const { p, exports, logout } = fixture(period => new Promise(resolve => waiting.push(() => resolve(record(period)))));
  const old = p.prepareQuickShare({ groupId: 'g' });
  p.clearQuickShare(); p.data.period = 'week';
  const current = p.prepareQuickShare({ groupId: 'g' });
  waiting[1](); await current; await flush();
  waiting[0](); await old;
  assert.match(p.quickShareCard().path, new RegExp('b'.repeat(24)));
  p.clearQuickShare(); exports[0].success({ tempFilePath: 'late.png' }); await flush();
  assert.equal(p.data.quickCoverPath, ''); assert.equal(p.quickShareCard(), null);
  const pending = p.prepareQuickShare(); logout(); waiting[2](); await pending;
  assert.equal(p.data.quickShareReady, false);
});

test('群分享拒绝缺失的群成绩；409只重试一次，失败后可以主动重试', async () => {
  let calls = 0;
  const { p } = fixture(async () => { calls++; const e = new Error('榜单已有更新'); e.statusCode = 409; throw e; });
  await p.prepareQuickShare({ groupId: 'g' });
  assert.equal(calls, 2); assert.equal(p.data.quickShareReady, false); assert.equal(p.quickShareCard(), null);
  await p.retryQuickShare(); assert.equal(calls, 4);
  const unsupported = fixture(async () => { const r = record(); delete r.usage.group_standing; return r; }).p;
  await unsupported.prepareQuickShare({ groupId: 'g' });
  assert.equal(unsupported.data.quickShareReady, false);
});
