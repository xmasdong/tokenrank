const api = require('../../utils/api');
const { TOPUP_PRESETS, CURRENCIES, symbol, topupForm, topupBody } = require('../../utils/subscriptions');
const beijingToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const KINDS = [{ key: 'topup', label: '充值' }, { key: 'balance', label: '校准余额' }];
Page({
  data: { id: '', vendor: 'deepseek', name: '', icon: '', loading: false, busy: false, error: '', today: '', form: null, kinds: KINDS,
    currencyLabels: CURRENCIES.map(c => `${c.label} ${c.symbol}`), currencyIndex: 0, symbol: '¥' },
  withCurrency(c) { return { symbol: symbol(c), currencyIndex: Math.max(0, CURRENCIES.findIndex(x => x.key === c)) }; },
  async onLoad(options = {}) {
    const today = beijingToday(), id = options.id ? decodeURIComponent(options.id) : '';
    const preset = TOPUP_PRESETS.find(p => p.key === (options.vendor || 'deepseek')) || TOPUP_PRESETS[0];
    this.setData({ id, today, vendor: preset.key, name: preset.name, icon: preset.icon });
    wx.setNavigationBarTitle({ title: id ? '编辑充值记录' : preset.name + ' 充值' });
    if (!id) {
      const last = (api.peekSubscriptions()?.topups || []).find(t => t.vendor === preset.key);
      const form = topupForm(null, today, last ? last.currency : preset.currency);
      if (options.kind === 'balance') form.kind = 'balance';
      this.setData({ form, ...this.withCurrency(form.currency) }); return;
    }
    this.setData({ loading: true });
    try {
      const data = api.peekSubscriptions() || await api.subscriptions();
      const record = (data.topups || []).flatMap(t => t.records).find(r => r.id === id);
      if (!record) { this.setData({ loading: false, error: '这条记录已不存在，请返回刷新' }); return; }
      const form = topupForm(record, today);
      this.setData({ loading: false, form, ...this.withCurrency(form.currency) });
    } catch (error) { this.setData({ loading: false, error: error.message || '暂时无法读取充值记录' }); }
  },
  changed(patch) { if (!this.data.busy) this.setData({ ...patch, error: '' }); },
  input(e) { this.changed({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  pickKind(e) { this.changed({ 'form.kind': e.currentTarget.dataset.key }); },
  pickDate(e) { this.changed({ 'form.day': e.detail.value }); },
  pickCurrency(e) { const c = CURRENCIES[Number(e.detail.value)]; if (c) this.changed({ 'form.currency': c.key, ...this.withCurrency(c.key) }); },
  async save() {
    if (this.data.busy || !this.data.form) return;
    const { body, error } = topupBody(this.data.form, this.data.vendor, this.data.today);
    if (error) { this.setData({ error }); return; }
    const epoch = api.accountEpoch();
    this.setData({ busy: true, error: '' });
    try {
      await (this.data.id ? api.updateTopup(this.data.id, body) : api.createTopup(body));
      if (epoch === api.accountEpoch()) wx.navigateBack();
    } catch (err) { if (epoch === api.accountEpoch()) this.setData({ error: err.message || '保存尚未确认，请重试' }); }
    finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
  },
  remove() {
    if (this.data.busy || !this.data.id) return;
    wx.showModal({ title: '删除记录', content: '只删除这条记录，不影响 DeepSeek 账户。', confirmText: '删除', confirmColor: '#FA5151',
      success: async result => {
        if (!result.confirm || this.data.busy) return;
        const epoch = api.accountEpoch();
        this.setData({ busy: true, error: '' });
        try { await api.deleteTopup(this.data.id); if (epoch === api.accountEpoch()) wx.navigateBack(); }
        catch (err) { if (epoch === api.accountEpoch()) this.setData({ error: err.message || '删除尚未确认，请重试' }); }
        finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
      } });
  },
});
