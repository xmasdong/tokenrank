const { compact, PERIODS, usageBasis } = require('./usage');
const { drawCodeBadge } = require('./share-code');

const RANKING_WIDTH = 1000;
const RANKING_HEIGHT = 1540;
const RANKING_COVER_HEIGHT = 800;
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif';
const rankingPosterHeight = data => RANKING_HEIGHT - (5 - Math.max(1, Math.min(5, data.entries.length))) * 160;

function rankingRange(period, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return '';
  const days = { day: 0, week: 6, month: 29 }[period];
  if (days == null) return '';
  const from = new Date(Date.parse(day + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  return from === day ? day : `${from} — ${day}`;
}

function personalRanking(record, board) {
  const rank = record.usage.standing?.rank ?? null;
  const tokens = record.usage.summary.tokens;
  // The public record and ranking must agree on the author's number and rank.
  // Never combine a cached board with a newer personal snapshot.
  if (rank != null && (!board.me || board.me.rank !== rank || board.me.tokens !== tokens)) {
    throw new Error('榜单已有更新，请重新生成');
  }
  const range = record.usage.from === record.usage.to ? record.usage.to : `${record.usage.from} — ${record.usage.to}`;
  return { scope: 'global', name: '全站排名', period: record.usage.period, range, user: record.user,
    entries: board.entries, total: board.total, shortNote: usageBasis(record.usage).shortNote,
    me: { rank, tokens, global_rank: rank, top_model: board.me?.top_model ?? null } };
}

function rankingAvatarUrls(data) {
  return [...new Set([...data.entries.slice(0, 5).map(e => e.avatar_url), data.user?.avatar_url || data.me?.avatar_url].filter(Boolean))];
}

function drawRankingPoster(ctx, { data, cover = false, codeImage, avatarImages = {}, previewOnly = false }) {
  if (!codeImage && !previewOnly) throw new Error('小程序码尚未就绪，请重试');
  const W = RANKING_WIDTH, H = cover ? RANKING_COVER_HEIGHT : rankingPosterHeight(data);
  const L = 44, R = 956, C = { ink: '#191919', soft: '#999999', number: '#D88A2D', rule: '#EDEDED', own: '#F7F7F7' };
  const text = (value, x, y, size, color = C.ink, width = R - L, align = 'left', weight = 400) => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    const chars = [...String(value ?? '')];
    if (ctx.measureText(chars.join('')).width > width) {
      while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
      chars.push('…');
    }
    const content = chars.join('');
    ctx.fillText(content, x, y);
    return ctx.measureText(content).width;
  };
  const line = y => { ctx.fillStyle = C.rule; ctx.fillRect(0, y, W, 1); };
  const avatar = (user, x, y, size) => {
    ctx.save(); ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
    const image = avatarImages[user?.avatar_url];
    if (image) ctx.drawImage(image, x, y, size, size);
    else {
      ctx.fillStyle = C.rule; ctx.fillRect(x, y, size, size);
      text([...(user?.nickname || '我')][0], x + size / 2, y + size * .67, size * .42, C.soft, size, 'center');
    }
    ctx.restore();
  };
  const amountWidth = (tokens, size) => {
    const amount = compact(tokens);
    ctx.font = `400 ${size}px ${FONT}`;
    const numberWidth = ctx.measureText(amount.value).width;
    ctx.font = `400 ${Math.round(size * .68)}px ${FONT}`;
    return numberWidth + (amount.unit ? 10 + ctx.measureText(amount.unit).width : 0);
  };
  const amount = (tokens, right, baseline, size) => {
    const n = compact(tokens), unitSize = Math.round(size * .68);
    ctx.font = `400 ${unitSize}px ${FONT}`;
    const unitWidth = n.unit ? ctx.measureText(n.unit).width : 0;
    if (n.unit) text(n.unit, right, baseline, unitSize, C.number, unitWidth + 1, 'right');
    text(n.value, right - (n.unit ? unitWidth + 10 : 0), baseline, size, C.number, 360, 'right');
  };
  const row = (entry, y, height, own = false, right = R) => {
    const isMe = own || (data.me?.rank != null && entry.rank === data.me.rank);
    if (isMe) { ctx.fillStyle = C.own; ctx.fillRect(0, y, W, height); }
    const size = cover ? 78 : 88, avatarX = 122, nameX = avatarX + size + 28;
    const model = entry.rank == null ? '' : entry.top_model || '';
    const baseline = y + height / 2 + (own || model ? 1 : 15);
    const numberSize = cover ? 48 : 54;
    const numberWidth = entry.tokens == null ? 0 : amountWidth(entry.tokens, numberSize);
    const nameWidth = Math.max(40, right - numberWidth - 34 - nameX);
    text(entry.rank ?? '—', L + 26, y + height / 2 + 13, 36, '#666666', 78, 'center');
    avatar(entry, avatarX, y + (height - size) / 2, size);
    const nameDrawn = text(entry.nickname || 'AI 玩家', nameX, baseline, 40, C.ink, Math.max(24, nameWidth - (isMe ? 44 : 0)));
    if (isMe) text('我', nameX + nameDrawn + 14, baseline, 26, C.soft, 32);
    if (own) {
      const label = entry.rank == null ? (data.emptyLabel || '本周期未上榜') : data.scope === 'group' ? '我的群内排名' : '我的全站排名';
      const global = data.scope === 'group' && entry.global_rank ? ` · 全站 ${entry.global_rank}` : '';
      text(label + global + (model ? ` · ${model}` : ''), nameX, baseline + 38, 24, C.soft, nameWidth);
    } else if (model) text(model, nameX, baseline + 38, 26, C.soft, nameWidth);
    if (entry.tokens != null) amount(entry.tokens, right, y + height / 2 + 18, numberSize);
    line(y + height);
  };
  const shown = cover ? 3 : 5;
  const rows = data.entries.slice(0, shown);
  const period = PERIODS.find(p => p.key === data.period)?.label || '今日';
  const total = data.total ?? data.entries.length;
  const count = `${data.scope === 'group' ? `${data.members || 0} 人已加入 · ` : ''}${total} 人上榜${total > shown ? ` · 前 ${shown} 名` : ''}`;
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
  text('Token 群排名', L, cover ? 38 : 56, 26, C.soft);
  text(period, R, cover ? 38 : 56, 26, C.soft, 180, 'right');
  text(data.name || (data.scope === 'group' ? '本群排名' : '全站排名'), L, cover ? 91 : 120, cover ? 38 : 42, C.ink, R - L, 'left', 500);
  text(data.range || rankingRange(data.period, data.day), L, cover ? 132 : 164, 24, C.soft);
  const headY = cover ? 152 : 192, headH = cover ? 48 : 54;
  ctx.fillStyle = C.own; ctx.fillRect(0, headY, W, headH);
  text(count, L, headY + 35, 24, C.soft, 730);
  text('Token 用量', R, headY + 35, 24, C.soft, 160, 'right');
  const start = headY + headH, rowH = cover ? 130 : 160;
  rows.forEach((entry, i) => row(entry, start + i * rowH, rowH));
  if (!rows.length) text('本周期暂无排名', L, start + 90, 32, C.soft);
  const ownY = start + (cover ? shown : Math.max(1, rows.length)) * rowH + 12, ownH = cover ? 142 : 160;
  row({ ...(data.me || {}), nickname: data.user?.nickname || data.me?.nickname || '我', avatar_url: data.user?.avatar_url || data.me?.avatar_url }, ownY, ownH, true, cover ? 750 : R);
  const codeSize = cover ? 160 : 252, codeX = R - codeSize, codeY = cover ? ownY - 6 : ownY + ownH + 38;
  drawCodeBadge(ctx, codeImage, codeX, codeY, codeSize);
  if (!codeImage) text('小程序码区域', codeX + codeSize / 2, codeY + codeSize / 2 + 8, 20, C.soft, codeSize, 'center');
  if (!cover) {
    text('Token 群排名', L, codeY + 84, 32, C.ink, 620, 'left', 500);
    text('长按识别小程序码', L, codeY + 138, 28, C.soft, 620);
    if (data.scope === 'group') text('入群请点击群内卡片', L, codeY + 184, 24, C.soft, 620);
  }
  text(data.shortNote || '含缓存 · 北京时间', L, H - 26, cover ? 20 : 24, C.soft, cover ? 720 : 620);
}

module.exports = { RANKING_WIDTH, RANKING_HEIGHT, RANKING_COVER_HEIGHT, rankingPosterHeight, personalRanking, rankingAvatarUrls, drawRankingPoster };
