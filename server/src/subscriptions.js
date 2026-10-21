import { hexToken, jsonError, beijingDay, beijingDaysAgo } from './lib.js';
import { buildCosts, validateCost } from './costs.js';

// A private ledger of what the user pays for AI tools; never shown on boards or shares.
export const SUBSCRIPTION_LIMIT = 30;
const CYCLE_DAYS = { week: 7, month: 30, quarter: 91, year: 365 };
const CURRENCIES = ['CNY', 'USD'];
const STATUSES = ['active', 'paused', 'cancelled'];
const MAX_PRICE_MINOR = 100_000_000;
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z'))
  && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const dayNumber = d => Date.parse(d + 'T00:00:00Z') / 86400000;
const addDays = (d, n) => new Date((dayNumber(d) + n) * 86400000).toISOString().slice(0, 10);
const text = (value, max) => {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s && [...s].length <= max ? s : null;
};

// A subscription pays for one vendor's models; tools such as Cursor route to many vendors and get no attribution.
const PROVIDERS = [['anthropic', /claude/i, /^claude/i], ['openai', /chatgpt|openai|codex/i, /^(gpt|o\d|codex|chatgpt)/i],
  ['google', /gemini|google ai/i, /^gemini/i], ['moonshot', /kimi|moonshot/i, /^(kimi|moonshot)/i], ['zhipu', /glm|智谱/i, /^glm/i]];
export const subscriptionProvider = name => PROVIDERS.find(([, byName]) => byName.test(name || ''))?.[0] || null;
export const modelProvider = model => PROVIDERS.find(([, , byModel]) => byModel.test(model || ''))?.[0] || null;

/** API-equivalent value per Beijing day, in USD micros, in total and per vendor. */
export function dailyValues(rows, days) {
  const byDay = new Map(days.map(day => [day, { day, api_usd_micros: null, providers: {} }]));
  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (!entry) continue;
    let cost;
    try { cost = JSON.parse(row.cost_json || 'null'); validateCost(cost, row.tokens); } catch { cost = null; }
    if (!cost) continue;
    entry.api_usd_micros = (entry.api_usd_micros || 0) + cost.usd_micros;
    for (const [model, micros] of cost.models) {
      const provider = modelProvider(model);
      if (provider) entry.providers[provider] = (entry.providers[provider] || 0) + micros;
    }
  }
  return days.map(day => byDay.get(day));
}

export function cycleDays(sub) { return sub.cycle === 'custom' ? sub.custom_days : CYCLE_DAYS[sub.cycle]; }

/** Money stays in minor units (分 / 美分). A period is paid on its first day, so a renewal day counts. */
export function subscriptionFigures(sub, today) {
  const days = cycleDays(sub);
  const end = sub.status === 'active' ? today : (sub.ended_day || today);
  const started = dayNumber(sub.start_day) <= dayNumber(today);
  const periods = started ? Math.floor(Math.max(0, dayNumber(end) - dayNumber(sub.start_day)) / days) + 1 : 0;
  const daily = sub.price_minor / days;
  return { cycle_days: days, daily_minor: Math.round(daily * 100) / 100, monthly_minor: Math.round(daily * 30.44),
    yearly_minor: Math.round(daily * 365), paid_periods: periods, spent_minor: periods * sub.price_minor,
    next_renewal_day: sub.status === 'active' ? addDays(sub.start_day, periods * days) : null };
}

export function normalizeSubscription(body, today) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '订阅内容格式有误' };
  const name = text(body.name, 40);
  if (!name) return { error: '请填写服务名称（40 字以内）' };
  const plan = body.plan == null || body.plan === '' ? null : text(body.plan, 30);
  if (body.plan != null && body.plan !== '' && !plan) return { error: '套餐名称最多 30 字' };
  const price = Number(body.price);
  const priceMinor = Math.round(price * 100);
  if (typeof body.price !== 'number' || !Number.isFinite(price) || priceMinor < 1 || priceMinor > MAX_PRICE_MINOR) return { error: '请填写有效的价格' };
  if (!CURRENCIES.includes(body.currency)) return { error: '币种只支持人民币或美元' };
  const cycle = body.cycle;
  if (cycle !== 'custom' && !CYCLE_DAYS[cycle]) return { error: '请选择扣费周期' };
  const customDays = cycle === 'custom' ? body.custom_days : null;
  if (cycle === 'custom' && (!Number.isSafeInteger(customDays) || customDays < 1 || customDays > 3650)) return { error: '自定义周期为 1 到 3650 天' };
  if (!validDay(body.start_day) || body.start_day > today) return { error: '开始日期不能晚于今天' };
  const status = body.status ?? 'active';
  if (!STATUSES.includes(status)) return { error: '订阅状态有误' };
  let endedDay = null;
  if (status !== 'active') {
    endedDay = body.ended_day ?? today;
    if (!validDay(endedDay) || endedDay < body.start_day || endedDay > today) return { error: '停用日期需在开始日期和今天之间' };
  }
  const notes = body.notes == null || body.notes === '' ? null : text(body.notes, 100);
  if (body.notes != null && body.notes !== '' && !notes) return { error: '备注最多 100 字' };
  return { value: { name, plan, price_minor: priceMinor, currency: body.currency, cycle, custom_days: customDays,
    start_day: body.start_day, status, ended_day: endedDay, notes } };
}

