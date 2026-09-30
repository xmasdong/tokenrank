// Renders the exact mini-program Canvas helper using illustrative data only.
// CANVAS_MODULE=/absolute/path/to/@napi-rs/canvas CARD_FONT=/path/to/PingFang.ttc node scripts/render-usage-cards.cjs
const { createCanvas, GlobalFonts, loadImage } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');
const fs = require('node:fs');
const path = require('node:path');
// macOS keeps PingFang in its downloaded-font assets. Register it explicitly
// for Skia; phones use their native PingFang / sans-serif fallback.
if (process.env.CARD_FONT) GlobalFonts.registerFromPath(process.env.CARD_FONT, 'PingFang SC');
const { drawUsagePoster } = require('../miniprogram/utils/usage-poster');
async function main() {
const { CODE_PATH } = require('../miniprogram/utils/share-code');
const codeImage = await loadImage(path.join(__dirname, '../miniprogram', CODE_PATH));
const codeOptions = { codeImage };
const out = path.resolve(__dirname, '../artifacts/usage-cards');
fs.mkdirSync(out, { recursive: true });
const daily = [1284510, 986240, 2148600, 1573000, 2328600, 3082000, 1864000]
  .map((tokens, i) => ({ day: `2026-09-${22 + i}`, tokens, requests: 180 }));
const total = daily.reduce((sum, day) => sum + day.tokens, 0);
const usage = { period: 'week', from: '2026-09-22', to: '2026-09-28', trend_days: 7, daily, token_basis: 'upstream_total', timezone: 'Asia/Shanghai',
  summary: { tokens: total, requests: 1260, active_days: 7 },
  activity: { active_days: 64, current_streak: 21, longest_streak: 21, streak_as_of: '2026-09-28', first_day: '2026-06-18' },
  standing: { rank: 7, participants: 186 },
  tools: [{ name: 'Codex', tokens: total * .923, percent: 92.3 }], models: [{ name: 'gpt-5.4', tokens: total }] };
const user = { user_id: 1, nickname: '小冬' };
const avatarImage=createCanvas(180,180), a=avatarImage.getContext('2d');
a.fillStyle='#D6B985';a.fillRect(0,0,180,180);a.fillStyle='#273D35';a.font='700 96px \"PingFang SC\"';a.textAlign='center';a.fillText('冬',90,127);
const portraitCanvases = [];
for (const theme of ['paper', 'ink']) {
  for (const cover of [false, true]) {
    const canvas = createCanvas(1000, cover ? 800 : 1400);
    drawUsagePoster(canvas.getContext('2d'), { user, usage, theme, cover, avatarImage, ...codeOptions });
    fs.writeFileSync(path.join(out, `${theme}-${cover ? 'cover' : 'poster'}.png`), canvas.toBuffer('image/png'));
    if (!cover) portraitCanvases.push(canvas);
  }
}
const preview = createCanvas(1160, 940), ctx = preview.getContext('2d');
ctx.fillStyle = '#E9E5DC'; ctx.fillRect(0, 0, 1160, 940);
ctx.fillStyle = '#2A2723'; ctx.font = '600 30px "PingFang SC", sans-serif';
ctx.fillText('Token 用量分享卡片', 48, 54);
ctx.fillStyle = '#746C5D'; ctx.font = '20px "PingFang SC", sans-serif'; ctx.fillText('示例数据 · 固定小程序码', 48, 90);
portraitCanvases.forEach((canvas, i) => {
  ctx.drawImage(canvas, 48 + i * 558, 123, 506, 708.4);
  ctx.fillStyle = '#2A2723'; ctx.font = '24px "PingFang SC", sans-serif'; ctx.fillText(i ? '墨金' : '宣纸', 48 + i * 558, 883);
});
fs.writeFileSync(path.join(out, 'preview.png'), preview.toBuffer('image/png'));
// Edge cases: 16-codepoint name, extremely large totals, and missing data.
for (const [name, data] of [
  ['empty', { ...usage, period: 'day', from: usage.to, summary: { tokens: 0, requests: 0, active_days: 0 }, activity: {}, standing: {}, daily: daily.map(d => ({ ...d, tokens: 0 })), tools: [], models: [] }],
  ['large', { ...usage, summary: { tokens: 36500000000000, requests: 365000000, active_days: 365 }, tools: [{ name: 'A'.repeat(60), tokens: 36500000000000, percent: 100 }], models: [{ name: '超长模型名称'.repeat(10) }] }],
]) {
  const canvas = createCanvas(1000, 1400);
  drawUsagePoster(canvas.getContext('2d'), { user: { nickname: '这是一个刚好十六个汉字的测试昵称' }, usage: data, theme: 'paper', ...codeOptions });
  fs.writeFileSync(path.join(out, `edge-${name}.png`), canvas.toBuffer('image/png'));
}
const {drawGroupPoster}=require('../miniprogram/utils/group-poster');
const group={name:'AI 创作者小分队',members:138,total:123,period:'week',me:{rank:52,tokens_fmt:'86.42万'},
 entries:['秋日','小冬','阿北','Rita','阿森'].map((nickname,i)=>({nickname,rank:i+1,tokens_fmt:['2100万','1326.69万','865万','521万','328万'][i],requests:1200-i*100}))};
for(const cover of [true,false]) {
 const canvas=createCanvas(750,cover?600:1150);
 drawGroupPoster(canvas.getContext('2d'),{data:group,cover,...codeOptions});
 fs.writeFileSync(path.join(out,'group-'+(cover?'cover':'poster')+'.png'),canvas.toBuffer('image/png'));
}
console.log(`Rendered usage previews in ${out}`);

}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
