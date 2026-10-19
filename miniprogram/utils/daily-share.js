const { compact, integer, formatTokens } = require('./usage');
function dailyShareView(usage) {
  const day = usage.report_day || usage.from, summary = usage.summary;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(day || '') || usage.from !== day || usage.to !== day ||
    !Number.isFinite(summary?.tokens) || summary.tokens < 0 || !Number.isFinite(summary.requests) || summary.requests < 0)
    throw new Error('日报分享记录无效');
  const detail = key => Number.isFinite(summary[key]) ? formatTokens(summary[key]) : '—';
  return { day, dateText:day.replace(/-/g,'.'), ...compact(summary.tokens), exact:integer(summary.tokens), requestsText:integer(summary.requests),
    topTool:(usage.tools || []).find(item=>!item.unclassified)?.name || '未分类',
    topModel:(usage.models || []).find(item=>!item.unclassified)?.name || '未分类',
    inputText:detail('input_tokens'), outputText:detail('output_tokens'), cacheReadText:detail('cache_read'), cacheWriteText:detail('cache_write') };
}
function dailyTitle(user, usage) {
  const view = dailyShareView(usage);
  return `${user.nickname || 'AI 玩家'} · ${view.dateText.slice(5)} · ${view.value}${view.unit} Tokens · ${view.requestsText} 次`;
}
module.exports = { dailyShareView, dailyTitle };
