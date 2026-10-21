const api = require('../../utils/api');
const { PRESETS, CYCLES, STATUSES, symbol, iconFor, formFromItem, bodyFromForm } = require('../../utils/subscriptions');
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
Page({
  data: { id: '', loading: false, error: '', busy: false, today: '', form: null,
    presets: PRESETS.map(p => ({ key: p.key, name: p.name, icon: p.icon })), cycles: CYCLES, statuses: STATUSES,
    sheet: null, icon: '', symbol: '$', selected: '' },
  async onLoad(options = {}) {
    const today = beijingToday(), id = options.id ? decodeURIComponent(options.id) : '';
    this._epoch = api.accountEpoch();
    this.setData({ id, today });
    wx.setNavigationBarTitle({ title: id ? '编辑订阅' : '添加订阅' });
    if (!id) { this.setData({ form: formFromItem(null, today) }); return; }
    this.setData({ loading: true });
    try {
      const data = api.peekSubscriptions() || await api.subscriptions();
      const item = (data.items || []).find(i => i.id === id);
      if (this._epoch !== api.accountEpoch()) return;
      if (!item) { this.setData({ loading: false, error: '这条订阅已不存在，请返回刷新' }); return; }
      this.setData({ loading: false, form: formFromItem(item, today), icon: iconFor(item.name), symbol: symbol(item.currency) });
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
  toggleCurrency() { const next = this.data.form.currency === 'USD' ? 'CNY' : 'USD'; this.changed({ 'form.currency': next, symbol: symbol(next) }); },
  pick(e) { const { field, key } = e.currentTarget.dataset; this.changed({ ['form.' + field]: key }); },
  pickDate(e) { this.changed({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  choosePreset(e) {
    const preset = PRESETS[e.currentTarget.dataset.index];
    if (!preset || this.data.busy) return;
    const base = { 'form.name': preset.name, 'form.currency': preset.currency, 'form.cycle': preset.cycle, icon: preset.icon, symbol: symbol(preset.currency), selected: preset.key };
    // Like 超值: a single plan applies at once; several open a sheet; no verified price fills only the name.
    if (preset.plans.length === 0) { this.changed({ ...base, 'form.plan': '', 'form.price': '' }); return; }
    if (preset.plans.length === 1) { this.changed({ ...base, 'form.plan': preset.plans[0][0], 'form.price': String(preset.plans[0][1]) }); return; }
    this._sheetBase = base;
    this.setData({ sheet: { name: preset.name, icon: preset.icon, plans: preset.plans.map(([plan, price]) => ({ plan, price: String(price), label: '$' + price + '/月' })) } });
  },
  choosePlan(e) {
    const plan = this.data.sheet?.plans[e.currentTarget.dataset.index];
    if (!plan) return;
    this.setData({ sheet: null });
    this.changed({ ...this._sheetBase, 'form.plan': plan.plan, 'form.price': plan.price });
  },
  closeSheet() { this.setData({ sheet: null }); },
  leave() {
    if (this._guarded && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this._guarded = false;
    wx.navigateBack();
  },
  async save() {
    if (this.data.busy || !this.data.form) return;
    const { body, error } = bodyFromForm(this.data.form, this.data.today);
    if (error) { this.setData({ error }); return; }
    const epoch = api.accountEpoch();
    this.setData({ busy: true, error: '' });
    try {
      await (this.data.id ? api.updateSubscription(this.data.id, body) : api.createSubscription(body));
      if (epoch === api.accountEpoch()) this.leave();
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