export async function listSubscriptions(env, userId, now = Date.now()) {
  const today = beijingDay(now), from = beijingDaysAgo(29, now);
  const [rows, usage] = await Promise.all([
    env.DB.prepare(`SELECT id,name,plan,price_minor,currency,cycle,custom_days,start_day,status,ended_day,notes,updated_at
      FROM user_subscriptions WHERE user_id=?1 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at, id`).bind(userId).all(),
    env.DB.prepare(`SELECT day,tokens,requests,cost_json FROM ranked_usage WHERE user_id=?1 AND day>=?2 AND day<=?3`).bind(userId, from, today).all(),
  ]);
  const week = Array.from({ length: 7 }, (_, i) => beijingDaysAgo(6 - i, now));
  const values = dailyValues(usage.results, week), todayValue = values.at(-1);
  const items = rows.results.map(row => {
    const provider = subscriptionProvider(row.name), figures = subscriptionFigures(row, today);
    const micros = provider && row.status === 'active' ? todayValue.providers[provider] ?? null : null;
    return { ...row, ...figures, provider, today_usd_micros: micros,
      paid_back_today: micros != null && row.currency === 'USD' ? micros / 10_000 >= figures.daily_minor : null };
  });
  const totals = new Map();
  for (const item of items) {
    const t = totals.get(item.currency) || { currency: item.currency, active_count: 0, daily: 0, monthly_minor: 0, yearly_minor: 0, spent_minor: 0 };
    t.spent_minor += item.spent_minor;
    if (item.status === 'active') { t.active_count++; t.daily += item.price_minor / item.cycle_days; t.monthly_minor += item.monthly_minor; t.yearly_minor += item.yearly_minor; }
    totals.set(item.currency, t);
  }
  const currencies = CURRENCIES.filter(c => totals.has(c)).map(c => {
    const { daily, ...t } = totals.get(c);
    return { ...t, daily_minor: Math.round(daily * 100) / 100 };
  });
  // API-equivalent value is an estimate from the uploaded token-watcher prices, compared only with USD plans.
  const cost = buildCosts(usage.results);
  const usdMonthly = totals.get('USD')?.monthly_minor || 0;
  const apiCents = cost.usd_micros == null ? null : cost.usd_micros / 10_000;
  const usdDaily = totals.get('USD')?.daily || 0;
  const paid = v => v.api_usd_micros != null && usdDaily > 0 ? v.api_usd_micros / 10_000 >= usdDaily : null;
  const days = values.map(v => ({ day: v.day, api_usd_micros: v.api_usd_micros, paid_back: paid(v) }));
  return { today, items, days, today_value: { api_usd_micros: todayValue.api_usd_micros, usd_daily_minor: Math.round(usdDaily * 100) / 100,
    ratio: todayValue.api_usd_micros != null && usdDaily ? Math.round(todayValue.api_usd_micros / 10_000 / usdDaily * 10) / 10 : null,
    paid_back: paid(todayValue) }, summary: { currencies, active_count: items.filter(i => i.status === 'active').length,
    inactive_count: items.filter(i => i.status !== 'active').length, limit: SUBSCRIPTION_LIMIT },
    value: { from, to: today, cost_status: cost.status, api_usd_micros: cost.usd_micros, usd_monthly_minor: usdMonthly,
      ratio: apiCents && usdMonthly ? Math.round(apiCents / usdMonthly * 10) / 10 : null } };
}

export async function createSubscription(env, userId, body, now = Date.now()) {
  const { value, error } = normalizeSubscription(body, beijingDay(now));
  if (error) return jsonError(400, error);
  const v = value;
  const result = await env.DB.prepare(`INSERT INTO user_subscriptions(id,user_id,name,plan,price_minor,currency,cycle,custom_days,start_day,status,ended_day,notes,created_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13 FROM users WHERE id=?2 AND disabled_at IS NULL
      AND (SELECT COUNT(*) FROM user_subscriptions WHERE user_id=?2) < ?14`)
    .bind(hexToken(), userId, v.name, v.plan, v.price_minor, v.currency, v.cycle, v.custom_days, v.start_day, v.status, v.ended_day, v.notes, now, SUBSCRIPTION_LIMIT).run();
  if (!result.meta?.changes) return Response.json({ error: `最多记录 ${SUBSCRIPTION_LIMIT} 个订阅`, code: 'SUBSCRIPTION_LIMIT' }, { status: 409 });
  return Response.json(await listSubscriptions(env, userId, now));
}

export async function updateSubscription(env, userId, id, body, now = Date.now()) {
  const { value, error } = normalizeSubscription(body, beijingDay(now));
  if (error) return jsonError(400, error);
  const v = value;
  const result = await env.DB.prepare(`UPDATE user_subscriptions SET name=?3,plan=?4,price_minor=?5,currency=?6,cycle=?7,custom_days=?8,
    start_day=?9,status=?10,ended_day=?11,notes=?12,updated_at=?13
    WHERE id=?1 AND user_id=?2 AND EXISTS(SELECT 1 FROM users WHERE id=?2 AND disabled_at IS NULL)`)
    .bind(id, userId, v.name, v.plan, v.price_minor, v.currency, v.cycle, v.custom_days, v.start_day, v.status, v.ended_day, v.notes, now).run();
  if (!result.meta?.changes) return Response.json({ error: '这条订阅已不存在，请刷新', code: 'SUBSCRIPTION_NOT_FOUND' }, { status: 404 });
  return Response.json(await listSubscriptions(env, userId, now));
}

export async function deleteSubscription(env, userId, id, now = Date.now()) {
  const result = await env.DB.prepare('DELETE FROM user_subscriptions WHERE id=?1 AND user_id=?2').bind(id, userId).run();
  if (!result.meta?.changes) return Response.json({ error: '这条订阅已不存在，请刷新', code: 'SUBSCRIPTION_NOT_FOUND' }, { status: 404 });
  return Response.json(await listSubscriptions(env, userId, now));
}
