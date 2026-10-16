import { aggregateAnalytics } from './analytics.js';
import { beijingDay, jsonError } from './lib.js';
import { addDays, validDay, digest } from './history.js';

export function trendQuery(url, now = Date.now()) {
  const period = url.searchParams.get('period') || 'week', dimension = url.searchParams.get('dimension') || 'tools';
  const metric = url.searchParams.get('metric') || 'users', yesterday = addDays(beijingDay(now), -1);
  const end = url.searchParams.get('end') || yesterday, offsetText = url.searchParams.get('offset') || '0';
  const snapshot = url.searchParams.get('snapshot') || '', offset = Number(offsetText);
  if (!['week', 'month'].includes(period) || !['tools', 'models'].includes(dimension) || !['users', 'tokens'].includes(metric) ||
    !validDay(end) || end > yesterday || !/^\d{1,8}$/.test(offsetText) || (offset > 0 && !/^[a-f0-9]{64}$/.test(snapshot))) return null;
  const days = period === 'week' ? 7 : 30;
  return { period, dimension, metric, end, from: addDays(end, 1 - days),
    previous_from: addDays(end, 1 - days * 2), previous_to: addDays(end, -days), offset, snapshot };
}
export async function trendReport(env, query) {
  const { period, dimension, metric, from, end, previous_from, previous_to, offset, snapshot } = query;
  const column = dimension === 'models' ? 'models_json' : 'tools_json';
  const part = `CASE WHEN ds.day>=?3 THEN 1 ELSE 0 END`;
  const pair = `CASE WHEN je.type='array' THEN je.value ELSE '[]' END`;
  const [totals, details] = await env.DB.batch([
    env.DB.prepare(`SELECT ds.user_id AS uid,${part} AS part,SUM(tokens) AS tokens,SUM(requests) AS requests,
      MAX(updated_at) AS updated_at,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,
      SUM(cache_read) AS cache_read,SUM(cache_write) AS cache_write,
      COUNT(CASE WHEN tokens>0 OR requests>0 THEN 1 END) AS active_days,
      MIN(CASE WHEN tokens>0 OR requests>0 THEN day END) AS first_day FROM public_usage ds WHERE ds.day>=?1 AND ds.day<=?2 GROUP BY ds.user_id,part`)
      .bind(previous_from, end, from),
    env.DB.prepare(`SELECT ds.user_id AS uid,${part} AS part,json_extract(${pair},'$[0]') AS name,
      SUM(json_extract(${pair},'$[1]')) AS tokens FROM public_usage ds,
      json_each(CASE WHEN json_valid(ds.${column}) THEN CASE WHEN json_type(ds.${column})='array' THEN ds.${column} ELSE '[]' END ELSE '[]' END) je
      WHERE ds.day>=?1 AND ds.day<=?2 AND json_type(${pair},'$[0]')='text' AND LENGTH(json_extract(${pair},'$[0]'))>0
      AND json_type(${pair},'$[1]') IN ('integer','real') AND json_extract(${pair},'$[1]')>0 GROUP BY ds.user_id,part,name`)
      .bind(previous_from, end, from),
  ]);
  const build = part => aggregateAnalytics({ scope: 'public', dimension, range: { period, from: part ? from : previous_from, to: part ? end : previous_to },
    now: Date.parse(end + 'T23:59:59.999+08:00'), trendDays: 0, users: totals.results.filter(row => row.part === part && row.tokens > 0),
    details: details.results.filter(row => row.part === part), days: [], dayDetails: [] }).data;
  const current = build(1), previous = build(0);
  const sort = items => items.filter(row => !row.unclassified && row[metric] > 0).sort((a, b) => b[metric] - a[metric] ||
    b[metric === 'users' ? 'tokens' : 'users'] - a[metric === 'users' ? 'tokens' : 'users'] || a.name.localeCompare(b.name));
  const before = new Map(sort(previous.items).map((row, index) => [row.name, { ...row, rank: index + 1 }]));
  const entries = sort(current.items).map((row, index) => {
    const old = before.get(row.name);
    return { rank: index + 1, name: row.name, users: row.users, tokens: row.tokens, percent: row.percent,
      previous_rank: old?.rank ?? null, previous_users: old?.users ?? null, previous_tokens: old?.tokens ?? null,
      rank_change: old ? old.rank - index - 1 : null, value_change: old ? row[metric] - old[metric] : null };
  });
  const fingerprint = await digest([period, dimension, metric, from, end, current.summary, previous.summary, entries]);
  if (offset > 0 && snapshot !== fingerprint) return jsonError(409, '趋势榜已有更新，请刷新后继续查看');
  const slice = entries.slice(offset, offset + 50), next = offset + slice.length;
  return Response.json({ period, dimension, metric, from, to: end, previous_from, previous_to,
    timezone: 'Asia/Shanghai', token_basis: 'upstream_total', summary: current.summary, previous_summary: previous.summary,
    entries: slice, total: entries.length, snapshot: fingerprint, has_more: next < entries.length, next_offset: next < entries.length ? next : null,
    updated_at: Math.max(current.updated_at || 0, previous.updated_at || 0) || null });
}
