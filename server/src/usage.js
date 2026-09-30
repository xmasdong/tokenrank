import { beijingDay, beijingDaysAgo as daysAgo } from './lib.js';

export function usageWindow(value, now = Date.now()) {
  const period = ['day', 'week', 'month', 'all'].includes(value) ? value : 'day';
  const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
  return { period, from: period === 'all' ? '0000-01-01' : daysAgo(days - 1, now),
    to: beijingDay(now), trendDays: period === 'day' ? 7 : days };
}

const count = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);

/** Activity uses Beijing days with real tokens or requests; an unfinished today does not break yesterday's streak. */
export function buildActivity(rows, now = Date.now()) {
  const today = beijingDay(now), yesterday = daysAgo(1, now);
  const days = [...new Set(rows.filter(r => r.day <= today && (count(r.tokens) > 0 || count(r.requests) > 0))
    .map(r => r.day).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day + 'T00:00:00Z'))
      && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day))].sort();
  let longest = 0, run = 0, previous = null;
  for (const day of days) {
    const ms = Date.parse(day + 'T00:00:00Z');
    run = previous !== null && ms - previous === 86400000 ? run + 1 : 1;
    longest = Math.max(longest, run); previous = ms;
  }
  const latest = days.at(-1) || null;
  return { active_days: days.length, first_day: days[0] || null, last_day: latest,
    current_streak: latest === today || latest === yesterday ? run : 0,
    streak_as_of: latest === today || latest === yesterday ? latest : null, longest_streak: longest };
}
function addDetails(map, json) {
  let values;
  try { values = JSON.parse(json || '[]'); } catch { return; }
  if (!Array.isArray(values)) return;
  for (const pair of values) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[0]) continue;
    const tokens = count(pair[1]);
    if (tokens) map.set(pair[0], (map.get(pair[0]) || 0) + tokens);
  }
}
function breakdown(map, total) {
  const reported = [...map.values()].reduce((a, b) => a + b, 0);
  const denominator = Math.max(reported, total);
  const items = [...map].map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  if (total > reported) items.push({ name: '其他 / 未分类', tokens: total - reported, unclassified: true });
  return items.map(item => ({ ...item, percent: denominator ? Math.round(item.tokens / denominator * 1000) / 10 : 0 }));
}

/** 仅处理已按登录用户过滤的日聚合；不依赖用户是否入群或是否上榜。 */
export function buildUsage(rows, period, now = Date.now()) {
  const window = usageWindow(period, now);
  const selected = rows.filter(r => r.day >= window.from && r.day <= window.to);
  const summary = { tokens: 0, input_tokens: 0, output_tokens: 0, requests: 0, cache_read: 0, cache_write: 0, active_days: 0 };
  const models = new Map(), tools = new Map();
  for (const row of selected) {
    for (const key of ['tokens', 'input_tokens', 'output_tokens', 'requests', 'cache_read', 'cache_write']) summary[key] += count(row[key]);
    if (row.tokens > 0 || row.requests > 0) summary.active_days++;
    addDetails(models, row.models_json);
    addDetails(tools, row.tools_json);
  }
  const byDay = new Map(rows.map(row => [row.day, row]));
  const daily = Array.from({ length: window.trendDays }, (_, i) => {
    const day = daysAgo(window.trendDays - 1 - i, now);
    const row = byDay.get(day);
    return { day, tokens: count(row?.tokens), requests: count(row?.requests) };
  });
  return {
    period: window.period, timezone: 'Asia/Shanghai', token_basis: 'upstream_total',
    from: window.period === 'all' ? selected.find(row => row.tokens > 0 || row.requests > 0)?.day || window.to : window.from, to: window.to,
    summary, daily,
    trend_days: window.trendDays,
    models: breakdown(models, summary.tokens), tools: breakdown(tools, summary.tokens),
    updated_at: selected.reduce((latest, row) => Math.max(latest, count(row.updated_at)), 0) || null,
  };
}
