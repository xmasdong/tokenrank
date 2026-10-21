import { hexToken, jsonError, beijingDay, beijingDaysAgo } from './lib.js';
import { buildCosts, validateCost } from './costs.js';
import { summarizeTopups } from './topups.js';

// A private ledger of what the user pays for AI tools; never shown on boards or shares.
export const SUBSCRIPTION_LIMIT = 30;
const CYCLE_DAYS = { week: 7, month: 30, quarter: 91, year: 365 };
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'HKD', 'JPY'];
const STATUSES = ['active', 'paused', 'cancelled'];
const MAX_PRICE_MINOR = 100_000_000_000;
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z'))
  && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const dayNumber = d => Date.parse(d + 'T00:00:00Z') / 86400000;
const addDays = (d, n) => new Date((dayNumber(d) + n) * 86400000).toISOString().slice(0, 10);
const text = (value, max) => {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s && [...s].length <= max ? s : null;
};

// Units of each currency per US dollar. ECB reference rates through frankfurter.dev, cached for six hours;
// the fallback is the ECB set of 2026-10-20 and is labelled as such.
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,EUR,GBP,HKD,JPY';
export const FALLBACK_RATES = { base: 'USD', date: '2026-10-20', source: 'fallback', rates: { USD: 1, CNY: 6.678, EUR: 0.89166, GBP: 0.74925, HKD: 7.8487, JPY: 158.13 } };
export async function getRates() {
  const cache = typeof caches === 'undefined' ? null : caches.default, key = new Request('https://fx.tokenrank.internal/usd');
  try {
    const hit = cache && await cache.match(key);
    if (hit) return await hit.json();
    const res = await fetch(FX_URL, { signal: AbortSignal.timeout(3000) });
    const data = res.ok ? await res.json() : null;
    if (!data?.rates || CURRENCIES.some(c => c !== 'USD' && !(data.rates[c] > 0))) return FALLBACK_RATES;
    const rates = { base: 'USD', date: data.date, source: 'ECB', rates: { USD: 1, ...Object.fromEntries(CURRENCIES.filter(c => c !== 'USD').map(c => [c, data.rates[c]])) } };
    if (cache) await cache.put(key, Response.json(rates, { headers: { 'cache-control': 'max-age=21600' } }));
    return rates;
  } catch { return FALLBACK_RATES; }
}
const toUsd = (minor, currency, fx) => minor / (fx.rates[currency] || 1);

// Vendors a subscription can be matched to, by the subscription's name, the tool that ran and the model.
// Tools route models from many vendors (Cursor, Antigravity, Zcode): the tool names the plan, the model names the vendor.
const VENDORS = [
  { key: 'claude', name: /claude/i, tools: ['claude-code'], model: /^claude/i },
  { key: 'chatgpt', name: /chatgpt|openai|codex/i, tools: ['codex'], model: /^(gpt|o\d|codex|chatgpt)/i },
  { key: 'cursor', name: /cursor/i, tools: ['cursor'], model: null },
  { key: 'copilot', name: /copilot|github/i, tools: ['copilot'], model: null },
  { key: 'gemini', name: /gemini|google ai/i, tools: ['antigravity', 'gemini', 'gemini-cli'], model: /^gemini/i },
  { key: 'windsurf', name: /windsurf/i, tools: ['windsurf'], model: null },
  { key: 'kimi', name: /kimi|moonshot/i, tools: ['kimi'], model: /^(kimi|moonshot|k\d)/i },
  { key: 'glm', name: /glm|智谱/i, tools: ['zcode'], model: /^glm/i },
  // Prepaid: only the official API spends the DeepSeek balance. Routed names (workbuddy-ai/…, …:cloud) and -free do not.
  { key: 'deepseek', name: /deepseek/i, tools: ['dsh'], model: null, prepaid: true },
];
export const PREPAID = new Set(VENDORS.filter(v => v.prepaid).map(v => v.key));
const MULTI_VENDOR = new Set(['cursor', 'copilot', 'windsurf']);
const bareModel = model => String(model || '').split('/').pop();
export const subscriptionProvider = name => VENDORS.find(v => !v.prepaid && v.name.test(name || ''))?.key || null;
export function modelProvider(model) {
  const raw = String(model || ''), bare = bareModel(raw);
  if (/^deepseek/i.test(bare)) return /[/:]/.test(raw) || /-free$/i.test(raw) ? null : 'deepseek';
  return VENDORS.find(v => v.model && v.model.test(bare))?.key || null;
}
const toolProvider = tool => VENDORS.find(v => v.tools.includes(tool))?.key || null;
const parsePairs = json => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.filter(p => Array.isArray(p) && typeof p[0] === 'string' && p[1] > 0) : []; } catch { return []; } };

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
      // Models no subscription vendor claims belong to the user's "综合" entry, if there is one.
      const provider = modelProvider(model) || 'other';
      entry.providers[provider] = (entry.providers[provider] || 0) + micros;
    }
  }
  return days.map(day => byDay.get(day));
}

