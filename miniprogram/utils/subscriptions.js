// AI subscription ledger: presets, formatting and the form <-> request mapping.
// Prices are reference list prices; the user edits them to match the real bill.
const ICON_DIR = '/assets/subscriptions/';
const PRESETS = [
  { key: 'claude', name: 'Claude', match: /claude/i, currency: 'USD', plans: [['Pro', 20], ['Max 5x', 100], ['Max 20x', 200]] },
  { key: 'chatgpt', name: 'ChatGPT', match: /chatgpt|openai|codex/i, currency: 'USD', plans: [['Plus', 20], ['Pro', 200]] },
  { key: 'cursor', name: 'Cursor', match: /cursor/i, currency: 'USD', plans: [['Pro', 20], ['Pro+', 60], ['Ultra', 200]] },
  { key: 'copilot', name: 'GitHub Copilot', match: /copilot|github/i, currency: 'USD', plans: [['Pro', 10], ['Pro+', 39]] },
  { key: 'gemini', name: 'Google AI', match: /gemini|google ai/i, currency: 'USD', plans: [['Pro', 19.99], ['Ultra', 249.99]] },
  { key: 'windsurf', name: 'Windsurf', match: /windsurf/i, currency: 'USD', plans: [['Pro', 15]] },
  // No verified list price: the template fills the name and icon, the user enters the bill.
  { key: 'kimi', name: 'Kimi', match: /kimi|moonshot/i, currency: 'CNY', plans: [] },
  { key: 'glm', name: '智谱 GLM', match: /glm|智谱/i, currency: 'CNY', plans: [] },
].map(p => ({ ...p, icon: ICON_DIR + p.key + '.png', cycle: 'month' }));

const CYCLES = [
  { key: 'week', label: '每周', unit: '周' },
  { key: 'month', label: '每月', unit: '月' },
  { key: 'quarter', label: '每季', unit: '季' },
  { key: 'year', label: '每年', unit: '年' },
  { key: 'custom', label: '自定义', unit: '' },
];
const CURRENCIES = [{ key: 'CNY', label: '人民币', symbol: '¥' }, { key: 'USD', label: '美元', symbol: '$' }];
const STATUSES = [{ key: 'active', label: '订阅中' }, { key: 'paused', label: '已暂停' }, { key: 'cancelled', label: '已取消' }];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const symbol = currency => (CURRENCIES.find(c => c.key === currency) || CURRENCIES[0]).symbol;
function money(minor, currency, decimals = 2) {
  const value = (Number(minor) || 0) / 100;
  const [int, frac] = value.toFixed(decimals).split('.');
  return symbol(currency) + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac && !/^0+$/.test(frac) ? '.' + frac : '');
}
const usd = (micros, decimals = 2) => money(micros / 10000, 'USD', decimals);
const cycleUnit = item => item.cycle === 'custom' ? `${item.custom_days}天` : (CYCLES.find(c => c.key === item.cycle) || CYCLES[1]).unit;
const initial = name => [...String(name || '').trim()][0]?.toUpperCase() || '?';
const presetFor = name => PRESETS.find(p => p.match.test(name || '')) || null;
const iconFor = name => presetFor(name)?.icon || '';

function presentItem(item) {
  const status = STATUSES.find(s => s.key === item.status) || STATUSES[0];
  const price = `${money(item.price_minor, item.currency)}/${cycleUnit(item)}`;
  const today = item.today_usd_micros == null ? null : { value: usd(item.today_usd_micros), paid: item.paid_back_today };
  return { id: item.id, title: item.plan ? `${item.name} ${item.plan}` : item.name, icon: iconFor(item.name), initial: initial(item.name),
    meta: item.status === 'active' ? `${price} · 下次扣费 ${item.next_renewal_day.slice(5)}` : `${price} · ${status.label}`,
    active: item.status === 'active', daily: money(item.daily_minor, item.currency), spent: money(item.spent_minor, item.currency, 0), today };
}

function presentToday(data) {
  const t = data?.today_value;
  if (!t) return null;
  const has = t.api_usd_micros != null, daily = t.usd_daily_minor || 0;
  const gap = has && daily ? daily - t.api_usd_micros / 10000 : null;
  return { value: has ? usd(t.api_usd_micros) : '—', hasValue: has, daily: daily ? money(daily, 'USD') : '',
    paid: t.paid_back, ratio: t.ratio, gap: gap != null && gap > 0 ? money(gap, 'USD') : '' };
}

function presentWeek(data) {
  const days = data?.days || [];
  const cells = days.map((d, i) => ({ day: d.day, label: i === days.length - 1 ? '今天' : WEEKDAYS[new Date(d.day + 'T00:00:00Z').getUTCDay()],
    value: d.api_usd_micros == null ? '—' : usd(d.api_usd_micros, 0), state: d.paid_back === true ? 'paid' : d.paid_back === false ? 'unpaid' : 'none' }));
  return { cells, paidDays: cells.filter(c => c.state === 'paid').length, judged: cells.some(c => c.state !== 'none') };
}

function presentList(data) {
  const items = (data?.items || []).map(presentItem);
  const totals = (data?.summary?.currencies || []).map(c => ({ currency: c.currency,
    daily: money(c.daily_minor, c.currency), monthly: money(c.monthly_minor, c.currency, 0),
    yearly: money(c.yearly_minor, c.currency, 0), spent: money(c.spent_minor, c.currency, 0), count: c.active_count }));
  const v = data?.value;
  const value = v && v.ratio != null ? { api: usd(v.api_usd_micros, 0), plan: money(v.usd_monthly_minor, 'USD', 0), ratio: v.ratio } : null;
  return { active: items.filter(i => i.active), inactive: items.filter(i => !i.active), totals, value,
    today: presentToday(data), week: presentWeek(data), empty: !items.length,
    full: (data?.items?.length || 0) >= (data?.summary?.limit || 30) };
}

function formFromItem(item, today) {
  if (!item) return { name: '', plan: '', price: '', currency: 'USD', cycle: 'month', custom_days: '', start_day: today, status: 'active', ended_day: '', notes: '' };
  return { name: item.name, plan: item.plan || '', price: String(item.price_minor / 100), currency: item.currency, cycle: item.cycle,
    custom_days: item.custom_days ? String(item.custom_days) : '', start_day: item.start_day, status: item.status,
    ended_day: item.ended_day || '', notes: item.notes || '' };
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
    cycle: form.cycle, custom_days: customDays, start_day: form.start_day, status: form.status, notes: String(form.notes || '').trim() || null };
  if (form.status !== 'active') body.ended_day = form.ended_day || today;
  return { body };
}

module.exports = { PRESETS, CYCLES, CURRENCIES, STATUSES, money, symbol, iconFor, presetFor, presentList, presentItem, formFromItem, bodyFromForm };
