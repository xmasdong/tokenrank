// AI subscription ledger: presets, formatting and the form <-> request mapping.
// Plan prices checked 2026-10-21 against: claude.com/pricing; cursor.com/pricing; github.com/features/copilot/plans;
// gemini.google/subscriptions; kimi.com/help/membership/membership-pricing. ChatGPT (help center, quoted in press after the
// 2026-09-29 Pro change), Windsurf (windsurf.com now redirects to Devin) and GLM (coding-plan.org, updated 2026-10-14,
// the official page renders client-side) come from secondary sources. The user edits the price to match the real bill.
const ICON_DIR = '/assets/subscriptions/';
const m = (name, price) => [name, price, 'month'];
const PRESETS = [
  { key: 'claude', name: 'Claude', match: /claude/i, currency: 'USD', plans: [m('Pro', 20), ['Pro 年付', 200, 'year'], m('Max 5x', 100), m('Max 20x', 200)] },
  { key: 'chatgpt', name: 'ChatGPT', match: /chatgpt|openai|codex/i, currency: 'USD', plans: [m('Go', 8), m('Plus', 20), m('Pro 100', 100), m('Pro 200', 200), m('Pro 500', 500)] },
  { key: 'cursor', name: 'Cursor', match: /cursor/i, currency: 'USD', plans: [m('Plus', 8), m('Premium', 30), m('Super', 100), m('Ultra', 200),
    ['Plus 年付', 80, 'year'], ['Premium 年付', 300, 'year'], ['Super 年付', 1000, 'year']] },
  { key: 'copilot', name: 'GitHub Copilot', match: /copilot|github/i, currency: 'USD', plans: [m('Pro', 10), m('Pro+', 39), m('Max', 100)] },
  { key: 'gemini', name: 'Google AI', match: /gemini|google ai/i, currency: 'USD', plans: [m('Plus', 4.99), m('Pro', 19.99), m('Ultra', 99.99), m('Ultra 20x', 199.99)] },
  { key: 'windsurf', name: 'Windsurf', match: /windsurf/i, currency: 'USD', plans: [m('Pro', 20), m('Max', 200)] },
  { key: 'kimi', name: 'Kimi', match: /kimi|moonshot/i, currency: 'CNY', plans: [m('Go', 49), m('Plus', 99), m('Pro', 199), m('Max', 699), m('Ultra', 1399),
    ['Go 年付', 468, 'year'], ['Plus 年付', 948, 'year'], ['Pro 年付', 1908, 'year'], ['Max 年付', 6708, 'year'], ['Ultra 年付', 13428, 'year']] },
  { key: 'glm', name: '智谱 GLM', match: /glm|智谱/i, currency: 'CNY', plans: [m('Lite', 118), m('Pro', 538), m('Max', 1078),
    ['Lite 包季', 283.2, 'quarter'], ['Pro 包季', 1291.2, 'quarter'], ['Max 包季', 2587.2, 'quarter'],
    ['Lite 包年', 991.2, 'year'], ['Pro 包年', 4519.2, 'year'], ['Max 包年', 9055.2, 'year']] },
  // Usage no plan claims (dsh, WorkBuddy, DeepSeek API…): the user enters roughly what it costs a month.
  { key: 'other', name: '综合', match: /综合/, currency: 'CNY', plans: [] },
].map(p => ({ ...p, icon: ICON_DIR + p.key + '.png' }));
// Prepaid API balances: recorded as top-ups, not as plans.
const TOPUP_PRESETS = [{ key: 'deepseek', name: 'DeepSeek', currency: 'CNY', icon: ICON_DIR + 'deepseek.png' }];