/** What the last seven days of usage suggest the user pays for; usage no plan claims becomes "综合". */
export function suggestSubscriptions(rows, activeKeys) {
  const found = new Map(), other = { tokens: 0, names: new Map() };
  // A tool and its models describe the same tokens: keep the larger of the two counts, not their sum.
  const add = (key, tokens, name, kind) => {
    const f = found.get(key) || { key, tool: 0, model: 0, names: new Map() };
    f[kind] += tokens; f.names.set(name, (f.names.get(name) || 0) + tokens); found.set(key, f);
  };
  for (const row of rows) {
    for (const [tool, tokens] of parsePairs(row.tools_json)) {
      const key = toolProvider(tool);
      if (key) add(key, tokens, tool, 'tool');
      else if (!parsePairs(row.models_json).length) { other.tokens += tokens; other.names.set(tool, (other.names.get(tool) || 0) + tokens); }
    }
    for (const [model, tokens] of parsePairs(row.models_json)) {
      const key = modelProvider(model);
      if (key) add(key, tokens, bareModel(model), 'model');
      else { other.tokens += tokens; other.names.set(bareModel(model), (other.names.get(bareModel(model)) || 0) + tokens); }
    }
  }
  const top = names => [...names].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  const list = [...found.values()].map(f => ({ key: f.key, tokens: Math.max(f.tool, f.model), evidence: top(f.names) }))
    .filter(f => !activeKeys.has(f.key)).sort((a, b) => b.tokens - a.tokens);
  if (other.tokens > 0 && !activeKeys.has('other')) list.push({ key: 'other', tokens: other.tokens, evidence: top(other.names) });
  return list;
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
  if (!CURRENCIES.includes(body.currency)) return { error: '不支持这个币种' };
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
  if (body.api_key != null && typeof body.api_key !== 'boolean') return { error: '付费方式有误' };
  return { value: { name, plan, price_minor: priceMinor, currency: body.currency, cycle, custom_days: customDays,
    start_day: body.start_day, status, ended_day: endedDay, notes, api_key: body.api_key ? 1 : 0 } };
}

const round2 = x => Math.round(x * 100) / 100;
const daysBetween = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

