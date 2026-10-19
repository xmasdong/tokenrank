import { beijingDay, jsonError } from './lib.js';
import { buildUsage } from './usage.js';
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const validDay = day => typeof day === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
export const mondayOf = day => addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));
export async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}

async function ownRows(env, userId, from, to, groups = false) {
  const result = await env.DB.batch([
    env.DB.prepare(`SELECT day,tokens,input_tokens,output_tokens,requests,cache_read,cache_write,
      models_json,tools_json,updated_at,cost_json FROM ranked_usage WHERE user_id=?1 AND day>=?2 AND day<=?3 ORDER BY day`).bind(userId, from, to),
    env.DB.prepare(`SELECT MIN(day) AS first_day,MAX(updated_at) AS updated_at FROM ranked_usage WHERE user_id=?1`).bind(userId),
    env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM usage_sync_state WHERE user_id=?1) AS ready,
      EXISTS(SELECT 1 FROM daily_stats WHERE user_id=?1) AS legacy`).bind(userId),
    ...(groups ? [env.DB.prepare(`SELECT g.id,g.name FROM rank_groups g JOIN rank_group_members m ON m.group_id=g.id
      WHERE m.user_id=?1 ORDER BY g.created_at,g.id`).bind(userId)] : []),
  ]);
  const state = result[2].results[0];
  if (!state.ready && state.legacy) return jsonError(409, '请先更新电脑同步器，以查看含缓存的总用量');
  return { rows: result[0].results, history: result[1].results[0], groups: result[3]?.results || [] };
}

export function calendarMonth(value, now = Date.now()) {
  const today = beijingDay(now), month = value || today.slice(0, 7);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > today.slice(0, 7)) return null;
  const from = month + '-01', end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  return { month, from, end, to: end < today ? end : today, today };
}
export async function calendarReport(env, userId, month, now = Date.now()) {
  const range = calendarMonth(month, now);
  if (!range) return jsonError(400, '月份无效，请选择当前或过去的月份');
  const source = await ownRows(env, userId, range.from, range.to);
  if (source instanceof Response) return source;
  const map = new Map(source.rows.map(row => [row.day, row]));
  const count = Number(range.end.slice(-2));
  const daily = Array.from({ length: count }, (_, index) => {
    const day = range.month + '-' + String(index + 1).padStart(2, '0'), row = map.get(day), future = day > range.today;
    return { day, reported: !!row, future, tokens: row?.tokens ?? null, requests: row?.requests ?? null };
  });
  const previous = addDays(range.from, -1).slice(0, 7), next = addDays(range.end, 1).slice(0, 7);
  return Response.json({ month: range.month, today: range.today, timezone: 'Asia/Shanghai', token_basis: 'upstream_total',
    daily, first_day: source.history.first_day, previous_month: previous >= '2000-01' ? previous : null,
    next_month: next <= range.today.slice(0, 7) ? next : null,
    summary: { tokens: source.rows.length ? source.rows.reduce((sum, row) => sum + row.tokens, 0) : null,
      reported_days: source.rows.length, active_days: source.rows.filter(row => row.tokens > 0 || row.requests > 0).length,
      elapsed_days: daily.filter(row => !row.future).length }, updated_at: Math.max(0, ...source.rows.map(row => row.updated_at)) || null });
}

/** A completed Beijing day. Missing reports are distinct from a reported zero. */
export function buildDaily(rows, day) {
  const selected = rows.filter(row => row.day === day), reported = selected.length > 0;
  const usage = buildUsage(selected, 'day', Date.parse(day + 'T23:59:59.999+08:00'));
  return { ...usage, day, has_history: reported,
    summary: reported ? usage.summary : Object.fromEntries(Object.keys(usage.summary).map(key => [key, null])),
    daily: [{ day, reported, tokens: reported ? usage.summary.tokens : null, requests: reported ? usage.summary.requests : null }],
    top_tool: usage.tools.find(item => !item.unclassified) || null,
    top_model: usage.models.find(item => !item.unclassified) || null };
}
export async function dailyReport(env, userId, value, now = Date.now()) {
  const day = value || addDays(beijingDay(now), -1);
  if (!validDay(day) || day >= beijingDay(now)) return jsonError(400, '请选择已经结束的日期');
  const source = await ownRows(env, userId, day, day);
  if (source instanceof Response) return source;
  return Response.json({ ...buildDaily(source.rows, day), first_day: source.history.first_day,
    previous_day: source.history.first_day && day > source.history.first_day ? addDays(day, -1) : null,
    next_day: addDays(day, 1) < beijingDay(now) ? addDays(day, 1) : null });
}

export function weeklyRange(value, now = Date.now()) {
  const today = beijingDay(now), current = mondayOf(today), start = value || addDays(current, -7);
  if (!validDay(start) || mondayOf(start) !== start || start > current) return null;
  const end = addDays(start, 6);
  return { from: start, end, through: end < today ? end : today, today, current, complete: end < today };
}
export function buildWeekly(rows, range) {
  const previousFrom = addDays(range.from, -7), previousTo = addDays(range.from, -1);
  const current = rows.filter(row => row.day >= range.from && row.day <= range.through);
  const previous = rows.filter(row => row.day >= previousFrom && row.day <= previousTo);
  const endAt = Date.parse(range.end + 'T23:59:59.999+08:00');
  const usage = buildUsage(current, 'week', endAt), before = buildUsage(previous, 'week', Date.parse(previousTo + 'T23:59:59.999+08:00'));
  const comparable = range.complete && current.length === 7 && previous.length === 7;
  const comparisonStatus = !range.complete ? 'ongoing' : current.length < 7 || previous.length < 7 ? 'incomplete'
    : before.summary.tokens === 0 ? 'zero_base' : 'comparable';
  const peak = [...current].filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens || a.day.localeCompare(b.day))[0];
  const topModel = usage.models.find(row => !row.unclassified && row.tokens > 0) || null;
  const map = new Map(current.map(row => [row.day, row]));
  return { ...usage, from: range.from, to: range.through, has_history: current.length > 0,
    daily: Array.from({ length: 7 }, (_, index) => {
      const day = addDays(range.from, index), row = map.get(day);
      return { day, reported: !!row, future: day > range.today, tokens: row?.tokens ?? null, requests: row?.requests ?? null };
    }),
    weekly: { week_start: range.from, week_end: range.end, complete: range.complete, reported_days: current.length,
      previous_from: previousFrom, previous_to: previousTo, previous_reported_days: previous.length,
      previous_tokens: previous.length ? before.summary.tokens : null, comparison_status: comparisonStatus,
      change_tokens: comparable ? usage.summary.tokens - before.summary.tokens : null,
      change_percent: comparisonStatus === 'comparable' ? Math.round((usage.summary.tokens - before.summary.tokens) / before.summary.tokens * 1000) / 10 : null,
      peak: peak ? { day: peak.day, tokens: peak.tokens } : null, top_model: topModel },
    updated_at: Math.max(0, ...rows.map(row => row.updated_at)) || null };
}
export async function weeklyReport(env, userId, week, now = Date.now()) {
  const range = weeklyRange(week, now);
  if (!range) return jsonError(400, '周报日期无效，请选择周一及已经开始的周期');
  const source = await ownRows(env, userId, addDays(range.from, -7), range.through, true);
  if (source instanceof Response) return source;
  const usage = buildWeekly(source.rows, range);
  const snapshot = await digest([usage.from, usage.to, usage.summary, usage.tools, usage.models, usage.weekly, usage.daily, usage.updated_at]);
  return Response.json({ ...usage, snapshot, groups: source.groups,
    previous_week: addDays(range.from, -7) >= '2000-01-01' ? addDays(range.from, -7) : null,
    next_week: addDays(range.from, 7) <= range.current ? addDays(range.from, 7) : null, current_week: range.current });
}
