import { usageWindow } from './usage.js';
import { beijingDaysAgo, jsonError } from './lib.js';
import { insightPolicy } from './insight-access.js';
import { toolModelRows } from './tool-models.js';
const positive = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const percent = (value, total) => total ? Math.round(value / total * 1000) / 10 : 0;
const UNKNOWN = '其他 / 未分类';
const byTokens = (a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name);

export async function analyticsRows(env, { scope, userId = null, period, dimension, tool = '', trend = true, now = Date.now() }) {
  if (tool) return toolModelRows(env, { scope, userId, period, tool, trend, now });
  const range = usageWindow(period, now), view = scope === 'mine' ? 'ranked_usage' : 'public_usage';
  const column = dimension === 'models' ? 'models_json' : 'tools_json';
  const where = `ds.day>=?1 AND ds.day<=?2 AND (?3 IS NULL OR ds.user_id=?3)
    AND (?3 IS NOT NULL OR ds.user_id IN (SELECT user_id FROM ${view} WHERE day>=?4 AND day<=?2 GROUP BY user_id HAVING SUM(tokens)>0))`;
  const values = (from, cohortFrom = range.from) => [from, range.to, scope === 'mine' ? userId : null, cohortFrom];
  const totals = `SUM(tokens) AS tokens, SUM(requests) AS requests, MAX(updated_at) AS updated_at,
    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write`;
  const pair = `CASE WHEN je.type='array' THEN je.value ELSE '[]' END`;
  const detailWhere = `json_type(${pair},'$[0]')='text' AND LENGTH(json_extract(${pair},'$[0]'))>0
    AND json_type(${pair},'$[1]') IN ('integer','real') AND json_extract(${pair},'$[1]')>0`;
  const detailSource = `${view} ds, json_each(CASE WHEN json_valid(ds.${column}) THEN
    CASE WHEN json_type(ds.${column})='array' THEN ds.${column} ELSE '[]' END ELSE '[]' END) je`;
  const trendDays = period === 'day' || period === 'week' ? 7 : 30;
  const trendFrom = beijingDaysAgo(trendDays - 1, now);
  const statements = [
    env.DB.prepare(`SELECT ds.user_id AS uid, ${totals},
      COUNT(CASE WHEN tokens>0 OR requests>0 THEN 1 END) AS active_days,
      MIN(CASE WHEN tokens>0 OR requests>0 THEN day END) AS first_day
      FROM ${view} ds WHERE ${where} GROUP BY ds.user_id`).bind(...values(range.from)),
    env.DB.prepare(`SELECT ds.user_id AS uid, json_extract(${pair},'$[0]') AS name,
      SUM(json_extract(${pair},'$[1]')) AS tokens FROM ${detailSource}
      WHERE ${where} AND ${detailWhere} GROUP BY ds.user_id,name`).bind(...values(range.from)),
    ...(trend ? [env.DB.prepare(`SELECT ds.user_id AS uid, ds.day, SUM(tokens) AS tokens, SUM(requests) AS requests
      FROM ${view} ds WHERE ${where} GROUP BY ds.user_id,ds.day`).bind(...values(trendFrom, trendFrom)),
      env.DB.prepare(`SELECT ds.user_id AS uid,ds.day,json_extract(${pair},'$[0]') AS name,
        SUM(json_extract(${pair},'$[1]')) AS tokens FROM ${detailSource}
        WHERE ${where} AND ${detailWhere} GROUP BY ds.user_id,ds.day,name`).bind(...values(trendFrom, trendFrom))] : []),
  ];
  // D1 batch is one transaction: a concurrent five-minute report cannot split
  // the headline, breakdown and trend into different source versions.
  const [users, details, days = { results: [] }, dayDetails = { results: [] }] = await env.DB.batch(statements);
  return { scope, dimension, range, now, trendDays, users: users.results, details: details.results, days: days.results, dayDetails: dayDetails.results };
}