export async function listSubscriptions(env, userId, now = Date.now(), fx = FALLBACK_RATES) {
  const today = beijingDay(now), month = beijingDaysAgo(29, now);
  const week = Array.from({ length: 7 }, (_, i) => beijingDaysAgo(6 - i, now));
  const [rows, topupRows] = await Promise.all([
    env.DB.prepare(`SELECT id,name,plan,price_minor,currency,cycle,custom_days,start_day,status,ended_day,notes,api_key,updated_at
      FROM user_subscriptions WHERE user_id=?1 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at, id`).bind(userId).all(),
    env.DB.prepare('SELECT id,vendor,kind,amount_minor,currency,day,notes,created_at FROM user_topups WHERE user_id=?1').bind(userId).all(),
  ]);
  const enriched = rows.results.map(row => {
    const f = subscriptionFigures(row, today);
    const periodStart = row.status === 'active' && f.paid_periods ? addDays(row.start_day, (f.paid_periods - 1) * f.cycle_days) : null;
    return { ...row, ...f, api_key: !!row.api_key, period_start: periodStart,
      provider: /综合/.test(row.name) ? 'other' : subscriptionProvider(row.name) };
  });
  const active = enriched.filter(i => i.status === 'active');
  // Usage is read back to the earliest open billing period or top-up the figures need (at most a year).
  const earliest = [month, ...active.map(i => i.period_start).filter(Boolean), ...topupRows.results.map(r => r.day)]
    .reduce((a, b) => (b < a ? b : a), month);
  const from = earliest < beijingDaysAgo(365, now) ? beijingDaysAgo(365, now) : earliest;
  const usage = await env.DB.prepare(`SELECT day,tokens,requests,cost_json,models_json,tools_json FROM ranked_usage WHERE user_id=?1 AND day>=?2 AND day<=?3`)
    .bind(userId, from, today).all();
  const values = new Map(dailyValues(usage.results, daysBetween(from, today)).map(v => [v.day, v]));
  const usdDailyOf = item => toUsd(item.price_minor / item.cycle_days, item.currency, fx);

  // Which usage the plans pay for: their vendors' models; a multi-vendor tool (Cursor…) covers every vendor
  // except prepaid balances; a plan marked as API-key paid contributes cost but claims no usage.
  const vendor = new Map();
  let coverAll = false;
  for (const item of active) {
    if (item.api_key || !item.provider) continue;
    if (MULTI_VENDOR.has(item.provider)) { coverAll = true; continue; }
    const v = vendor.get(item.provider) || { count: 0, usd_daily: 0 };
    v.count++; v.usd_daily += usdDailyOf(item); vendor.set(item.provider, v);
  }
  const apiOnly = new Set(active.filter(i => i.api_key && i.provider && !vendor.has(i.provider)).map(i => i.provider));
  const covered = v => {
    if (!v || v.api_usd_micros == null) return null;
    if (coverAll) return v.api_usd_micros - Object.entries(v.providers).filter(([k]) => PREPAID.has(k) || apiOnly.has(k)).reduce((a, [, m]) => a + m, 0);
    return vendor.size ? [...vendor.keys()].reduce((a, k) => a + (v.providers[k] || 0), 0) : null;
  };

  const todayValue = values.get(today);
  const items = enriched.map(item => {
    const v = item.status === 'active' && !item.api_key ? vendor.get(item.provider) : null;
    const micros = v ? todayValue?.providers[item.provider] ?? null : null;
    let period = null;
    // A plan pays for one billing period: compare its share of the vendor's value since the period began.
    if (v && item.period_start) {
      const share = usdDailyOf(item) / v.usd_daily;
      let value = 0;
      for (const d of daysBetween(item.period_start, today)) value += (values.get(d)?.providers[item.provider] || 0) * share;
      const priceCents = toUsd(item.price_minor, item.currency, fx), ratio = value / 10_000 / priceCents;
      period = { start: item.period_start, end: addDays(item.next_renewal_day, -1), days_left: dayNumber(item.next_renewal_day) - dayNumber(today),
        value_usd_micros: Math.round(value), ratio: Math.round(ratio * 10) / 10, paid_back: ratio >= 1,
        gap_usd_minor: ratio >= 1 ? 0 : round2(priceCents - value / 10_000) };
    }
    const { period_start, ...rest } = item;
    return { ...rest, today_usd_micros: micros, vendor_count: v ? v.count : 0, period,
      paid_back_today: micros != null && v.usd_daily > 0 ? micros / 10_000 >= v.usd_daily : null };
  });

  // Totals are kept per currency and also converted to USD cents, so the client can show any one unit.
  const totals = new Map();
  let usdDaily = 0, usdMonthly = 0, usdYearly = 0, usdSpent = 0;
  for (const item of items) {
    const t = totals.get(item.currency) || { currency: item.currency, active_count: 0, daily: 0, monthly_minor: 0, yearly_minor: 0, spent_minor: 0 };
    t.spent_minor += item.spent_minor; usdSpent += toUsd(item.spent_minor, item.currency, fx);
    if (item.status === 'active') {
      t.active_count++; t.daily += item.price_minor / item.cycle_days; t.monthly_minor += item.monthly_minor; t.yearly_minor += item.yearly_minor;
      usdDaily += usdDailyOf(item); usdMonthly += toUsd(item.monthly_minor, item.currency, fx); usdYearly += toUsd(item.yearly_minor, item.currency, fx);
    }
    totals.set(item.currency, t);
  }
  const currencies = CURRENCIES.filter(c => totals.has(c)).map(c => { const { daily, ...t } = totals.get(c); return { ...t, daily_minor: round2(daily) }; });
  const monthRows = usage.results.filter(r => r.day >= month);
  const cost = buildCosts(monthRows);
  let monthCovered = null;
  for (const d of daysBetween(month, today)) { const c = covered(values.get(d)); if (c != null) monthCovered = (monthCovered || 0) + c; }
  const paid = c => c != null && usdDaily > 0 ? c / 10_000 >= usdDaily : null;
  const days = week.map(d => { const c = covered(values.get(d)); return { day: d, api_usd_micros: c, paid_back: paid(c) }; });
  const todayCovered = covered(todayValue);

  const spendDeepseek = new Map([...values].map(([d, v]) => [d, v.providers.deepseek || 0]));
  const topups = summarizeTopups(topupRows.results, spendDeepseek, fx, today, week);
  const activeKeys = new Set([...active.map(i => i.provider).filter(Boolean), ...topups.map(t => t.vendor)]);
  return { today, fx, items, days, topups,
    suggestions: suggestSubscriptions(usage.results.filter(r => r.day >= week[0]), activeKeys),
    today_value: { api_usd_micros: todayCovered, usd_daily_minor: round2(usdDaily),
      ratio: todayCovered != null && usdDaily ? Math.round(todayCovered / 10_000 / usdDaily * 10) / 10 : null, paid_back: paid(todayCovered) },
    summary: { currencies, usd: { daily_minor: round2(usdDaily), monthly_minor: Math.round(usdMonthly), yearly_minor: Math.round(usdYearly), spent_minor: Math.round(usdSpent) },
      active_count: active.length, inactive_count: items.length - active.length, limit: SUBSCRIPTION_LIMIT },
    value: { from: month, to: today, cost_status: cost.status, api_usd_micros: monthCovered, usd_monthly_minor: Math.round(usdMonthly),
      ratio: monthCovered && usdMonthly ? Math.round(monthCovered / 10_000 / usdMonthly * 10) / 10 : null } };
}

