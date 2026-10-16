const { compact, integer, PERIODS } = require('./usage');
const labelOf = usage => PERIODS.find(p => p.key === usage.period)?.label || '同期';
function toolRows(usage) {
  return (usage.tools || []).map(tool => ({ ...tool,
    percent: Math.max(0, Math.min(100, Number(tool.percent) || 0)),
    formatted: compact(tool.tokens), exact: integer(tool.tokens) }));
}
function participant(record) {
  const { user, usage } = record;
  if (!user || !Number.isSafeInteger(usage?.summary?.tokens) || usage.summary.tokens < 0)
    throw new Error('用量记录暂不可用，请重试');
  const top = toolRows(usage).find(tool => !tool.unclassified && tool.tokens > 0) || null;
  return { nickname: user.nickname || 'AI 玩家', avatar_url: user.avatar_url || '',
    initial: [...(user.nickname || '我')][0], ...compact(usage.summary.tokens), exact: integer(usage.summary.tokens),
    requests: integer(usage.summary.requests), activeDays: usage.summary.active_days || 0, top };
}
function comparisonView(record) {
  const source = record.comparison?.source;
  if (!source || source.usage.from !== record.usage.from || source.usage.to !== record.usage.to ||
    source.usage.token_basis !== record.usage.token_basis || source.usage.timezone !== record.usage.timezone)
    throw new Error('两份记录的日期或统计口径不一致，请重新对比');
  const left = participant(source), right = participant(record);
  return { left, right, from: record.usage.from, to: record.usage.to,
    commonTool: left.top && right.top && left.top.name === right.top.name ? left.top.name : '' };
}
function comparisonTitle(record) {
  const view = comparisonView(record);
  return `${view.left.nickname} / ${view.right.nickname} · 同期用量对比`;
}
function toolsTitle(user, usage) {
  const top = toolRows(usage).find(tool => !tool.unclassified && tool.tokens > 0);
  return `${user.nickname || 'AI 玩家'} · ${labelOf(usage)} · ${top ? top.name + ' ' + top.percent + '%' : '工具偏好'}`;
}
module.exports = { toolRows, participant, comparisonView, comparisonTitle, toolsTitle };
