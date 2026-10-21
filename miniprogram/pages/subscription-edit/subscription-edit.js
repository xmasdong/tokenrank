const api = require('../../utils/api');
const { PRESETS, CYCLES, CURRENCIES, STATUSES, symbol, iconFor, planLabel, formFromItem, bodyFromForm } = require('../../utils/subscriptions');
const DISPLAY_KEY = 'subscription_display_currency';
const displayCurrency = () => { try { return CURRENCIES.find(c => c.key === wx.getStorageSync(DISPLAY_KEY))?.key || 'CNY'; } catch { return 'CNY'; } };
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
Page({
  data: { id: '', loading: false, error: '', busy: false, today: '', form: null,
    presets: PRESETS.map(p => ({ key: p.key, name: p.name, icon: p.icon })), cycles: CYCLES, statuses: STATUSES,
    sheet: null, icon: '', symbol: '$', selected: '', added: 0,
    currencyLabels: CURRENCIES.map(c => `${c.label} ${c.symbol}`), currencyIndex: 1 },
  withCurrency(currency) { return { symbol: symbol(currency), currencyIndex: Math.max(0, CURRENCIES.findIndex(c => c.key === currency)) }; },
  async onLoad(options = {}) {
    const today = beijingToday(), id = options.id ? decodeURIComponent(options.id) : '';
    this._epoch = api.accountEpoch();
    this.setData({ id, today });
    wx.setNavigationBarTitle({ title: id ? '编辑订阅' : '添加订阅' });
    if (!id) {
      const currency = displayCurrency();
      this.setData({ form: formFromItem(null, today, currency), ...this.withCurrency(currency) });
      // From a usage suggestion: open that service's plans straight away.
      const index = PRESETS.findIndex(p => p.key === options.preset);
      if (index >= 0) this.choosePreset({ currentTarget: { dataset: { index } } });
      return;
    }
    this.setData({ loading: true });
    try {
      const data = api.peekSubscriptions() || await api.subscriptions();
      const item = (data.items || []).find(i => i.id === id);
      if (this._epoch !== api.accountEpoch()) return;
      if (!item) { this.setData({ loading: false, error: '这条订阅已不存在，请返回刷新' }); return; }
      this.setData({ loading: false, form: formFromItem(item, today), icon: iconFor(item.name), ...this.withCurrency(item.currency) });
    } catch (error) { this.setData({ loading: false, error: error.message || '暂时无法读取订阅' }); }
  },
  changed(patch) {
    if (this.data.busy) return;
    this.setData({ ...patch, error: '' });
    if (!this._guarded && wx.enableAlertBeforeUnload) { this._guarded = true; wx.enableAlertBeforeUnload({ message: '修改还没保存，确定离开？' }); }
  },
  input(e) {
    const field = e.currentTarget.dataset.field, patch = { ['form.' + field]: e.detail.value };
    if (field === 'name') patch.icon = iconFor(e.detail.value);
    this.changed(patch);
  },
  pickCurrency(e) { const c = CURRENCIES[Number(e.detail.value)]; if (c) this.changed({ 'form.currency': c.key, ...this.withCurrency(c.key) }); },
  pick(e) { const { field, key } = e.currentTarget.dataset; this.changed({ ['form.' + field]: key }); },
  toggleApiKey(e) { this.changed({ 'form.api_key': !!e.detail.value }); },
  goTopup() { wx.redirectTo({ url: '/pages/topup-edit/topup-edit?vendor=deepseek' }); },
  pickDate(e) { this.changed({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  choosePreset(e) {
    const preset = PRESETS[e.currentTarget.dataset.index];
    if (!preset || this.data.busy) return;
    const base = { 'form.name': preset.name, 'form.currency': preset.currency, icon: preset.icon, ...this.withCurrency(preset.currency), selected: preset.key };
    const plans = preset.plans.map(([plan, price, cycle]) => ({ plan, price: String(price), cycle, label: planLabel(preset.currency, price, cycle) }));
    // Like 超值: a single plan applies at once, several open a sheet.
    this._sheetBase = base;
    if (plans.length === 1) { this.applyPlan(plans[0]); return; }
    // 综合: no plan, the user enters roughly what the rest costs a month.
    if (!plans.length) { this.applyPlan({ plan: '按月估算', price: '', cycle: 'month' }); return; }
    this.setData({ sheet: { name: preset.name, icon: preset.icon, plans } });
  },
  choosePlan(e) {
    const plan = this.data.sheet?.plans[e.currentTarget.dataset.index];
    if (!plan) return;
    this.setData({ sheet: null });
    this.applyPlan(plan);
  },
  applyPlan(plan) { this.changed({ ...this._sheetBase, 'form.plan': plan.plan, 'form.price': plan.price, 'form.cycle': plan.cycle }); },
  closeSheet() { this.setData({ sheet: null }); },
  leave() {
    if (this._guarded && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this._guarded = false;
    wx.navigateBack();
  },
  // Several subscriptions in a row: save, keep the page, start an empty form.
  saveAndNext() { return this.save({ next: true }); },
  async save(options = {}) {
    if (this.data.busy || !this.data.form) return;
    const next = options.next === true && !this.data.id;
    const { body, error } = bodyFromForm(this.data.form, this.data.today);
    if (error) { this.setData({ error }); return; }
    const epoch = api.accountEpoch();
    this.setData({ busy: true, error: '' });
    try {
      await (this.data.id ? api.updateSubscription(this.data.id, body) : api.createSubscription(body));
      if (epoch !== api.accountEpoch()) return;
      if (!next) { this.leave(); return; }
      const title = body.plan ? body.name + ' ' + body.plan : body.name;
      if (this._guarded && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      this._guarded = false;
      const currency = displayCurrency();
      this.setData({ form: formFromItem(null, this.data.today, currency), icon: '', ...this.withCurrency(currency), selected: '', added: (this.data.added || 0) + 1 });
      wx.pageScrollTo && wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      wx.showToast({ title: `已添加 ${title}`, icon: 'none' });
    } catch (err) { if (epoch === api.accountEpoch()) this.setData({ error: err.message || '保存尚未确认，请重试' }); }
    finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
  },
  remove() {
    if (this.data.busy || !this.data.id) return;
    wx.showModal({ title: '删除订阅', content: `删除「${this.data.form.name}」的记录，不影响实际扣费。`, confirmText: '删除', confirmColor: '#FA5151',
      success: async result => {
        if (!result.confirm || this.data.busy) return;
        const epoch = api.accountEpoch();
        this.setData({ busy: true, error: '' });
        try { await api.deleteSubscription(this.data.id); if (epoch === api.accountEpoch()) this.leave(); }
        catch (err) { if (epoch === api.accountEpoch()) this.setData({ error: err.message || '删除尚未确认，请重试' }); }
        finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
      } });
  },
});
