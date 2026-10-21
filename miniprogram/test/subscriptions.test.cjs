const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const S = require('../utils/subscriptions');

const item = (extra = {}) => ({ id: 'a'.repeat(32), name: 'Claude', plan: 'Max 20x', price_minor: 20000, currency: 'USD', cycle: 'month', custom_days: null,
  start_day: '2026-09-21', status: 'active', ended_day: null, notes: null, cycle_days: 30, daily_minor: 666.67, monthly_minor: 20293,
  yearly_minor: 243333, paid_periods: 2, spent_minor: 40000, next_renewal_day: '2026-11-20', ...extra });
const FX = { base: 'USD', date: '2026-10-20', source: 'ECB', rates: { USD: 1, CNY: 6.678, EUR: 0.89166, GBP: 0.74925, HKD: 7.8487, JPY: 158.13 } };
const listData = (items, extra = {}) => ({ today: '2026-10-21', fx: FX, items, suggestions: [], summary: { currencies: [{ currency: 'USD', active_count: 1, daily_minor: 666.67,
  monthly_minor: 20293, yearly_minor: 243333, spent_minor: 40000 }], usd: { daily_minor: 666.67, monthly_minor: 20293, yearly_minor: 243333, spent_minor: 40000 },
  active_count: 1, inactive_count: 0, limit: 30 },
  value: { ratio: 6.4, api_usd_micros: 1_294_610_000, usd_monthly_minor: 20293, cost_status: 'complete' }, ...extra });

test('金额按币种格式化，日元不带小数；换算按每美元单位数', () => {
  assert.equal(S.money(20000, 'USD'), '$200'); assert.equal(S.money(666.67, 'USD'), '$6.67'); assert.equal(S.money(5900, 'CNY'), '¥59');
  assert.equal(S.money(243333, 'USD', 0), '$2,433'); assert.equal(S.money(1999, 'USD'), '$19.99'); assert.equal(S.money(158130, 'JPY'), 'JP¥1,581');
  assert.equal(S.money(1000, 'HKD'), 'HK$10'); assert.equal(Math.round(S.convert(2000, 'USD', 'CNY', FX)), 13356);
  assert.equal(Math.round(S.convert(13356, 'CNY', 'EUR', FX)), 1783); assert.equal(S.convert(100, 'USD', 'XYZ', FX), null);
});

test('列表统一按显示单位换算；每行保留原币价格，切换单位只改显示', () => {
  const data = listData([item(), item({ id: 'b'.repeat(32), name: 'Cursor', plan: null, status: 'cancelled', ended_day: '2026-10-01', next_renewal_day: null, spent_minor: 2000 })]);
  const usd = S.presentList(data, 'USD');
  assert.equal(usd.active[0].title, 'Claude Max 20x'); assert.equal(usd.active[0].meta, '$200/月 · 下次扣费 11-20'); assert.equal(usd.active[0].daily, '$6.67');
  assert.match(usd.inactive[0].meta, /已取消/); assert.deepEqual(usd.total, { daily: '$6.67', monthly: '$203', yearly: '$2,433', spent: '$400', count: 1 });
  assert.deepEqual(usd.value, { api: '$1,295', plan: '$203', ratio: 6.4 }); assert.equal(usd.fx, '');
  const cny = S.presentList(data, 'CNY');
  assert.equal(cny.active[0].meta, '$200/月 · 下次扣费 11-20'); assert.equal(cny.active[0].daily, '¥44.52'); assert.equal(cny.total.monthly, '¥1,355');
  assert.equal(cny.displayLabel, '人民币'); assert.equal(cny.fx, '1 美元 = 6.678 人民币，欧洲央行 2026-10-20 参考汇率');
  assert.match(S.presentList({ ...data, fx: { ...FX, source: 'fallback' } }, 'CNY').fx, /备用参考汇率/);
  assert.equal(S.presentList(listData([item()], { value: { ratio: null } }), 'USD').value, null);
});