export async function createSubscription(env, userId, body, now = Date.now()) {
  const { value, error } = normalizeSubscription(body, beijingDay(now));
  if (error) return jsonError(400, error);
  const v = value;
  const result = await env.DB.prepare(`INSERT INTO user_subscriptions(id,user_id,name,plan,price_minor,currency,cycle,custom_days,start_day,status,ended_day,notes,created_at,updated_at,api_key)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?15 FROM users WHERE id=?2 AND disabled_at IS NULL
      AND (SELECT COUNT(*) FROM user_subscriptions WHERE user_id=?2) < ?14`)
    .bind(hexToken(), userId, v.name, v.plan, v.price_minor, v.currency, v.cycle, v.custom_days, v.start_day, v.status, v.ended_day, v.notes, now, SUBSCRIPTION_LIMIT, v.api_key).run();
  if (!result.meta?.changes) return Response.json({ error: `最多记录 ${SUBSCRIPTION_LIMIT} 个订阅`, code: 'SUBSCRIPTION_LIMIT' }, { status: 409 });
  return Response.json(await listSubscriptions(env, userId, now, await getRates()));
}

export async function updateSubscription(env, userId, id, body, now = Date.now()) {
  const { value, error } = normalizeSubscription(body, beijingDay(now));
  if (error) return jsonError(400, error);
  const v = value;
  const result = await env.DB.prepare(`UPDATE user_subscriptions SET name=?3,plan=?4,price_minor=?5,currency=?6,cycle=?7,custom_days=?8,
    start_day=?9,status=?10,ended_day=?11,notes=?12,updated_at=?13,api_key=?14
    WHERE id=?1 AND user_id=?2 AND EXISTS(SELECT 1 FROM users WHERE id=?2 AND disabled_at IS NULL)`)
    .bind(id, userId, v.name, v.plan, v.price_minor, v.currency, v.cycle, v.custom_days, v.start_day, v.status, v.ended_day, v.notes, now, v.api_key).run();
  if (!result.meta?.changes) return Response.json({ error: '这条订阅已不存在，请刷新', code: 'SUBSCRIPTION_NOT_FOUND' }, { status: 404 });
  return Response.json(await listSubscriptions(env, userId, now, await getRates()));
}

export async function deleteSubscription(env, userId, id, now = Date.now()) {
  const result = await env.DB.prepare('DELETE FROM user_subscriptions WHERE id=?1 AND user_id=?2').bind(id, userId).run();
  if (!result.meta?.changes) return Response.json({ error: '这条订阅已不存在，请刷新', code: 'SUBSCRIPTION_NOT_FOUND' }, { status: 404 });
  return Response.json(await listSubscriptions(env, userId, now, await getRates()));
}
