const { integer, formatTokens } = require('./usage');
const { presentCost, issuedAt } = require('./cost');
const { drawCodeBadge } = require('./share-code');
const SANS = '"PingFang SC", "Noto Sans CJK SC", "Apple Color Emoji", sans-serif';
const MONO = '"Menlo", "Consolas", "PingFang SC", "Apple Color Emoji", monospace';
const HEIGHT = 1940;

function drawReceiptPoster(ctx, { user, usage, created_at, theme = 'paper', cover = false, codeImage, previewOnly = false }) {
  if (!cover && !codeImage && !previewOnly) throw new Error('小程序码尚未就绪，请重试');
  const C = theme === 'ink'
    ? { bg: '#171B19', paper: '#252B27', text: '#F5F2E9', muted: '#BDC3BA', rule: '#959E92' }
    : { bg: '#E9EAE7', paper: '#FFFFFF', text: '#343532', muted: '#64665F', rule: '#83867D' };
  const cost = presentCost(usage.cost), H = cover ? 800 : HEIGHT;
  const L = cover ? 132 : 156, R = 1000 - L, W = R - L;
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
  const rule = (y, double = false) => {
    ctx.strokeStyle = C.rule; ctx.lineWidth = 2; ctx.setLineDash([8, 7]);
    for (const at of double ? [y, y + 8] : [y]) {
      ctx.beginPath(); ctx.moveTo(L, at); ctx.lineTo(R, at); ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  const row = (label, value, y, font = MONO, size = 28) => {
    txt(label, L, y, 28);
    txt(value, R, y, size, C.text, 400, 'right', W - 145, font);
  };
  const range = usage.from === usage.to ? usage.to : `${usage.from} ~ ${usage.to}`;

  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1000, H);
  // A narrow roll of white paper, with a plain cut at the top and a fine serration below.
  const edge = cover ? 88 : 108;
  ctx.fillStyle = C.paper; ctx.beginPath(); ctx.moveTo(edge, 34); ctx.lineTo(1000 - edge, 34);
  ctx.lineTo(1000 - edge, H - 34);
  for (let x = 1000 - edge - 14; x > edge; x -= 14) {
    ctx.lineTo(x, H - 34 - ((1000 - edge - x) / 14 % 2 ? 7 : 0));
  }
  ctx.lineTo(edge, H - 34); ctx.closePath(); ctx.fill();

  txt('TOKENRANK', 500, 121, 46, C.text, 700, 'center', W, MONO);
  txt('TOKEN 群排名', 500, 165, 25, C.text, 500, 'center');
  txt('AI 用量小票', 500, 210, 30, C.text, 500, 'center');
  rule(246, true);

  if (cover) {
    row('账户', user.nickname || 'AI 玩家', 310, SANS, 29);
    row('期间', range, 356, MONO, 26);
    rule(392);
    txt(cost.label, L, 449, 27);
    txt(cost.available ? '$' + cost.amount : '—', R, 542, 79, C.text, 500, 'right', W, MONO);
    rule(586, true);
    txt('API 等值估算 · USD · 非实际扣费', 500, 648, 23, C.muted, 400, 'center');
    txt(cost.note || (cost.available ? '按本机价格表计算' : '金额尚未同步'), 500, 693, 23, C.muted, 400, 'center');
    return;
  }

  row('账户', user.nickname || 'AI 玩家', 305, SANS);
  row('期间', range, 355, MONO, 26);
  row('出单', issuedAt(created_at) || '—', 405, MONO, 27);
  rule(444);
  txt('模型', L, 493, 28);
  txt('估算 / USD', R, 493, 27, C.text, 400, 'right', 240, MONO);
  if (cost.models.length) cost.models.forEach((m, i) => {
    const y = 556 + i * 64;
    txt(m.name, L, y, 28, C.text, 400, 'left', 434, m.other ? SANS : MONO);
    txt(m.amount, R, y, 28, C.text, 400, 'right', 230, MONO);
  });
  else {
    txt(cost.unpricedCount ? '暂无可计价模型' : '更新电脑同步器后可生成金额明细', L, 631, 26, C.muted);
    txt('Token 用量不受影响', L, 678, 24, C.muted);
  }
  rule(922, true);
  txt(cost.note ? '已计价合计' : '估算合计', L, 998, 29);
  txt(cost.available ? '$' + cost.amount : '—', R, 1003, 48, C.text, 700, 'right', W - 200, MONO);
  txt('API 等值估算 · 非实际扣费', 500, 1060, 24, C.muted, 400, 'center');
  txt(cost.note || (cost.available ? '按本机价格表计算' : '金额尚未同步'), 500, 1101, 23, C.muted, 400, 'center');
  rule(1142);

  row('总用量', formatTokens(usage.summary.tokens) + ' Tokens', 1198);
  row('缓存读取', formatTokens(usage.summary.cache_read) + ' Tokens', 1250);
  row('缓存写入', formatTokens(usage.summary.cache_write) + ' Tokens', 1302);
  row('活跃天数', integer(usage.summary.active_days) + ' 天', 1354);
  row('模型数量', cost.modelCount ? cost.modelCount + ' 个' : '—', 1406);
  rule(1450, true);

  txt('长按识别小程序码', 500, 1517, 26, C.text, 400, 'center');
  drawCodeBadge(ctx, codeImage, 368, 1545, 264);
  if (!codeImage) txt('预览码位', 500, 1688, 22, C.muted, 400, 'center', 210);
  txt('含缓存总用量 · 北京时间', 500, 1850, 24, C.muted, 400, 'center');
}
module.exports = { drawReceiptPoster, RECEIPT_HEIGHT: HEIGHT };
