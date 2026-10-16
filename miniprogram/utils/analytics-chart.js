const { compact } = require('./usage');
const LEFT = 54, RIGHT = 18, TOP = 28, BOTTOM = 40;
function text(ctx, value, x, y, size = 12, color = '#888888', align = 'left') {
  ctx.font = `400 ${size}px -apple-system, "PingFang SC", sans-serif`;
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(String(value), x, y);
}
function drawDonut(ctx, width, height, segments, centerValue, centerLabel) {
  const cx = width / 2, cy = height / 2, radius = Math.min(width * .29, 88), line = 23;
  ctx.lineWidth = line; ctx.strokeStyle = '#EFEFEF'; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  const total = segments.reduce((sum, item) => sum + Math.max(0, Number(item.value) || 0), 0);
  let start = -Math.PI / 2;
  if (total > 0) for (const item of segments) {
    const angle = Math.max(0, Number(item.value) || 0) / total * Math.PI * 2;
    if (!angle) continue;
    ctx.strokeStyle = item.color; ctx.beginPath(); ctx.arc(cx, cy, radius, start, start + angle); ctx.stroke(); start += angle;
  }
  let size = 32;
  ctx.font = `400 ${size}px -apple-system, "PingFang SC", sans-serif`;
  while (size > 14 && ctx.measureText(centerValue).width > (radius - line / 2) * 1.7) { size--; ctx.font = `400 ${size}px -apple-system, "PingFang SC", sans-serif`; }
  text(ctx, total ? centerValue : '—', cx, cy - 9, size, '#191919', 'center');
  text(ctx, total ? centerLabel : '暂无数据', cx, cy + 24, 12, '#888888', 'center');
}
function drawTrend(ctx, width, height, daily) {
  const plotW = width - LEFT - RIGHT, plotH = height - TOP - BOTTOM;
  const values = daily.filter(day => day.value !== null), peak = Math.max(1, ...values.map(day => day.value));
  for (const fraction of [0, .5, 1]) {
    const y = TOP + plotH * (1 - fraction); ctx.strokeStyle = '#EDEDED'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(width - RIGHT, y); ctx.stroke();
    const amount = compact(peak * fraction); text(ctx, amount.value + amount.unit, LEFT - 8, y, 10, '#888888', 'right');
  }
  const point = (day, index) => [LEFT + plotW * index / Math.max(1, daily.length - 1), TOP + plotH * (1 - day.value / peak)];
  ctx.strokeStyle = '#D88A2D'; ctx.fillStyle = '#D88A2D'; ctx.lineWidth = 2;
  for (let index = 0; index < daily.length; index++) {
    const day = daily[index]; if (day.value === null) continue;
    const [x, y] = point(day, index);
    if (index && daily[index - 1].value !== null) {
      const previous = point(daily[index - 1], index - 1); ctx.beginPath(); ctx.moveTo(...previous); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  for (const index of [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])]) {
    if (!daily[index]) continue; const [x] = point(daily[index], index);
    text(ctx, daily[index].label, x, height - 14, 11, '#888888', 'center');
  }
  if (!values.length) text(ctx, '暂无同步记录', LEFT + plotW / 2, TOP + plotH / 2, 14, '#888888', 'center');
}
function chartPointIndex(x, width, count) { return Math.max(0, Math.min(count - 1, Math.round((x - LEFT) / (width - LEFT - RIGHT) * (count - 1)))); }
module.exports = { drawDonut, drawTrend, chartPointIndex };
