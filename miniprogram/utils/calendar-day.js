const { compact, integer } = require('./usage');
const { detailsView } = require('./calendar-display');

function dayView(day) {
  const reported = !!day?.reported, details = detailsView(day?.details);
  return {
    reported, amount: reported ? compact(day.tokens) : null,
    exact: reported ? integer(day.tokens) : '',
    cost: reported && details.costAvailable ? details.cost : '—',
    costAvailable: reported && details.costAvailable,
    wideCost: reported && details.costAvailable && details.cost.length > 12,
    costStatus: !reported ? '未同步' : !details.supported ? '暂无估算数据' : details.costAvailable ? '' : details.cost,
    costNote: reported && details.supported ? details.costNote : '',
  };
}

// Legacy calendar responses omit costs. Keep the detail's tokens and costs from
// the same daily report rather than mixing a new price with an older token count.
function dailyRow(report, day, original) {
  if (report?.from !== day || report?.to !== day || (report.day && report.day !== day)) throw new Error('日期明细不匹配，请重试');
  if(typeof report.has_history!=='boolean')throw new Error('当天记录暂不可用');
  const reported = report.has_history === true;
  if (reported && (!Number.isSafeInteger(report.summary?.tokens) || report.summary.tokens < 0)) throw new Error('当天用量暂不可用');
  const details = report.cost && typeof report.cost === 'object' ? {
    ...original.details, cost: report.cost,
    top_model: report.top_model || report.models?.find(model => !model.unclassified && model.tokens > 0) || null,
  } : null;
  return { ...original, day, reported, tokens: reported ? report.summary.tokens : null, details,
    detailView: detailsView(details), statusText: !reported ? '未同步' : report.summary.tokens === 0 ? '已同步 · 零用量' : '已同步' };
}

module.exports = { dayView, dailyRow };
