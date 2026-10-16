const { compact, integer } = require('./usage');
function calendarView(result) {
  const max = Math.max(0, ...result.daily.filter(day => day.reported).map(day => day.tokens));
  const days = result.daily.map(day => ({ ...day, number: Number(day.day.slice(-2)), amount: day.reported ? compact(day.tokens) : null,
    exact: day.reported ? integer(day.tokens) : '', requestsText: day.reported ? integer(day.requests) : '',
    level: !day.reported || !day.tokens ? 0 : Math.min(4, Math.max(1, Math.ceil(day.tokens / max * 4))),
    state: day.future ? 'future' : !day.reported ? 'missing' : day.tokens === 0 ? 'zero' : 'used',
    statusText: day.future ? '未到日期' : !day.reported ? '未同步' : day.tokens === 0 ? '已同步 · 零用量' : '已同步' }));
  const start = (new Date(result.month + '-01T00:00:00Z').getUTCDay() + 6) % 7;
  const cells = [...Array.from({ length: start }, (_, i) => ({ key: 'pad-' + i, padding: true })), ...days.map(day => ({ ...day, key: day.day }))];
  const empty = result.summary.reported_days === 0;
  return { ...result, days, cells, title: result.month.slice(0, 4) + ' 年 ' + Number(result.month.slice(5)) + ' 月',
    amount: empty ? null : compact(result.summary.tokens), exact: empty ? '' : integer(result.summary.tokens) };
}
function weeklyView(usage) {
  const week = usage.weekly, empty = !week || week.reported_days === 0;
  const top = (usage.tools || []).find(row => !row.unclassified && row.tokens > 0);
  const changeText = week?.comparison_status === 'comparable' ? (week.change_percent > 0 ? '+' : '') + week.change_percent + '%'
    : week?.comparison_status === 'ongoing' ? '本周进行中' : week?.comparison_status === 'zero_base' ? '上期为 0' : '记录未齐全';
  const peak = week?.peak;
  const max = Math.max(0, ...(usage.daily || []).filter(row => row.reported).map(row => row.tokens));
  return { ...usage, throughLabel: usage.to.slice(5), amount: empty ? null : compact(usage.summary.tokens), exact: empty ? '' : integer(usage.summary.tokens),
    requestsText: integer(usage.summary.requests), changeText, changeDirection: week?.change_percent > 0 ? 'up' : week?.change_percent < 0 ? 'down' : '',
    topTool: top || null, topModel: week?.top_model || null, peak: peak ? { ...peak, amount: compact(peak.tokens), exact: integer(peak.tokens) } : null,
    daily: (usage.daily || []).map(row => ({ ...row, label: row.day.slice(5).replace('-', '/'),
      height: row.tokens > 0 && max ? Math.max(3, row.tokens / max * 100) : 0,
      exact: row.future ? '未到日期' : row.reported ? integer(row.tokens) + ' tokens' : '未同步' })),
    group: usage.group_standing ? { ...usage.group_standing, rankText: usage.group_standing.rank ? '#' + usage.group_standing.rank : '未上榜' } : null };
}
function weeklyTitle(user, usage) {
  const amount = compact(usage.summary.tokens);
  return `${user.nickname || 'AI 玩家'} · ${usage.from.slice(5)}—${usage.to.slice(5)} · ${amount.value}${amount.unit} Tokens`;
}
function trendsView(result) {
  const max = Math.max(0, ...result.entries.map(row => row[result.metric]));
  return { ...result, entries: result.entries.map(row => ({ ...row, amount: compact(row.tokens), exact: integer(row.tokens),
    width: max ? Math.max(1, row[result.metric] / max * 100) : 0,
    previousValue: row.previous_rank == null ? '上期无记录' : result.metric === 'users' ? row.previous_users + ' 人' : compact(row.previous_tokens).value + ' ' + compact(row.previous_tokens).unit + ' tokens',
    rankText: row.rank_change == null ? '上期无记录' : row.rank_change > 0 ? '上升 ' + row.rank_change : row.rank_change < 0 ? '下降 ' + -row.rank_change : '位次不变',
    changeClass: row.rank_change > 0 ? 'up' : row.rank_change < 0 ? 'down' : '' })) };
}
module.exports = { calendarView, weeklyView, weeklyTitle, trendsView };
