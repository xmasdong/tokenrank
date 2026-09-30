const PERIODS = [
  { key: 'day', label: '今日' }, { key: 'week', label: '近7天' },
  { key: 'month', label: '近30天' }, { key: 'all', label: '累计' },
];
const integer = n => String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function compact(n) {
  n = Number(n);
  n = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (n >= 1e8) return { value: (n / 1e8).toFixed(2), unit: '亿' };
  if (n >= 1e4) return { value: (n / 1e4).toFixed(2).replace(/\.?0+$/, ''), unit: '万' };
  return { value: integer(n), unit: '' };
}
function formatTokens(n) {
  const { value, unit } = compact(n);
  return unit ? `${value} ${unit}` : value;
}
function usageBasis(usage) {
  const original = usage.token_basis === 'upstream_total';
  const timezoneLabel = usage.timezone === 'Asia/Shanghai' ? '北京时间' : 'UTC';
  return { basisLabel: original ? '总用量 · 含缓存' : '输入 + 输出 · 不含缓存', timezoneLabel,
    basisNote: original ? '总用量含缓存。' : '输入 + 输出，不含缓存。',
    shortNote: `${original ? '含缓存' : '不含缓存'} · ${timezoneLabel}` };
}
function present(usage) {
  const summary = usage.summary;
  const peak = Math.max(0, ...usage.daily.map(d => d.tokens));
  const detail = items => items.map(item => ({ ...item, exact: integer(item.tokens), formatted: formatTokens(item.tokens) }));
  return { ...usage, ...usageBasis(usage), ...compact(summary.tokens), exact: integer(summary.tokens),
    periodLabel: PERIODS.find(p => p.key === usage.period)?.label || '今日',
    range: usage.from === usage.to ? usage.to : `${usage.from} — ${usage.to}`,
    requestsText: integer(summary.requests), cacheReadText: formatTokens(summary.cache_read), cacheWriteText: formatTokens(summary.cache_write),
    inputText: formatTokens(summary.input_tokens), outputText: formatTokens(summary.output_tokens),
    syncText: usage.last_report_at ? new Date(usage.last_report_at + 8 * 3600000).toISOString().slice(5,16).replace('T',' ') : '',
    daily: usage.daily.map(d => ({ ...d, label: d.day.slice(5).replace('-', '/'), exact: integer(d.tokens),
      height: d.tokens ? Math.max(3, Math.round(d.tokens / Math.max(1, peak) * 100)) : 0 })),
    peakText: formatTokens(peak),
    models: detail(usage.models), tools: detail(usage.tools),
  };
}
const shareUrl = period => `/pages/share/share?period=${encodeURIComponent(period)}`;
module.exports = { PERIODS, compact, formatTokens, integer, usageBasis, present, shareUrl };
