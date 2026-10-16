const { compact, integer, PERIODS, usageBasis } = require('./usage');
const { drawCodeBadge } = require('./share-code');
const ACHIEVEMENT_HEIGHT = 1160;

// Only the author's frozen numbers are rendered; no other members' identities.
function drawAchievementPoster(ctx, { user, usage, cover = false, codeImage, avatarImage }) {
  if (!codeImage) throw new Error('小程序码尚未就绪，请重试');
  const H = cover ? 800 : ACHIEVEMENT_HEIGHT, L = 60, R = 940;
  const ink = '#191919', soft = '#777777', orange = '#D88A2D';
  const text = (value, x, y, size, color = ink, width = 880, align = 'left') => {
    ctx.font = `400 ${size}px "PingFang SC", "Helvetica Neue", sans-serif`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    const chars = [...String(value ?? '')];
    if (ctx.measureText(chars.join('')).width > width) {
      while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
      chars.push('…');
    }
    ctx.fillText(chars.join(''), x, y);
    return ctx.measureText(chars.join('')).width;
  };
  const rule = y => { ctx.fillStyle = '#EDEDED'; ctx.fillRect(L, y, R - L, 1); };
  const group = usage.group_standing, standing = group || usage.standing || {};
  const amount = compact(usage.summary.tokens);
  const activity = usage.activity || {};
  const streak = activity.current_streak || activity.longest_streak || 0;
  const period = PERIODS.find(p => p.key === usage.period)?.label || '今日';
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, 1000, H);
  text('Token 群排名', L, 52, 24, soft);
  text(period, R, 52, 24, soft, 200, 'right');
  ctx.save(); ctx.beginPath(); ctx.arc(108, 130, 48, 0, Math.PI * 2); ctx.clip();
  if (avatarImage) ctx.drawImage(avatarImage, L, 82, 96, 96);
  else { ctx.fillStyle = '#F2F2F2'; ctx.fillRect(L, 82, 96, 96); text([...(user.nickname || '我')][0], 108, 145, 40, soft, 96, 'center'); }
  ctx.restore();
  text(user.nickname || 'AI 玩家', 180, 124, 38, ink, 760);
  text(group?.name || '个人用量', 180, 166, 26, soft, 760);
  rule(208);
  text(group ? '群内排名' : '全站排名', L, 264, 28, soft);
  const rankWidth = text(standing.rank ?? '—', L, 425, 164, orange, 470);
  text(`/ ${integer(standing.participants || 0)} 人`, L + rankWidth + 22, 422, 30, soft, Math.max(80, 630 - rankWidth));
  text(`${period}用量`, L, 492, 28, soft);
  const width = text(amount.value, L, 604, 96, ink, 610);
  if (amount.unit) text(amount.unit, L + width + 14, 604, 46, ink, 100);
  text('Tokens', L, 650, 26, soft);
  const codeSize = cover ? 192 : 252, codeY = cover ? 484 : 816;
  drawCodeBadge(ctx, codeImage, R - codeSize, codeY, codeSize);
  if (cover) {
    rule(693);
    text(`${activity.current_streak ? '连续使用' : '最长连续'} ${streak} 天 · 累计活跃 ${activity.active_days || 0} 天`, L, 740, 28, soft, 880);
  } else {
    text(`${integer(usage.summary.tokens)} tokens`, L, 698, 26, soft);
    rule(742);
    text(activity.current_streak ? '连续使用' : '最长连续', L, 814, 26, soft);
    text(`${streak} 天`, L, 884, 52);
    text('累计活跃', L, 954, 26, soft);
    text(`${activity.active_days || 0} 天`, L, 1024, 52);
    text('长按识别小程序码', R - codeSize / 2, 1104, 24, soft, 310, 'center');
  }
  text(`${usage.from} — ${usage.to} · ${usageBasis(usage).shortNote}`, L, H - 22, 20, soft, 880);
}
module.exports = { drawAchievementPoster, ACHIEVEMENT_HEIGHT };
