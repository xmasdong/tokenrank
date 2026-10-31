const {compact,formatTokens,integer,PERIODS} = require('./usage');
const {presentCost} = require('./cost');
const {presentAnalysis} = require('./analytics');
function presentGroupInsights(report) {
  const cost=presentCost(report.cost), missing=report.cost?.missing_user_days || 0;
  const note=[cost.unpricedCount ? `${cost.unpricedCount} 个模型未计价` : '',missing ? `${missing} 条成员日记录金额未同步` : ''].filter(Boolean).join(' · ');
  const top=analysis=>analysis.items.find(item=>!item.unclassified && item.tokens>0)?.name || (report.summary.tokens>0 ? '明细未同步' : '暂无用量');
  return {...report,amount:compact(report.summary.tokens),exact:integer(report.summary.tokens),
    periodLabel:PERIODS.find(item=>item.key===report.period)?.label || '今日',range:report.from===report.to ? report.to : `${report.from} — ${report.to}`,
    costText:cost.available ? '$'+cost.amount : '—',costLabel:cost.available && report.cost.status==='partial' ? '已计价部分' : 'API 等值估算',
    costNote:note,topTool:top(report.tools),topModel:top(report.models),
    cacheRead:formatTokens(report.summary.cache_read),cacheWrite:formatTokens(report.summary.cache_write),
    inputText:formatTokens(report.summary.input_tokens),outputText:formatTokens(report.summary.output_tokens),
    tools:presentAnalysis(report.tools),models:presentAnalysis(report.models)};
}
const groupReportTitle=report=>`${report.group.name} · ${report.periodLabel} ${report.amount.value}${report.amount.unit} Tokens · ${report.summary.active_users} 人活跃`;
module.exports={presentGroupInsights,groupReportTitle};