test('今天 Token 值、近 7 天回本格子、同厂商多个订阅合计、行内图标', () => {
  const days = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${15 + i}`, api_usd_micros: i < 2 ? null : i * 10_000_000, paid_back: i < 2 ? null : i >= 4 }));
  const view = S.presentList(listData([item({ today_usd_micros: 30_000_000, paid_back_today: true, vendor_count: 2 }), item({ id: 'c'.repeat(32), name: 'Cursor', plan: 'Plus', today_usd_micros: null, paid_back_today: null }),
    item({ id: 'd'.repeat(32), name: '自建网关', plan: null })], { days, today_value: { api_usd_micros: 60_000_000, usd_daily_minor: 733.33, ratio: 8.2, paid_back: true } }), 'USD');
  assert.deepEqual(view.today, { value: '$60', hasValue: true, daily: '$7.33', paid: true, ratio: 8.2, gap: '' });
  assert.deepEqual(view.week.cells.map(c => [c.label, c.value, c.state]), [['四', '—', 'none'], ['五', '—', 'none'], ['六', '$20', 'unpaid'], ['日', '$30', 'unpaid'], ['一', '$40', 'paid'], ['二', '$50', 'paid'], ['今天', '$60', 'paid']]);
  assert.equal(view.week.paidDays, 3);
  assert.equal(view.active[0].icon, '/assets/subscriptions/claude.png'); assert.deepEqual(view.active[0].today, { value: '$30', paid: true, shared: '2 个订阅合计' });
  assert.equal(view.active[1].icon, '/assets/subscriptions/cursor.png'); assert.equal(view.active[1].today, null);
  assert.equal(view.active[2].icon, ''); assert.equal(view.active[2].initial, '自');
  const short = S.presentList(listData([item()], { today_value: { api_usd_micros: 2_000_000, usd_daily_minor: 666.67, ratio: 0.3, paid_back: false } }), 'USD');
  assert.equal(short.today.gap, '$4.67'); assert.equal(short.today.paid, false);
  for (const p of S.PRESETS) assert.ok(fs.existsSync(path.join(__dirname, '..', p.icon)), p.icon);
});

test('用量推测的订阅显示图标、用量和依据；综合给出估算提示', () => {
  const view = S.presentList(listData([], { suggestions: [{ key: 'chatgpt', tokens: 1_234_000_000, evidence: ['codex', 'gpt-6.1-sol'] }, { key: 'other', tokens: 52_000, evidence: ['dsh', 'hy4-preview'] }, { key: 'unknown', tokens: 1 }] }), 'CNY');
  assert.equal(view.empty, true);
  assert.deepEqual(view.suggestions.map(s => [s.key, s.name, s.tokens, s.evidence]), [['chatgpt', 'ChatGPT', '12.34 亿', 'codex · gpt-6.1-sol'], ['other', '综合', '5.2 万', 'dsh · hy4-preview']]);
  assert.equal(view.suggestions[1].icon, '/assets/subscriptions/other.png'); assert.match(view.suggestions[1].hint, /按月估算/);
});

test('表单校验名称、价格、自定义天数和开始日期；停用时带停用日期', () => {
  const today = '2026-10-21', form = S.formFromItem(null, today);
  assert.equal(form.currency, 'USD'); assert.equal(form.start_day, today);
  assert.equal(S.bodyFromForm(form, today).error, '请填写服务名称');
  assert.equal(S.bodyFromForm({ ...form, name: 'Kimi', price: 'abc' }, today).error, '请填写有效的价格');
  assert.equal(S.bodyFromForm({ ...form, name: 'Kimi', price: '9', cycle: 'custom', custom_days: '0' }, today).error, '自定义周期为 1 到 3650 天');
  assert.equal(S.bodyFromForm({ ...form, name: 'Kimi', price: '9', start_day: '2026-10-22' }, today).error, '开始日期不能晚于今天');
  const { body } = S.bodyFromForm({ ...form, name: ' Kimi ', plan: '', price: '199', currency: 'CNY' }, today);
  assert.deepEqual(body, { name: 'Kimi', plan: null, price: 199, currency: 'CNY', cycle: 'month', custom_days: null, start_day: today, status: 'active', notes: null });
  assert.equal(S.bodyFromForm({ ...S.formFromItem(item(), today), status: 'paused' }, today).body.ended_day, today);
  assert.equal(S.formFromItem(item(), today).price, '200');
});

function cacheFixture() {
  const calls = [], store = new Map([['session_token', 'session'], ['account_known', true]]), module = { exports: {} };
  const wx = { getStorageSync: k => store.get(k), setStorageSync: (k, v) => store.set(k, v), removeStorageSync: k => store.delete(k), clearStorageSync: () => store.clear(), request: o => calls.push(o) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/api.js'), 'utf8'), { wx, module, Date, require: id => require(path.join(__dirname, '../utils', path.basename(id))) });
  return { api: module.exports, calls };
}
const reply = (f, data) => f.calls.at(-1).success({ statusCode: 200, data });

test('订阅列表复用缓存；增改删直接写回缓存，不清空用量缓存', async () => {
  const f = cacheFixture();
  let p = f.api.myUsage('day'); reply(f, { summary: { tokens: 1 } }); await p;
  p = f.api.subscriptions(); reply(f, listData([])); await p; await f.api.subscriptions(); assert.equal(f.calls.length, 2);
  p = f.api.createSubscription({ name: 'Claude' }); assert.equal(f.calls.at(-1).method, 'POST'); assert.match(f.calls.at(-1).url, /\/api\/subscriptions$/);
  reply(f, listData([item()])); await p;
  assert.equal(f.api.peekSubscriptions().items.length, 1); await f.api.myUsage('day'); await f.api.subscriptions(); assert.equal(f.calls.length, 3);
  p = f.api.updateSubscription('a'.repeat(32), { name: 'Claude' }); assert.match(f.calls.at(-1).url, /\/api\/subscriptions\/a{32}$/); reply(f, listData([item({ plan: 'Pro' })])); await p;
  assert.equal(f.api.peekSubscriptions().items[0].plan, 'Pro');
  p = f.api.deleteSubscription('a'.repeat(32)); assert.equal(f.calls.at(-1).method, 'DELETE'); reply(f, listData([])); await p;
  assert.equal(f.api.peekSubscriptions().items.length, 0);
});

function pageFixture(file, api) {
  let definition; const navigation = [], modals = [], sheets = [], guards = [];
  const wx = { navigateTo: o => navigation.push(o.url), navigateBack: () => navigation.push('back'), showToast() {}, stopPullDownRefresh() {}, setNavigationBarTitle() {},
    showModal: o => modals.push(o), showActionSheet: o => sheets.push(o), enableAlertBeforeUnload: o => guards.push(o.message), disableAlertBeforeUnload: () => guards.push('off') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', file), 'utf8'), { require: id => id.endsWith('/api') ? api : S, wx, Page: o => definition = o, Date });
  const p = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) {
    for (const [k, v] of Object.entries(patch)) { const keys = k.split('.'); let o = this.data; while (keys.length > 1) o = o[keys.shift()]; o[keys[0]] = v; } } };
  return { p, navigation, modals, sheets, guards };
}
const baseApi = (extra = {}) => ({ accountEpoch: () => 0, accountState: () => '', ensureSession: async () => {}, peekSubscriptions: () => null, ...extra });

test('列表页空状态引导添加；有记录时点行进入编辑，满 30 个不再进入添加页', async () => {
  const f = pageFixture('subscriptions/subscriptions.js', baseApi({ subscriptions: async () => listData([]) }));
  await f.p.onShow(); assert.equal(f.p.data.view.active.length, 0); f.p.add(); assert.deepEqual(f.navigation, ['/pages/subscription-edit/subscription-edit']);
  const full = pageFixture('subscriptions/subscriptions.js', baseApi({ subscriptions: async () => listData(Array.from({ length: 30 }, (_, i) => item({ id: String(i).padStart(32, '0') }))) }));
  await full.p.onShow(); full.p.add(); assert.deepEqual(full.navigation, []);
  full.p.edit({ currentTarget: { dataset: { id: 'x'.repeat(32) } } }); assert.match(full.navigation[0], /id=x{32}$/);
});

test('添加页选预设填入套餐和价格，校验失败不提交，保存成功解除离开提醒并返回', async () => {
  const saved = [];
  const f = pageFixture('subscription-edit/subscription-edit.js', baseApi({ createSubscription: async body => { saved.push(body); return listData([item()]); } }));
  await f.p.onLoad({});
  await f.p.save(); assert.equal(f.p.data.error, '请填写服务名称'); assert.equal(saved.length, 0);
  f.p.choosePreset({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.p.data.sheet.name, 'Claude'); assert.equal(f.p.data.sheet.icon, '/assets/subscriptions/claude.png'); assert.equal(f.p.data.sheet.plans[3].label, '$200/月'); assert.equal(f.p.data.sheet.plans[1].label, '$200/年');
  f.p.choosePlan({ currentTarget: { dataset: { index: 3 } } }); assert.equal(f.p.data.sheet, null); assert.equal(f.p.data.form.cycle, 'month');
  assert.equal(f.p.data.icon, '/assets/subscriptions/claude.png'); assert.equal(f.p.data.selected, 'claude');
  assert.equal(f.p.data.form.name, 'Claude'); assert.equal(f.p.data.form.plan, 'Max 20x'); assert.equal(f.p.data.form.price, '200'); assert.equal(f.guards.length, 1);
  f.p.pickCurrency({ detail: { value: '0' } }); assert.equal(f.p.data.symbol, '¥'); f.p.pickCurrency({ detail: { value: '1' } }); assert.equal(f.p.data.form.currency, 'USD');
  await f.p.save(); assert.equal(saved[0].price, 200); assert.equal(saved[0].currency, 'USD'); assert.deepEqual(f.navigation, ['back']); assert.equal(f.guards.at(-1), 'off');
});

test('编辑页读取已有订阅，可删除；删除失败显示错误不返回', async () => {
  const deleted = [];
  const api = baseApi({ peekSubscriptions: () => listData([item()]), deleteSubscription: async id => { deleted.push(id); throw Object.assign(new Error('这条订阅已不存在，请刷新'), { code: 'SUBSCRIPTION_NOT_FOUND' }); } });
  const f = pageFixture('subscription-edit/subscription-edit.js', api);
  await f.p.onLoad({ id: 'a'.repeat(32) }); assert.equal(f.p.data.form.plan, 'Max 20x');
  f.p.remove(); assert.match(f.modals[0].content, /Claude/); await f.modals[0].success({ confirm: true });
  assert.deepEqual(deleted, ['a'.repeat(32)]); assert.match(f.p.data.error, /不存在/); assert.deepEqual(f.navigation, []); assert.equal(f.p.data.busy, false);
  const missing = pageFixture('subscription-edit/subscription-edit.js', baseApi({ peekSubscriptions: () => listData([]) }));
  await missing.p.onLoad({ id: 'b'.repeat(32) }); assert.match(missing.p.data.error, /不存在/);
});

test('从用量建议进入直接弹出套餐；综合只填名称；保存并继续添加清空表单留在本页', async () => {
  const saved = [];
  const api = baseApi({ createSubscription: async body => { saved.push(body); return listData([item()]); } });
  const f = pageFixture('subscription-edit/subscription-edit.js', api);
  await f.p.onLoad({ preset: 'chatgpt' });
  assert.equal(f.p.data.sheet.name, 'ChatGPT'); assert.deepEqual(f.p.data.sheet.plans.map(p => p.label), ['$8/月', '$20/月', '$100/月', '$200/月', '$500/月']);
  f.p.closeSheet(); f.p.choosePreset({ currentTarget: { dataset: { index: S.PRESETS.findIndex(p => p.key === 'other') } } });
  assert.equal(f.p.data.form.name, '综合'); assert.equal(f.p.data.form.plan, '按月估算'); assert.equal(f.p.data.form.price, ''); assert.equal(f.p.data.icon, '/assets/subscriptions/other.png');
  f.p.input({ currentTarget: { dataset: { field: 'price' } }, detail: { value: '300' } });
  f.p.pickCurrency({ detail: { value: '0' } }); assert.equal(f.p.data.form.currency, 'CNY'); assert.equal(f.p.data.symbol, '¥');
  await f.p.saveAndNext();
  assert.equal(saved[0].name, '综合'); assert.equal(saved[0].currency, 'CNY'); assert.deepEqual(f.navigation, []);
  assert.equal(f.p.data.form.name, ''); assert.equal(f.p.data.added, 1); assert.equal(f.guards.at(-1), 'off');
});