const CYCLES = [
  { key: 'week', label: '每周', unit: '周' },
  { key: 'month', label: '每月', unit: '月' },
  { key: 'quarter', label: '每季', unit: '季' },
  { key: 'year', label: '每年', unit: '年' },
  { key: 'custom', label: '自定义', unit: '' },
];
const CURRENCIES = [
  { key: 'CNY', label: '人民币', symbol: '¥', decimals: 2 }, { key: 'USD', label: '美元', symbol: '$', decimals: 2 },
  { key: 'EUR', label: '欧元', symbol: '€', decimals: 2 }, { key: 'GBP', label: '英镑', symbol: '£', decimals: 2 },
  { key: 'HKD', label: '港币', symbol: 'HK$', decimals: 2 }, { key: 'JPY', label: '日元', symbol: 'JP¥', decimals: 0 },
];
const FALLBACK_FX = { base: 'USD', date: '', source: 'none', rates: { USD: 1 } };
const STATUSES = [{ key: 'active', label: '订阅中' }, { key: 'paused', label: '已暂停' }, { key: 'cancelled', label: '已取消' }];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const { formatTokens } = require('./usage');

const currencyOf = key => CURRENCIES.find(c => c.key === key) || CURRENCIES[0];
const symbol = currency => currencyOf(currency).symbol;
function money(minor, currency, decimals = 2) {
  decimals = Math.min(decimals, currencyOf(currency).decimals);
  const value = (Number(minor) || 0) / 100;
  const [int, frac] = value.toFixed(decimals).split('.');
  return symbol(currency) + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac && !/^0+$/.test(frac) ? '.' + frac : '');
}
const cycleUnit = item => item.cycle === 'custom' ? `${item.custom_days}天` : (CYCLES.find(c => c.key === item.cycle) || CYCLES[1]).unit;
const initial = name => [...String(name || '').trim()][0]?.toUpperCase() || '?';
const presetFor = name => PRESETS.find(p => p.match.test(name || '')) || null;
const iconFor = name => presetFor(name)?.icon || '';

/** Converts minor units between currencies with rates given as units per US dollar. */
function convert(minor, from, to, fx) {
  const rates = (fx && fx.rates) || FALLBACK_FX.rates;
  if (from === to) return minor;
  if (!rates[from] || !rates[to]) return null;
  return minor / rates[from] * rates[to];
}
const shown = (minor, from, ctx, decimals = 2) => {
  const v = convert(minor, from, ctx.display, ctx.fx);
  return v == null ? money(minor, from, decimals) : money(v, ctx.display, decimals);
};
const fromUsdMicros = (micros, ctx, decimals = 2) => shown(micros / 10000, 'USD', ctx, decimals);

function presentItem(item, ctx = { display: item.currency, fx: FALLBACK_FX }) {
  const status = STATUSES.find(s => s.key === item.status) || STATUSES[0];
  const price = `${money(item.price_minor, item.currency)}/${cycleUnit(item)}`;
  const today = item.today_usd_micros == null ? null : { value: fromUsdMicros(item.today_usd_micros, ctx), paid: item.paid_back_today,
    shared: item.vendor_count > 1 ? `${item.vendor_count} 个订阅合计` : '' };
  const p = item.period;
  const period = p ? { paid: p.paid_back, text: p.paid_back ? `本期已回本 ${p.ratio} 倍` : `本期还差 ${shown(p.gap_usd_minor, 'USD', ctx)}`,
    left: `还剩 ${p.days_left} 天` } : null;
  return { id: item.id, title: item.plan ? `${item.name} ${item.plan}` : item.name, icon: iconFor(item.name), initial: initial(item.name), period,
    apiKey: !!item.api_key,
    meta: item.status === 'active' ? `${price} · 下次扣费 ${item.next_renewal_day.slice(5)}` : `${price} · ${status.label}`,
    active: item.status === 'active', daily: shown(item.daily_minor, item.currency, ctx), spent: shown(item.spent_minor, item.currency, ctx, 0), today };
}

