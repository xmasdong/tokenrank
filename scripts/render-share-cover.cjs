// Static fallback cover for chat shares (square page, and while a canvas cover is still rendering).
// No mini program code: tapping a chat card already opens the app.
// CANVAS_MODULE=/path/@napi-rs/canvas SANS_FONT=/path/PingFang.ttc node scripts/render-share-cover.cjs
const { createCanvas, GlobalFonts } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');
const fs = require('node:fs');
const path = require('node:path');
if (process.env.SANS_FONT) GlobalFonts.registerFromPath(process.env.SANS_FONT, 'PingFang SC');

// Tools ordered by distinct reporting users in the last 30 days (production D1, 2026-09-29).
const TOOLS = ['Codex', 'Claude Code', 'ZCode', 'WorkBuddy', 'Grok'];
const PERIODS = ['今日', '近7天', '近30天']; // miniprogram/utils/flow.js PERIODS
const C = { paper: '#F7F3E9', ink: '#252C26', soft: '#727467', seal: '#A8392D', gold: '#907329', rule: '#D8D1C1', frame: '#E4DCCB' };
const SANS = '"PingFang SC", sans-serif', SERIF = SANS; // no Chinese serif

const W = 750, H = 600, canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
const text = (value, x, y, size, color, weight = 400, font = SANS, align = 'left') => {
  ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x, y); return ctx.measureText(value).width;
};
ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
ctx.strokeStyle = C.frame; ctx.lineWidth = 2; ctx.strokeRect(20, 20, W - 40, H - 40);

// Seal + name
ctx.fillStyle = C.seal; ctx.beginPath(); ctx.roundRect(72, 86, 100, 100, 10); ctx.fill();
text('榜', 122, 157, 58, '#FFF4E3', 700, SERIF, 'center');
text('Token 群排名', 204, 150, 60, C.ink, 700, SERIF);
text('AI 编码工具的 Token 用量排行', 206, 190, 24, C.soft);

ctx.fillStyle = C.rule; ctx.fillRect(72, 240, W - 144, 1); ctx.fillRect(72, 246, W - 144, 1);

// Periods as the real tabs
text('每个微信群一张榜', W / 2, 318, 34, C.ink, 700, SERIF, 'center');
const chipW = 132, gap = 22, total = PERIODS.length * chipW + (PERIODS.length - 1) * gap;
PERIODS.forEach((label, i) => {
  const x = (W - total) / 2 + i * (chipW + gap);
  ctx.strokeStyle = C.rule; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x, 352, chipW, 54, 27); ctx.stroke();
  text(label, x + chipW / 2, 388, 24, C.ink, 400, SANS, 'center');
});

text(TOOLS.join(' · ') + ' 等', W / 2, 466, 23, C.gold, 400, SANS, 'center');
text('含缓存总用量 · 每 5 分钟同步', W / 2, 536, 20, C.soft, 400, SANS, 'center');

const out = path.resolve(__dirname, '../miniprogram/assets/share-cover.png');
fs.writeFileSync(out, canvas.toBuffer('image/png'));
console.log('Rendered', out);
