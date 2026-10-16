const { test } = require('node:test');
const assert = require('node:assert/strict');
const { comparisonView, toolsTitle } = require('../utils/social-share');
const { drawToolsPoster, drawComparisonPoster, SOCIAL_HEIGHT } = require('../utils/social-poster');
const record = () => {
  const usage = { period: 'week', from: '2026-10-10', to: '2026-10-16', token_basis: 'upstream_total', timezone: 'Asia/Shanghai',
    summary: { tokens: 258000000, requests: 12, active_days: 3 }, tools: [{ name: 'Codex', tokens: 129000000, percent: 50 }], activity: { current_streak: 3 } };
  return { style: 'comparison', user: { nickname: '参与者' }, usage,
    comparison: { source_id: 'a'.repeat(24), source: { user: { nickname: '原作者' }, usage: structuredClone(usage) } } };
};
function context() {
  const texts = [], images = [];
  const ctx = new Proxy({ measureText: value => ({ width: [...String(value)].length * 16 }), fillText: value => texts.push(String(value)),
    drawImage: (...args) => images.push(args) }, { get: (object, key) => key in object ? object[key] : () => {} });
  return { ctx, texts, images };
}
test('不同日期或缓存口径不能生成对比，缺失工具也不虚构偏好', () => {
  const card = record(); assert.equal(comparisonView(card).commonTool, 'Codex');
  card.usage.from = '2026-10-11'; assert.throws(() => comparisonView(card), /日期或统计口径/);
  card.usage.from = '2026-10-10'; card.usage.token_basis = 'input_output'; assert.throws(() => comparisonView(card), /日期或统计口径/);
  card.usage.token_basis = 'upstream_total'; card.usage.tools = []; assert.equal(comparisonView(card).right.top, null);
  assert.equal(comparisonView(card).commonTool, ''); assert.match(toolsTitle(card.user, card.usage), /工具偏好/);
});
test('对比图和工具图都携带真实传入的小程序码，数字、日期与数据一致', () => {
  for (const draw of [drawToolsPoster, drawComparisonPoster]) for (const cover of [true, false]) {
    const { ctx, texts, images } = context(), code = { originalCode: true }, card = record();
    assert.throws(() => draw(ctx, card), /小程序码/);
    draw(ctx, { ...card, cover, codeImage: code });
    assert.ok(texts.some(value => value.includes('2.58'))); assert.ok(texts.some(value => value.includes('50%')));
    assert.ok(!texts.some(value => value.includes('打败') || value.includes('生产力')));
    const image = images.find(args => args[0] === code); assert.ok(image);
    assert.ok(image[2] + image[4] <= (cover ? 800 : SOCIAL_HEIGHT));
  }
});
test('真实零用量保留零，缺失或损坏的总量不转换成零', () => {
  const card = record(); card.usage.summary.tokens = 0;
  assert.equal(comparisonView(card).right.value, '0');
  delete card.usage.summary.tokens; assert.throws(() => comparisonView(card), /用量记录/);
});