function presentToday(data, ctx) {
  const t = data?.today_value;
  if (!t) return null;
  const has = t.api_usd_micros != null, daily = t.usd_daily_minor || 0;
  const gap = has && daily ? daily - t.api_usd_micros / 10000 : null;
  return { value: has ? fromUsdMicros(t.api_usd_micros, ctx) : '—', hasValue: has, daily: daily ? shown(daily, 'USD', ctx) : '',
    paid: t.paid_back, ratio: t.ratio, gap: gap != null && gap > 0 ? shown(gap, 'USD', ctx) : '' };
}

function presentWeek(data, ctx) {
  const days = data?.days || [];
  const cells = days.map((d, i) => ({ day: d.day, label: i === days.length - 1 ? '今天' : WEEKDAYS[new Date(d.day + 'T00:00:00Z').getUTCDay()],
    value: d.api_usd_micros == null ? '—' : fromUsdMicros(d.api_usd_micros, ctx, 0), state: d.paid_back === true ? 'paid' : d.paid_back === false ? 'unpaid' : 'none' }));
  return { cells, paidDays: cells.filter(c => c.state === 'paid').length, judged: cells.some(c => c.state !== 'none') };
}

function presentSuggestions(data) {
  return (data?.suggestions || []).map(s => {
    const topup = TOPUP_PRESETS.find(p => p.key === s.key), preset = topup || PRESETS.find(p => p.key === s.key);
    return preset && { key: s.key, name: preset.name, icon: preset.icon, tokens: formatTokens(s.tokens), evidence: (s.evidence || []).join(' · '),
      topup: !!topup, action: topup ? '记一笔充值' : '记一笔',
      hint: s.key === 'other' ? '没有对应订阅的用量，可按月估算填写' : topup ? '按量充值，记下充值金额就能估算余额' : '' };
  }).filter(Boolean);
}

/** Prepaid balances in their own currency: estimated remaining, burn rate and the records behind them. */
function presentTopups(data) {
  return (data?.topups || []).map(t => {
    const preset = TOPUP_PRESETS.find(p => p.key === t.vendor) || { name: t.vendor, icon: '' };
    const m = (minor, d = 2) => money(minor, t.currency, d);
    const low = t.remaining_minor <= 0;
    return { vendor: t.vendor, name: preset.name, icon: preset.icon, currency: t.currency,
      remaining: m(Math.max(0, t.remaining_minor)), low, total: m(t.total_minor, 0), count: t.count, spent: m(t.spent_minor),
      percent: t.used_percent == null ? 0 : t.used_percent, today: m(t.today_minor), avg: m(t.avg_daily_minor),
      daysLeft: low ? '' : t.days_left == null ? '近 7 天没有用量' : `约还能用 ${t.days_left} 天`,
      basis: t.calibrated_day ? `${t.calibrated_day} 校准后估算` : `自 ${t.since} 首次充值起估算`,
      records: t.records.map(r => ({ id: r.id, day: r.day, kind: r.kind, label: r.kind === 'balance' ? '校准余额' : '充值', amount: m(r.amount_minor), notes: r.notes || '' })) };
  });
}

function fxLine(fx) {
  if (!fx || !fx.rates || fx.source === 'none') return '';
  const cny = fx.rates.CNY ? `1 美元 = ${fx.rates.CNY} 人民币` : '';
  return fx.source === 'ECB' ? `${cny}，欧洲央行 ${fx.date} 参考汇率` : `${cny}，备用参考汇率（${fx.date}）`;
}

