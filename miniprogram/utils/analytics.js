const { compact, integer } = require('./usage');
const COLORS = ['#D88A2D', '#668A75', '#657F99', '#9B8670', '#8B8898'];
function presentAnalysis(result, { metric = 'tokens', name = '' } = {}) {
  const people = metric === 'people' && result.scope === 'public';
  const items = result.items.map((item, index) => ({ ...item, color: item.unclassified ? '#D5D5D5' : COLORS[index % COLORS.length],
    amount: compact(item.tokens), exact: integer(item.tokens), value: people ? item.preferred_users : item.tokens,
    chartPercent: people ? item.preferred_percent : item.percent, selected: item.name === name && !item.unclassified }));
  const sorted = items.filter(item => item.value > 0).sort((a, b) => b.value - a.value);
  const segments = sorted.slice(0, 5);
  if (sorted.length > 5) {
    const rest = sorted.slice(5), value = rest.reduce((sum, item) => sum + item.value, 0);
    segments.push({ key: 'remaining', name: '其他', value, color: '#D5D5D5', aggregate: true,
      chartPercent: Math.round(rest.reduce((sum, item) => sum + item.chartPercent, 0) * 10) / 10 });
  }
  const center = compact(people ? result.summary.users : result.summary.breakdown_tokens);
  const selected = items.find(item => item.selected);
  const daily = result.daily.map(day => ({ ...day, label: day.day.slice(5).replace('-', '/'),
    value: day.reported && !(name && result.tool && day.details_complete === false) ? name ? day.parts.find(item => item.name === name)?.tokens || 0 : day.tokens : null,
  })).map(day => ({ ...day, amount: day.value === null ? '未同步' : compact(day.value),
    exact: day.value === null ? day.reported ? '模型明细待补齐' : '未同步' : integer(day.value) }));
  return { ...result, items, segments, daily, selected: selected || null, amount: compact(result.summary.tokens),
    exact: integer(result.summary.tokens), requestsText: result.summary.requests === null ? '' : integer(result.summary.requests),
    categoryCount: items.filter(item => !item.unclassified).length, centerValue: center.value + center.unit,
    centerLabel: people ? '常用用户' : result.has_overlap ? '明细用量' : 'Tokens' };
}
module.exports = { COLORS, presentAnalysis };
