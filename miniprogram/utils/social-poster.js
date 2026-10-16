const { compact, usageBasis, PERIODS } = require('./usage');
const { drawCodeBadge } = require('./share-code');
const { weeklyView } = require('./history');
const { comparisonView, toolRows } = require('./social-share');
const SOCIAL_HEIGHT = 1280;
function painter(ctx, height) {
  const ink = '#191919', soft = '#777777', orange = '#D88A2D';
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, 1000, height);
  const text = (value, x, y, size, color = ink, width = 880, align = 'left') => {
    ctx.font = `400 ${size}px "PingFang SC", "Helvetica Neue", sans-serif`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    let chars = [...String(value ?? '')];
    if (ctx.measureText(chars.join('')).width > width) {
      while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
      chars.push('…');
    }
    ctx.fillText(chars.join(''), x, y);
    return ctx.measureText(chars.join('')).width;
  };
  const rule = y => { ctx.fillStyle = '#EDEDED'; ctx.fillRect(60, y, 880, 1); };
  const avatar = (user, img, cx, cy, size) => {
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, Math.PI * 2); ctx.clip();
    if (img) ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    else { ctx.fillStyle = '#F2F2F2'; ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
      text([...(user.nickname || '我')][0], cx, cy + size * .16, size * .42, soft, size, 'center'); }
    ctx.restore();
  };
  return { ink, soft, orange, text, rule, avatar };
}
function drawToolsPoster(ctx, { user, usage, cover = false, codeImage, avatarImage }) {
  if (!codeImage) throw new Error('小程序码尚未就绪，请重试');
  const H = cover ? 800 : SOCIAL_HEIGHT, p = painter(ctx, H), rows = toolRows(usage), amount = compact(usage.summary.tokens);
  p.text('Token 群排名', 60, 52, 24, p.soft);
  p.text(PERIODS.find(item => item.key === usage.period)?.label || '同期', 940, 52, 24, p.soft, 220, 'right');
  p.avatar(user, avatarImage, 108, 130, 96);
  p.text(user.nickname || 'AI 玩家', 180, 124, 38, p.ink, 760);
  p.text('工具偏好 · 按 Token 占比', 180, 166, 26, p.soft, 760); p.rule(208);
  const visible = rows.slice(0, cover ? 3 : 5);
  visible.forEach((row, i) => {
    const y = (cover ? 292 : 300) + i * (cover ? 100 : 118);
    p.text(row.name, 60, y, i ? 32 : 42, p.ink, 650);
    p.text(`${row.percent}%`, 940, y, i ? 38 : 58, i ? p.ink : p.orange, 240, 'right');
    ctx.fillStyle = '#F0F0F0'; ctx.fillRect(60, y + 22, 880, 10);
    ctx.fillStyle = i ? '#B8B8B8' : p.orange; ctx.fillRect(60, y + 22, 880 * row.percent / 100, 10);
  });
  if (!visible.length) p.text('暂无工具明细', 60, 330, 32, p.soft);
  if (cover) {
    p.rule(574);
    p.text(`${amount.value}${amount.unit} Tokens`, 60, 644, 48, p.ink, 640);
    p.text(`活跃 ${usage.summary.active_days || 0} 天`, 60, 712, 28, p.soft, 640);
    drawCodeBadge(ctx, codeImage, 748, 580, 192);
  } else {
    p.rule(860); p.text(`${amount.value}${amount.unit} Tokens`, 60, 940, 64, p.ink, 630);
    p.text(`活跃 ${usage.summary.active_days || 0} 天`, 60, 1014, 30, p.soft, 610);
    p.text(`连续使用 ${usage.activity?.current_streak || 0} 天`, 60, 1076, 30, p.soft, 610);
    drawCodeBadge(ctx, codeImage, 688, 950, 252);
    p.text('长按识别小程序码', 814, 1230, 24, p.soft, 310, 'center');
  }
  p.text(`${usage.from} — ${usage.to} · ${usageBasis(usage).shortNote}${cover && rows.length > 3 ? ' · 前 3 项' : ''}`, 60, H - 20, 20, p.soft);
}
function drawComparisonPoster(ctx, record) {
  const { cover = false, codeImage, avatarImages = {} } = record;
  if (!codeImage) throw new Error('小程序码尚未就绪，请重试');
  const H = cover ? 800 : SOCIAL_HEIGHT, p = painter(ctx, H), view = comparisonView(record);
  p.text('同期用量对比', 60, 52, 28);
  p.text(`${view.from} — ${view.to} · 北京时间`, 60, 102, 24, p.soft);
  [view.left, view.right].forEach((side, i) => {
    const cx = i ? 740 : 260;
    p.avatar(side, avatarImages[side.avatar_url], cx, 196, 96);
    p.text(side.nickname, cx, 288, 32, p.ink, 400, 'center');
    p.text(i ? (record.transient ? '我' : '参与者') : (record.transient ? '群友' : '原作者'), cx, 326, 22, p.soft, 400, 'center');
    p.text(`${side.value}${side.unit}`, cx, 430, 64, p.orange, 420, 'center');
    p.text('Tokens', cx, 474, 24, p.soft, 400, 'center');
    if (cover) {
      p.text(`活跃 ${side.activeDays} 天`, cx, 540, 30, p.ink, 400, 'center');
      p.text(side.top?.name || '暂无工具明细', cx, 626, 26, p.ink, 280, 'center');
      if (side.top) p.text(`${side.top.percent}%`, cx, 668, 30, p.soft, 280, 'center');
    } else {
      p.text(side.exact, cx, 514, 24, p.soft, 420, 'center');
      p.text(`${side.requests} 次调用`, cx, 618, 34, p.ink, 420, 'center');
      p.text(`活跃 ${side.activeDays} 天`, cx, 706, 34, p.ink, 420, 'center');
      p.text(side.top?.name || '暂无工具明细', cx, 810, 30, p.ink, 420, 'center');
      if (side.top) p.text(`${side.top.percent}%`, cx, 858, 32, p.soft, 420, 'center');
    }
  });
  if (cover) drawCodeBadge(ctx, codeImage, 404, 578, 192);
  else {
    p.rule(904);
    p.text(view.commonTool ? `共同工具 · ${view.commonTool}` : `同一日期范围 · ${record.transient ? '本次读取的记录' : '分享时的记录'}`, 500, 958, 26, p.soft, 880, 'center');
    drawCodeBadge(ctx, codeImage, 374, 982, 252);
  }
  p.text(`${usageBasis(record.usage).shortNote} · 用量不代表产出`, 60, H - 20, 20, p.soft);
}
function drawWeeklyPoster(ctx, { user, usage, cover = false, codeImage, avatarImage }) {
  if (!codeImage) throw new Error('小程序码尚未就绪，请重试');
  const H = cover ? 800 : SOCIAL_HEIGHT, p = painter(ctx, H), v = weeklyView(usage);
  if (!v.amount) throw new Error('本周暂无同步记录');
  p.text('个人周报', 60, 52, 28);
  p.text(v.weekly.complete ? '周一至周日' : '本周进行中', 940, 52, 24, p.soft, 400, 'right');
  p.avatar(user, avatarImage, 108, 130, 96);
  p.text(user.nickname || 'AI 玩家', 180, 124, 38, p.ink, 760);
  p.text(`${v.from} — ${v.to}`, 180, 166, 26, p.soft, 760); p.rule(208);
  p.text('已同步用量 · Tokens', 60, 262, 26, p.soft);
  p.text(`${v.amount.value}${v.amount.unit}`, 60, 354, 92, p.orange);
  p.text(`${v.exact} tokens`, 60, 396, 24, p.soft);
  [[String(v.summary.active_days), '活跃天数'], [v.requestsText, '调用次数'], [`${v.weekly.reported_days} / 7`, '已同步天数']].forEach(([value, label], i) => {
    const x = 60 + i * 306;
    p.text(value, x, 470, 40, p.ink, 270); p.text(label, x, 510, 24, p.soft, 270);
  });
  p.rule(544);
  const groupText = v.group ? `${v.group.name} · ${v.group.hidden ? '未参与排名' : v.group.rankText}` : '';
  if (cover) {
    p.text(`较上周 · ${v.changeText}`, 60, 610, 30, p.ink, 660);
    p.text(groupText || `单日峰值 · ${v.peak ? v.peak.day.slice(5) + ' · ' + v.peak.amount.value + v.peak.amount.unit : '—'}`, 60, 670, 28, p.ink, 660);
    p.text(`上周同步 ${v.weekly.previous_reported_days} / 7 天`, 60, 724, 24, p.soft, 660);
    drawCodeBadge(ctx, codeImage, 748, 580, 192);
  } else {
    const line = (label, value, y, width = 660) => { p.text(label, 60, y, 26, p.soft, width); p.text(value, 60, y + 48, 36, p.ink, width); };
    line(`较上周 · 上周同步 ${v.weekly.previous_reported_days} / 7 天`, v.changeText, 600, 880);
    line('单日峰值', v.peak ? `${v.peak.day.slice(5)} · ${v.peak.amount.value}${v.peak.amount.unit}` : '—', 714, 880);
    line('最常用工具', v.topTool ? `${v.topTool.name} · ${v.topTool.percent}%` : '暂无工具明细', 828, 880);
    line('最常用模型', v.topModel ? `${v.topModel.name} · ${v.topModel.percent}%` : '暂无模型明细', 942, 600);
    if (v.group) line(`本期 ${v.group.participants} 人上榜 · 当前成员`, groupText, 1070, 600);
    drawCodeBadge(ctx, codeImage, 688, 950, 252);
    p.text('长按识别小程序码', 814, 1230, 24, p.soft, 310, 'center');
  }
  p.text(`${usageBasis(usage).shortNote} · 分享时的记录`, 60, H - 20, 20, p.soft);
}
module.exports = { SOCIAL_HEIGHT, drawToolsPoster, drawComparisonPoster, drawWeeklyPoster };
