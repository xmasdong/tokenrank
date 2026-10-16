// Render the production personal/group share artwork with illustrative data only.
// CANVAS_MODULE=/path/to/@napi-rs/canvas CARD_FONT=/path/to/PingFang.ttc node scripts/render-achievement.cjs [output-dir]
const { createCanvas, loadImage, GlobalFonts } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');
const fs = require('node:fs'), path = require('node:path');
const { drawAchievementPoster, ACHIEVEMENT_HEIGHT } = require('../miniprogram/utils/achievement-poster');
async function main() {
  if (process.env.CARD_FONT) GlobalFonts.registerFromPath(process.env.CARD_FONT, 'PingFang SC');
  const out = path.resolve(process.argv[2] || 'artifacts/achievement-previews');
  fs.mkdirSync(out, { recursive: true });
  const codeImage = await loadImage(path.resolve(__dirname, '../miniprogram/assets/mini-program-code.jpg'));
  const user = { nickname: '小冬' };
  const usage = { period: 'week', from: '2026-10-10', to: '2026-10-16', timezone: 'Asia/Shanghai', token_basis: 'upstream_total',
    summary: { tokens: 258000000 }, activity: { current_streak: 7, active_days: 64 }, standing: { rank: 80, participants: 100 },
    group_standing: { name: 'AI 开发小组', rank: 52, participants: 123, members: 138 } };
  for (const cover of [true, false]) {
    const canvas = createCanvas(1000, cover ? 800 : ACHIEVEMENT_HEIGHT);
    drawAchievementPoster(canvas.getContext('2d'), { user, usage, cover, codeImage });
    fs.writeFileSync(path.join(out, cover ? 'group-cover.png' : 'group-poster.png'), canvas.toBuffer('image/png'));
  }
  for (const [name, tokens, rank] of [['zero', 0, null], ['large', 36500000000000, 1089]]) {
    const canvas = createCanvas(1000, 800);
    drawAchievementPoster(canvas.getContext('2d'), { user: { nickname: '这是一个刚好十六个汉字的测试昵称' },
      usage: { ...usage, summary: { tokens }, group_standing: { ...usage.group_standing, rank } }, cover: true, codeImage });
    fs.writeFileSync(path.join(out, name + '-cover.png'), canvas.toBuffer('image/png'));
  }
  console.log(out);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