export function aggregateAnalytics(rows) {
  const { scope, dimension, range, now, trendDays } = rows;
  const unknownName = rows.unknownName || UNKNOWN;
  const users = new Map(rows.users.map(row => [row.uid, row]));
  const perUser = new Map(), items = new Map(), preferences = new Map();
  const item = (name, unclassified = false) => {
    const key = unclassified ? 'unclassified' : 'named:' + name;
    if (!items.has(key)) items.set(key, { key, name, unclassified, tokens: 0, users: new Set(), preferred_users: 0 });
    return items.get(key);
  };
  for (const row of rows.details) {
    if (!users.has(row.uid)) continue;
    const tokens = positive(row.tokens); if (!tokens) continue;
    const entry = item(row.name); entry.tokens += tokens; entry.users.add(row.uid);
    if (!perUser.has(row.uid)) perUser.set(row.uid, []);
    perUser.get(row.uid).push({ name: row.name, tokens });
  }
  const summary = { tokens: 0, requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
    active_days: 0, users: 0, detail_users: perUser.size, breakdown_tokens: 0, unclassified_tokens: 0 };
  for (const row of users.values()) {
    for (const key of ['tokens','requests','input_tokens','output_tokens','cache_read','cache_write','active_days']) summary[key] += positive(row[key]);
    const named = (perUser.get(row.uid) || []).sort(byTokens), classified = named.reduce((sum, value) => sum + value.tokens, 0);
    const missing = Math.max(0, positive(row.tokens) - classified), denominator = Math.max(positive(row.tokens), classified);
    summary.breakdown_tokens += denominator; summary.unclassified_tokens += missing;
    if (missing) { const unknown = item(unknownName, true); unknown.tokens += missing; unknown.users.add(row.uid); }
    if (row.tokens > 0 || row.requests > 0) {
      summary.users++;
      // Dominant unclassified data cannot be used to infer a tool preference.
      if (named[0] && named[0].tokens > missing) {
        item(named[0].name).preferred_users++;
        preferences.set(row.uid, { name: named[0].name, tokens: named[0].tokens, percent: percent(named[0].tokens, denominator) });
      } else item(unknownName, true).preferred_users++;
    }
  }
  const details = [...items.values()].sort(byTokens).map(row => ({ ...row, users: row.users.size,
    percent: percent(row.tokens, summary.breakdown_tokens), preferred_percent: percent(row.preferred_users, summary.users) }));
  const dayMap = new Map(), detailMap = new Map();
  for (const row of rows.dayDetails) {
    const key = row.uid + ':' + row.day;
    if (!detailMap.has(key)) detailMap.set(key, []);
    detailMap.get(key).push({ name: row.name, tokens: positive(row.tokens) });
  }
  for (const row of rows.days) {
    if (!dayMap.has(row.day)) dayMap.set(row.day, { day: row.day, tokens: 0, requests: 0, reported_users: 0, parts: new Map() });
    const day = dayMap.get(row.day), named = detailMap.get(row.uid + ':' + row.day) || [];
    day.tokens += positive(row.tokens); day.requests += positive(row.requests); day.reported_users++;
    for (const detail of named) day.parts.set(detail.name, (day.parts.get(detail.name) || 0) + detail.tokens);
    const missing = Math.max(0, positive(row.tokens) - named.reduce((sum, detail) => sum + detail.tokens, 0));
    if (missing) day.parts.set(unknownName, (day.parts.get(unknownName) || 0) + missing);
  }
  const daily = Array.from({ length: trendDays }, (_, i) => {
    const day = beijingDaysAgo(trendDays - 1 - i, now), value = dayMap.get(day);
    return value ? { day, tokens: value.tokens, requests: value.requests, reported: true, reported_users: value.reported_users,
      ...(rows.tool ? { details_complete: !rows.incompleteDays.has(day) } : {}),
      parts: [...value.parts].map(([name, tokens]) => ({ name, tokens })) }
      : { day, tokens: null, requests: null, reported: false, reported_users: 0, parts: [] };
  });
  const firstDays = rows.users.map(row => row.first_day).filter(Boolean).sort();
  if (rows.tool) for (const key of ['requests', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write']) summary[key] = null;
  return { preferences, users, data: { scope, dimension, period: range.period, timezone: 'Asia/Shanghai', token_basis: 'upstream_total',
    ...(rows.tool ? { tool: rows.tool, association: { linked_tokens: summary.breakdown_tokens - summary.unclassified_tokens,
      unlinked_tokens: summary.unclassified_tokens, percent: percent(summary.breakdown_tokens - summary.unclassified_tokens, summary.breakdown_tokens) } } : {}),
    from: range.period === 'all' ? firstDays[0] || range.to : range.from, to: range.to, summary,
    items: details, daily, trend_days: trendDays, updated_at: rows.users.reduce((latest, row) => Math.max(latest, positive(row.updated_at)), 0) || null,
    preference_basis: 'largest_reported_share_including_unclassified', has_overlap: summary.breakdown_tokens > summary.tokens } };
}

export async function communityAudience(env, query, origin) {
  const { period, dimension, name, tool = '', offset = 0, snapshot = '' } = query;
  const rows = await analyticsRows(env, { scope: 'public', period, dimension, tool, trend: false });
  const aggregate = aggregateAnalytics(rows);
  if (!aggregate.data.items.some(row => !row.unclassified && row.name === name)) return jsonError(404, '本期暂无该工具或模型数据');
  const profiles = await env.DB.prepare(`SELECT id,nickname,avatar_path FROM users WHERE disabled_at IS NULL AND rank_hidden=0
    AND id IN (SELECT user_id FROM public_usage WHERE day>=?1 AND day<=?2 GROUP BY user_id HAVING SUM(tokens)>0)`)
    .bind(rows.range.from, rows.range.to).all();
  const selected = profiles.results.filter(user => aggregate.preferences.get(user.id)?.name === name)
    .map(user => ({ ...user, ...aggregate.preferences.get(user.id), total_tokens: aggregate.users.get(user.id).tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.id - b.id);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([period, dimension, tool, rows.range, name, selected])));
  const current = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (offset && snapshot !== current) return jsonError(409, '数据已有更新，请刷新后继续查看');
  const next = offset + Math.min(50, Math.max(0, selected.length - offset));
  return Response.json({ period, dimension, name, ...(tool ? { tool } : {}), from: aggregate.data.from, to: aggregate.data.to, total: selected.length,
    snapshot: current, has_more: next < selected.length, next_offset: next < selected.length ? next : null,
    updated_at: aggregate.data.updated_at, access: insightPolicy(env, 'community_audience'),
    entries: selected.slice(offset, next).map((row, i) => ({ rank: offset + i + 1,
      nickname: row.nickname || `AI玩家-${String(row.id).slice(-4).padStart(4, '0')}`,
      avatar_url: row.avatar_path ? origin + '/avatars/' + row.avatar_path : null,
      tokens: row.tokens, percent: row.percent, total_tokens: row.total_tokens })) });
}

export function analyticsQuery(url) {
  const period = url.searchParams.get('period') || 'day', dimension = url.searchParams.get('dimension') || 'tools';
  const tool = url.searchParams.get('tool') || '';
  return ['day','week','month','all'].includes(period) && ['tools','models'].includes(dimension) &&
    (!tool || (dimension === 'models' && tool.trim() && tool.length <= 60)) ? { period, dimension, ...(tool ? { tool } : {}) } : null;
}
