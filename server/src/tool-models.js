import { usageWindow } from './usage.js';
import { beijingDaysAgo } from './lib.js';
const parse = value => { try { const rows = JSON.parse(value || '[]'); return Array.isArray(rows) ? rows : []; } catch { return []; } };
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 60;
const count = value => Number.isSafeInteger(value) && value >= 0;

// Independent tool/model totals cannot reconstruct a joint distribution.
// Only explicit event-level associations are used; old reports stay unlinked.
export async function toolModelRows(env, { scope, userId, period, tool, trend = true, now = Date.now() }) {
  const range = usageWindow(period, now), view = scope === 'mine' ? 'ranked_usage' : 'public_usage';
  const trendDays = period === 'day' || period === 'week' ? 7 : 30;
  const trendFrom = beijingDaysAgo(trendDays - 1, now);
  const select = from => env.DB.prepare(`SELECT user_id AS uid,day,tokens,tools_json,tool_models_json,updated_at
    FROM ${view} WHERE day>=?1 AND day<=?2 AND (?3 IS NULL OR user_id=?3) ORDER BY day,user_id`)
    .bind(from, range.to, scope === 'mine' ? userId : null);
  const [periodRows, trendRows = { results: [] }] = await env.DB.batch([select(range.from), ...(trend ? [select(trendFrom)] : [])]);
  function convert(rows) {
    const users = new Map(), details = new Map(), days = [], dayDetails = [], incompleteDays = new Set();
    for (const row of rows) {
      const tools = parse(row.tools_json).filter(pair => Array.isArray(pair) && name(pair[0]) && count(pair[1]));
      const tokens = Math.min(row.tokens, tools.filter(pair => pair[0] === tool).reduce((sum, pair) => sum + pair[1], 0));
      let pairs = parse(row.tool_models_json).filter(pair => Array.isArray(pair) && pair.length === 3 &&
        pair[0] === tool && name(pair[1]) && count(pair[2]) && pair[2] > 0);
      const seen = new Set();
      if (pairs.reduce((sum, pair) => sum + pair[2], 0) > tokens || pairs.some(pair => seen.has(pair[1]) || !seen.add(pair[1]))) pairs = [];
      const linked = pairs.reduce((sum, pair) => sum + pair[2], 0);
      if (linked < tokens || (!tokens && tools.reduce((sum, pair) => sum + pair[1], 0) < row.tokens)) incompleteDays.add(row.day);
      const day = { uid: row.uid, day: row.day, tokens, requests: 0 }; days.push(day);
      if (!users.has(row.uid)) users.set(row.uid, { uid: row.uid, tokens: 0, requests: 0, active_days: 0, updated_at: 0, first_day: null });
      const user = users.get(row.uid); user.tokens += tokens; user.active_days += tokens > 0 ? 1 : 0;
      user.updated_at = Math.max(user.updated_at, row.updated_at || 0);
      if (tokens > 0 && !user.first_day) user.first_day = row.day;
      for (const [, model, value] of pairs) {
        const key = JSON.stringify([row.uid, model]);
        if (!details.has(key)) details.set(key, { uid: row.uid, name: model, tokens: 0 });
        details.get(key).tokens += value;
        dayDetails.push({ uid: row.uid, day: row.day, name: model, tokens: value });
      }
    }
    return { users: [...users.values()].filter(row => scope === 'mine' || row.tokens > 0), details: [...details.values()], days, dayDetails, incompleteDays };
  }
  const selected = convert(periodRows.results), timeline = convert(trendRows.results);
  return { scope, dimension: 'models', tool, range, now, trendDays, unknownName: '未关联模型',
    users: selected.users, details: selected.details, days: timeline.days, dayDetails: timeline.dayDetails, incompleteDays: timeline.incompleteDays };
}
