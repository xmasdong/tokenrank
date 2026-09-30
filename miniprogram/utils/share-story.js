const { compact, formatTokens, integer, usageBasis, PERIODS } = require('./usage');
const nameOf = user => user.nickname || 'AI 玩家';
function story(usage) {
  const label = PERIODS.find(p => p.key === usage.period)?.label || '今日';
  const total = compact(usage.summary.tokens), activity = usage.activity || {}, standing = usage.standing || {};
  const top = (usage.tools || []).find(t => !t.unclassified && t.tokens > 0);
  const streak = activity.current_streak || 0, days = activity.active_days || 0;
  return {
    label, value: total.value, unit: total.unit, ...usageBasis(usage),
    rankText: standing.rank ? `#${integer(standing.rank)}` : '未上榜',
    rankNote: standing.rank ? `${integer(standing.participants)} 位同期上榜用户` : '本周期无 Token 用量',
    streak, streakLabel: streak ? '连续使用' : '最长连续', streakValue: streak || activity.longest_streak || 0,
    streakNote: streak ? `截至 ${activity.streak_as_of}` : '已同步历史', days,
    firstDay: activity.first_day || '', top,
  };
}
function shareTitle(user, usage) {
  const s = story(usage);
  return `${nameOf(user)} · ${s.label} ${formatTokens(usage.summary.tokens)} Tokens${usage.standing?.rank ? ` · 全站 #${usage.standing.rank}` : ''}`;
}
module.exports = { story, shareTitle, nameOf };
