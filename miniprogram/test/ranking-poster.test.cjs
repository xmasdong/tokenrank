const { test } = require('node:test');
const assert = require('node:assert/strict');
const { personalRanking, drawRankingPoster, rankingAvatarUrls, rankingPosterHeight } = require('../utils/ranking-poster');

const entries = Array.from({ length: 8 }, (_, i) => ({ rank: i + 1, nickname: `成员${i + 1}`, tokens: 258000000 - i * 10000000, avatar_url: i < 2 ? 'https://rank/one' : null }));
const record = { user: { nickname: '本人', avatar_url: 'https://rank/one' }, usage: { period: 'week', from: '2026-10-06', to: '2026-10-12', token_basis: 'upstream_total', timezone: 'Asia/Shanghai', summary: { tokens: 100000000 }, standing: { rank: 52 } } };
function context() {
  const texts = [], images = [];
  const ctx = new Proxy({ measureText: value => ({ width: [...String(value)].length * 20 }),
    fillText: (value, x, y) => texts.push({ value, x, y }), drawImage: (...args) => images.push(args) }, { get: (target, key) => key in target ? target[key] : () => {} });
  return { ctx, texts, images };
}

test('个人排行榜拒绝混用不同用量或名次的旧榜单，保留前50名之外的本人排名', () => {
  const board = { entries, total: 123, me: { rank: 52, tokens: 100000000 } };
  assert.throws(() => personalRanking(record, { ...board, me: { ...board.me, tokens: 99000000 } }), /榜单已有更新/);
  assert.throws(() => personalRanking(record, { ...board, me: { ...board.me, rank: 51 } }), /榜单已有更新/);
  const data = personalRanking(record, board);
  assert.equal(data.me.rank, 52); assert.equal(data.me.tokens, 100000000); assert.equal(data.total, 123);
  assert.deepEqual(rankingAvatarUrls(data), ['https://rank/one']);
  assert.equal(personalRanking({ ...record, usage: { ...record.usage, standing: { rank: null, hidden: true } } }, { ...board, me: null }).me.rank, null);
});

test('排行榜海报与封面均携带真码，分别展示前5名和前3名，亿单位不混用', () => {
  const data = personalRanking(record, { entries, total: 123, me: { rank: 52, tokens: 100000000 } });
  const code = { realCode: true };
  for (const cover of [false, true]) {
    const { ctx, texts, images } = context();
    assert.throws(() => drawRankingPoster(ctx, { data, cover }), /小程序码/);
    drawRankingPoster(ctx, { data, cover, codeImage: code });
    const values = texts.map(t => t.value);
    assert.equal(values.filter(value => /^成员\d+$/.test(value)).length, cover ? 3 : 5);
    assert.ok(values.includes('52')); assert.ok(values.includes('2.58')); assert.ok(values.includes('亿'));
    assert.ok(!values.includes('万')); assert.ok(values.includes('本人'));
    assert.ok(values.some(value => value.includes('123 人上榜')));
    assert.equal(images.filter(args => args[0] === code).length, 1);
    const codeDraw = images.find(args => args[0] === code);
    assert.ok(codeDraw[2] + codeDraw[4] <= (cover ? 800 : rankingPosterHeight(data)));
  }
});

test('人数少的榜单缩短海报；未上榜状态不生成虚假名次', () => {
  const data = { ...personalRanking(record, { entries, total: 8, me: { rank: 52, tokens: 100000000 } }), entries: entries.slice(0, 1), me: null };
  assert.equal(rankingPosterHeight(data), 900);
  const { ctx, texts } = context();
  drawRankingPoster(ctx, { data, codeImage: {} });
  assert.ok(texts.some(t => t.value === '—')); assert.ok(texts.some(t => t.value === '本周期未上榜'));
  assert.ok(!texts.some(t => t.value === '52'));
});
