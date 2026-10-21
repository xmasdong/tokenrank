const api = require('../../utils/api');
const { presentList, CURRENCIES } = require('../../utils/subscriptions');
const DISPLAY_KEY = 'subscription_display_currency';
const readDisplay = () => { try { return CURRENCIES.find(c => c.key === wx.getStorageSync(DISPLAY_KEY))?.key || 'CNY'; } catch { return 'CNY'; } };
Page({
  data: { loading: true, error: '', view: null, currencyLabels: CURRENCIES.map(c => `${c.label} ${c.symbol}`), currencyIndex: 0 },
  onShow() {
    this._visible = true;
    const epoch = api.accountEpoch();
    if (this._accountEpoch !== undefined && this._accountEpoch !== epoch) this.setData({ view: null, error: '' });
    this._accountEpoch = epoch;
    return this.load();
  },
  onHide() { this._visible = false; this._request = (this._request || 0) + 1; },
  onUnload() { this.onHide(); },
  show(data) {
    this._data = data;
    const display = readDisplay();
    this.setData({ view: presentList(data, display), loading: false, error: '', currencyIndex: CURRENCIES.findIndex(c => c.key === display) });
  },
  pickDisplay(e) {
    const c = CURRENCIES[Number(e.detail.value)];
    if (!c) return;
    try { wx.setStorageSync(DISPLAY_KEY, c.key); } catch { /* the choice still applies to this view */ }
    if (this._data) this.setData({ view: presentList(this._data, c.key), currencyIndex: Number(e.detail.value) });
  },
  addSuggested(e) {
    const { key, topup } = e.currentTarget.dataset;
    wx.navigateTo({ url: topup ? '/pages/topup-edit/topup-edit?vendor=' + encodeURIComponent(key) : '/pages/subscription-edit/subscription-edit?preset=' + encodeURIComponent(key) });
  },
  addTopup(e) { wx.navigateTo({ url: `/pages/topup-edit/topup-edit?vendor=${encodeURIComponent(e.currentTarget.dataset.vendor)}&kind=${e.currentTarget.dataset.kind || 'topup'}` }); },
  editTopup(e) { wx.navigateTo({ url: '/pages/topup-edit/topup-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  current(epoch) { return this._visible && epoch === api.accountEpoch() && !api.accountState(); },
  async load(options = {}) {
    const epoch = api.accountEpoch(), request = this._request = (this._request || 0) + 1;
    if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
    const cached = options.force ? null : api.peekSubscriptions();
    if (cached) { this.show(cached); return; }
    this.setData({ loading: !this.data.view, error: '' });
    try {
      await api.ensureSession();
      if (!this.current(epoch) || request !== this._request) return;
      const data = await api.subscriptions(options);
      if (this.current(epoch) && request === this._request) this.show(data);
    } catch (error) {
      if (this.current(epoch) && request === this._request) this.setData({ loading: false, error: error.message || '暂时无法读取订阅' });
    }
  },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  add() {
    if (this.data.view?.full) { wx.showToast({ title: '最多记录 30 个订阅', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/subscription-edit/subscription-edit' });
  },
  edit(e) { wx.navigateTo({ url: '/pages/subscription-edit/subscription-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
});
