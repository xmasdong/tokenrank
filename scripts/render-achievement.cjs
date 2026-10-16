// Preview an existing public share from the production API. Never invent usage.
// CANVAS_MODULE=/path/to/@napi-rs/canvas CARD_FONT=/path/to/PingFang.ttc node scripts/render-achievement.cjs <share-id> [output-dir]
const fs = require('node:fs'), path = require('node:path');
const { drawAchievementPoster, ACHIEVEMENT_HEIGHT } = require('../miniprogram/utils/achievement-poster');
const API = 'https://tokenrank.xmasdong.cn';
async function main() {
  const id = process.argv[2];
  if (!/^[0-9a-f]{24}$/.test(id || '')) throw new Error('请提供正式分享记录 ID：node scripts/render-achievement.cjs <share-id> [output-dir]');
  const response = await fetch(`${API}/api/shares/${id}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`正式分享接口返回 HTTP ${response.status}，未生成预览`);
  const record = await response.json();
  if (record.id !== id || !record.user || !record.usage || !Number.isSafeInteger(record.usage.summary?.tokens) || record.usage.summary.tokens < 0)
    throw new Error('正式分享记录格式异常，未生成预览');
  const { createCanvas, loadImage, GlobalFonts } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');
  if (process.env.CARD_FONT) GlobalFonts.registerFromPath(process.env.CARD_FONT, 'PingFang SC');
  const out = path.resolve(process.argv[3] || `artifacts/achievement-previews/${id}`);
  fs.mkdirSync(out, { recursive: true });
  const codeImage = await loadImage(path.resolve(__dirname, '../miniprogram/assets/mini-program-code.jpg'));
  let avatarImage;
  if (record.user.avatar_url?.startsWith(API + '/avatars/')) {
    try {
      const avatar = await fetch(record.user.avatar_url, { signal: AbortSignal.timeout(10000) });
      if (avatar.ok) avatarImage = await loadImage(Buffer.from(await avatar.arrayBuffer()));
    } catch { /* Match the mini-program's initials fallback if the avatar is unavailable. */ }
  }
  for (const cover of [true, false]) {
    const canvas = createCanvas(1000, cover ? 800 : ACHIEVEMENT_HEIGHT);
    drawAchievementPoster(canvas.getContext('2d'), { ...record, cover, codeImage, avatarImage });
    fs.writeFileSync(path.join(out, cover ? 'share-cover.png' : 'share-poster.png'), canvas.toBuffer('image/png'));
  }
  fs.writeFileSync(path.join(out, 'record.json'), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ url: `${API}/api/shares/${id}`, fetched_at: new Date().toISOString() }, null, 2));
  console.log(out);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