/** Everything is shown in one display currency; each row keeps its own price in the original currency. */
function presentList(data, display = 'CNY') {
  const fx = data?.fx || FALLBACK_FX, ctx = { display, fx };
  const items = (data?.items || []).map(item => presentItem(item, ctx));
  const usd = data?.summary?.usd;
  const total = usd ? { daily: shown(usd.daily_minor, 'USD', ctx), monthly: shown(usd.monthly_minor, 'USD', ctx, 0),
    yearly: shown(usd.yearly_minor, 'USD', ctx, 0), spent: shown(usd.spent_minor, 'USD', ctx, 0), count: data.summary.active_count } : null;
  const mixed = (data?.summary?.currencies || []).length > 1 || (data?.summary?.currencies || []).some(c => c.currency !== display);
  const v = data?.value;
  const value = v && v.ratio != null ? { api: fromUsdMicros(v.api_usd_micros, ctx, 0), plan: shown(v.usd_monthly_minor, 'USD', ctx, 0), ratio: v.ratio } : null;
  return { active: items.filter(i => i.active), inactive: items.filter(i => !i.active), total, value, display,
    displayLabel: currencyOf(display).label, fx: mixed ? fxLine(fx) : '',
    today: presentToday(data, ctx), week: presentWeek(data, ctx), suggestions: presentSuggestions(data), topups: presentTopups(data),
    empty: !items.length && !(data?.topups || []).length,
    full: (data?.items?.length || 0) >= (data?.summary?.limit || 30) };
}

function formFromItem(item, today, currency = 'USD') {
  if (!item) return { name: '', plan: '', price: '', currency, cycle: 'month', custom_days: '', start_day: today, status: 'active', ended_day: '', notes: '', api_key: false };
  return { name: item.name, plan: item.plan || '', price: String(item.price_minor / 100), currency: item.currency, cycle: item.cycle,
    custom_days: item.custom_days ? String(item.custom_days) : '', start_day: item.start_day, status: item.status,
    ended_day: item.ended_day || '', notes: item.notes || '', api_key: !!item.api_key };
}

function bodyFromForm(form, today) {
  const name = String(form.name || '').trim();
  if (!name) return { error: '请填写服务名称' };
  const price = Number(String(form.price).trim());
  if (!String(form.price).trim() || !Number.isFinite(price) || price <= 0 || price > 1_000_000) return { error: '请填写有效的价格' };
  let customDays = null;
  if (form.cycle === 'custom') {
    customDays = Number(form.custom_days);
    if (!Number.isInteger(customDays) || customDays < 1 || customDays > 3650) return { error: '自定义周期为 1 到 3650 天' };
  }
  if (!form.start_day || form.start_day > today) return { error: '开始日期不能晚于今天' };
  const body = { name, plan: String(form.plan || '').trim() || null, price: Math.round(price * 100) / 100, currency: form.currency,
    cycle: form.cycle, custom_days: customDays, start_day: form.start_day, status: form.status, notes: String(form.notes || '').trim() || null,
    api_key: !!form.api_key };
  if (form.status !== 'active') body.ended_day = form.ended_day || today;
  return { body };
}

function topupForm(record, today, currency = 'CNY') {
  return record ? { kind: record.kind, amount: String(record.amount_minor / 100), currency: record.currency, day: record.day, notes: record.notes || '' }
    : { kind: 'topup', amount: '', currency, day: today, notes: '' };
}
function topupBody(form, vendor, today) {
  const amount = Number(String(form.amount).trim());
  const min = form.kind === 'topup' ? 0.01 : 0;
  if (!String(form.amount).trim() || !Number.isFinite(amount) || amount < min || amount > 1_000_000_000) return { error: form.kind === 'topup' ? '请填写有效的充值金额' : '请填写有效的余额' };
  if (!form.day || form.day > today) return { error: '日期不能晚于今天' };
  return { body: { vendor, kind: form.kind, amount: Math.round(amount * 100) / 100, currency: form.currency, day: form.day, notes: String(form.notes || '').trim() || null } };
}

function planLabel(currency, price, cycle) { return `${symbol(currency)}${price}/${(CYCLES.find(c => c.key === cycle) || CYCLES[1]).unit}`; }

module.exports = { topupForm, topupBody, TOPUP_PRESETS, planLabel, convert, PRESETS, CYCLES, CURRENCIES, STATUSES, money, symbol, iconFor, presetFor, presentList, presentItem, formFromItem, bodyFromForm };
