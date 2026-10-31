import { usageWindow } from './usage.js';
import { beijingDaysAgo, jsonError } from './lib.js';
import { aggregateAnalytics } from './analytics.js';
import { buildCosts } from './costs.js';

export const groupPeriod = value => ['day', 'week', 'month'].includes(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
  .map(n => n.toString(16).padStart(2, '0')).join('');
function pairs(value) {
  try { const data = JSON.parse(value || '[]'); return Array.isArray(data) ? data.filter(row => Array.isArray(row) && typeof row[0] === 'string' && row[0] && Number.isFinite(row[1]) && row[1] > 0) : []; }
  catch { return []; }
}
function dimension(rows, range, now, name) {
  const selected = rows.filter(row => row.day >= range.from), users = new Map(), details = [], dayDetails = [];
  for (const row of selected) {
    if (!users.has(row.user_id)) users.set(row.user_id, { uid: row.user_id, tokens: 0, requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, active_days: 0 });
    const user = users.get(row.user_id);
    for (const key of ['tokens','requests','input_tokens','output_tokens','cache_read','cache_write']) user[key] += row[key] || 0;
    if (row.tokens > 0) user.active_days++;
    user.updated_at = Math.max(user.updated_at || 0, row.updated_at || 0);
    for (const [label, tokens] of pairs(row[name + '_json'])) details.push({ uid: row.user_id, name: label, tokens });
  }
  // aggregateAnalytics expects one period total per user/category, not one per user-day.
  const combined = new Map();
  for (const row of details) { const key = JSON.stringify([row.uid,row.name]); if (!combined.has(key)) combined.set(key,{...row,tokens:0}); combined.get(key).tokens += row.tokens; }
  for (const row of rows) for (const [label,tokens] of pairs(row[name + '_json'])) dayDetails.push({ uid:row.user_id,day:row.day,name:label,tokens });
  return aggregateAnalytics({ scope:'group', dimension:name, range, now, trendDays:range.period === 'month' ? 30 : 7,
    users:[...users.values()], details:[...combined.values()], days:rows.map(row=>({...row,uid:row.user_id})), dayDetails }).data;
}
export async function loadGroupInsights(env, userId, groupId, period = 'day', now = Date.now()) {
  if (!groupPeriod(period)) return jsonError(400, '群数据周期无效');
  const member = await env.DB.prepare(`SELECT g.name FROM rank_groups g JOIN rank_group_members m ON m.group_id=g.id
    JOIN users u ON u.id=m.user_id WHERE g.id=?1 AND m.user_id=?2 AND u.disabled_at IS NULL`).bind(groupId,userId).first();
  if (!member) return jsonError(403,'请先加入这个群榜');
  const range=usageWindow(period,now), from=beijingDaysAgo(period === 'month' ? 29 : 6,now);
  // Both dimensions and the cost use this one read transaction and the exact same public cohort as the ranking.
  const [groups,source] = await env.DB.batch([
    env.DB.prepare(`SELECT name,(SELECT COUNT(*) FROM rank_group_members WHERE group_id=g.id) AS members FROM rank_groups g WHERE id=?1`).bind(groupId),
    env.DB.prepare(`SELECT d.user_id,d.day,d.tokens,d.requests,d.input_tokens,d.output_tokens,d.cache_read,d.cache_write,
      d.models_json,d.tools_json,d.cost_json,d.updated_at FROM public_usage d JOIN rank_group_members m ON m.user_id=d.user_id
      WHERE m.group_id=?1 AND m.hidden=0 AND d.day>=?2 AND d.day<=?3 ORDER BY d.day,d.user_id`).bind(groupId,from,range.to)
  ]);
  const group=groups.results[0]; if (!group) return jsonError(404,'群不存在或已解散');
  const rows=source.results, selected=rows.filter(row=>row.day>=range.from), tools=dimension(rows,range,now,'tools'), models=dimension(rows,range,now,'models');
  const cost=buildCosts(selected), missing=selected.filter(row=>buildCosts([row]).missing_days>0);
  for (const data of [tools,models]) data.summary.active_days=new Set(selected.filter(row=>row.tokens>0).map(row=>row.day)).size;
  cost.missing_user_days=cost.missing_days; cost.missing_days=new Set(missing.map(row=>row.day)).size;
  const report={ group, period, from:range.from, to:range.to, timezone:'Asia/Shanghai', token_basis:'upstream_total',
    summary:{...tools.summary, active_users:tools.summary.users, reported_users:new Set(selected.map(row=>row.user_id)).size,
      active_days:new Set(selected.filter(row=>row.tokens>0).map(row=>row.day)).size},
    tools, models, cost, updated_at:tools.updated_at,
    coverage:{basis:'current_public_group_members_selected_source',members:group.members, reported_users:new Set(selected.map(row=>row.user_id)).size} };
  const guard={group_id:groupId,contributors:[...new Set(rows.map(row=>row.user_id))].sort((a,b)=>a-b)};
  report.snapshot=await digest([report,guard]);
  return {report,guard};
}
export async function groupShareValid(env, ownerId, guard) {
  if (!guard || !Array.isArray(guard.contributors) || !guard.group_id) return false;
  const owner=await env.DB.prepare(`SELECT 1 AS ok FROM rank_group_members m JOIN users u ON u.id=m.user_id
    WHERE m.group_id=?1 AND m.user_id=?2 AND u.disabled_at IS NULL`).bind(guard.group_id,ownerId).first();
  if (!owner) return false;
  const current=await env.DB.prepare(`SELECT m.user_id FROM rank_group_members m JOIN users u ON u.id=m.user_id
    WHERE m.group_id=?1 AND m.hidden=0 AND u.rank_hidden=0 AND u.disabled_at IS NULL
    AND m.user_id IN (SELECT value FROM json_each(?2))`).bind(guard.group_id,JSON.stringify(guard.contributors)).all();
  return current.results.length===guard.contributors.length;
}
