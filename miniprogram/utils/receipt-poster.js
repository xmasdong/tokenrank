const { integer, formatTokens } = require('./usage');
const { presentCost, issuedAt } = require('./cost');
const { drawCodeBadge } = require('./share-code');
const SANS = '"PingFang SC", "Noto Sans CJK SC", "Apple Color Emoji", sans-serif';
const NUM = '"Avenir Next", "PingFang SC", "Apple Color Emoji", sans-serif';
const HEIGHT = 1940;

function drawReceiptPoster(ctx, { user, usage, created_at, theme = 'paper', cover = false, codeImage, previewOnly = false }) {
  if (!cover && !codeImage && !previewOnly) throw new Error('小程序码尚未就绪，请重试');
  const C = theme === 'ink'
    ? { bg: '#171B19', paper: '#252B27', text: '#F5F2E9', muted: '#B1B9AF', rule: '#4B554D', accent: '#D2B677' }
    : { bg: '#E8EAEC', paper: '#FFFFFF', text: '#252927', muted: '#717975', rule: '#DADEDB', accent: '#A8392D' };
  const cost = presentCost(usage.cost), H = cover ? 800 : HEIGHT, L = 108, R = 892, W = R - L;
  const txt = (value, x, y, size = 28, color = C.text, weight = 400, align = 'left', width = W, font = SANS) => {
    ctx.fillStyle = color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = align;
    let text = String(value); ctx.font = `${weight} ${size}px ${font}`;
    while (size > 18 && ctx.measureText(text).width > width) { size--; ctx.font = `${weight} ${size}px ${font}`; }
    if (ctx.measureText(text).width > width) {
      const chars = [...text];
      while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
      text = chars.join('') + '…';
    }
    ctx.fillText(text, x, y);
  };
  const rule = (y, dashed = false, heavy = false) => {
    ctx.strokeStyle = heavy ? C.text : C.rule; ctx.lineWidth = heavy ? 3 : 2;
    ctx.setLineDash(dashed ? [6, 8] : []);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); ctx.setLineDash([]);
  };
  const row = (label, value, y) => {
    txt(label, L, y, 26, C.muted);
    txt(value, R, y, 29, C.text, 500, 'right', 610, NUM);
  };
  const range = usage.from === usage.to ? usage.to : `${usage.from} — ${usage.to}`;

  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1000, H);
  // A straight-cut heading and a fine torn lower edge distinguish the receipt from the Token card.
  ctx.fillStyle = C.paper; ctx.beginPath(); ctx.moveTo(54, 42); ctx.lineTo(946, 42); ctx.lineTo(946, H - 42);
  for (let x = 930; x >= 54; x -= 16) ctx.lineTo(x, H - 42 - ((946 - x) / 16 % 2 ? 8 : 0));
  ctx.lineTo(54, H - 42); ctx.closePath(); ctx.fill();

  ctx.fillStyle = C.accent; ctx.fillRect(L, 93, 7, 26);
  txt('TOKEN 群排名', L + 22, 115, 24, C.accent, 600);
  txt('TOKENRANK', R, 115, 20, C.muted, 500, 'right', 260, NUM);
  txt('AI 用量账单', L, 206, 58, C.text, 700);
  txt('USD', R, 203, 27, C.accent, 600, 'right', 160, NUM);
  rule(247, false, true);

  if (cover) {
    txt(user.nickname || 'AI 玩家', L, 311, 30, C.text, 600, 'left', W);
    txt(range, L, 355, 24, C.muted);
    txt(cost.label, L, 433, 27, C.muted);
    txt(cost.available ? '$' + cost.amount : '—', L - 3, 556, 108, C.text, 700, 'left', W, NUM);
    txt('API 等值估算 · 非实际扣费', L, 612, 25, C.muted);
    rule(652);
    txt(cost.note || (cost.available ? '按本机价格表计算' : '金额尚未同步'), L, 703, 23, cost.note ? C.accent : C.muted);
    return;
  }

  row('日期范围', range, 303);
  row('账户', user.nickname || 'AI 玩家', 360);
  rule(398);
  txt(cost.label, L, 459, 28, C.muted);
  txt(cost.available ? '$' + cost.amount : '—', L - 3, 579, 104, C.text, 700, 'left', W, NUM);
  txt('API 等值估算 · 非实际扣费', L, 632, 25, C.muted);
  txt(cost.note || (cost.available ? '按本机价格表计算' : '金额尚未同步'), L, 674, 23, cost.note ? C.accent : C.muted);
  rule(718);

  txt('总用量 · Tokens', L, 768, 24, C.muted);
  txt(formatTokens(usage.summary.tokens), L, 822, 46, C.text, 600, 'left', 400, NUM);
  txt('活跃天数', 558, 768, 24, C.muted);
  txt(integer(usage.summary.active_days) + ' 天', 558, 822, 40, C.text, 600, 'left', 160, NUM);
  txt('模型', R, 768, 24, C.muted, 400, 'right');
  txt(cost.modelCount ? cost.modelCount + ' 个' : '—', R, 822, 40, C.text, 600, 'right', 150, NUM);
  row('缓存读取', formatTokens(usage.summary.cache_read) + ' Tokens', 906);
  row('缓存写入', formatTokens(usage.summary.cache_write) + ' Tokens', 960);
  rule(1002, false, true);
  txt('模型明细', L, 1053, 24, C.muted);
  txt('金额 / USD', R, 1053, 24, C.muted, 400, 'right');
  if (cost.models.length) cost.models.forEach((m, i) => {
    const y = 1120 + i * 58;
    txt(m.name, L, y, 29, m.other ? C.muted : C.text, 500, 'left', 510);
    txt('$' + m.amount, R, y, 30, m.other ? C.muted : C.text, 600, 'right', 250, NUM);
  });
  else {
    txt(cost.unpricedCount ? '暂无可计价模型' : '更新电脑同步器后可生成金额明细', L, 1215, 26, C.muted);
    txt('Token 用量不受影响', L, 1260, 23, C.muted);
  }
  rule(1448);
  row(cost.note ? '已计价合计' : '合计', cost.available ? '$' + cost.amount : '—', 1505);

  // Detachable footer: keep the fixed mini-program code intact on its white circular base.
  rule(1570, true);
  ctx.fillStyle = C.bg;
  for (const x of [54, 946]) { ctx.beginPath(); ctx.arc(x, 1570, 14, 0, Math.PI * 2); ctx.fill(); }
  txt('TOKEN 群排名', L, 1663, 30, C.text, 600, 'left', 480);
  txt('长按识别小程序码', L, 1711, 25, C.muted, 400, 'left', 480);
  txt('生成时间 · 北京时间', L, 1794, 22, C.muted, 400, 'left', 480);
  txt(issuedAt(created_at) || '—', L, 1834, 25, C.muted, 400, 'left', 480, NUM);
  drawCodeBadge(ctx, codeImage, 648, 1623, 244);
  if (!codeImage) txt('预览码位', 770, 1753, 22, C.muted, 400, 'center', 210);
}
module.exports = { drawReceiptPoster, RECEIPT_HEIGHT: HEIGHT };
