const api = require('../../utils/api');
const { presentList } = require('../../utils/subscriptions');
Page({
  data: { loading: true, error: '', view: null },
  onShow() {
    this._visible = true;
    const epoch = api.accountEpoch();
    if (this._accountEpoch !== undefined && this._accountEpoch !== epoch) this.setData({ view: null, error: '' });
    this._accountEpoch = epoch;
    return this.load();
  },
  onHide() { this._visible = false; this._request = (this._request || 0) + 1; },
  onUnload() { this.onHide(); },
  current(epoch) { return this._visible && epoch === api.accountEpoch() && !api.accountState(); },
  async load(options = {}) {
    const epoch = api.accountEpoch(), request = this._request = (this._request || 0) + 1;
    if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
    const cached = options.force ? null : api.peekSubscriptions();
    if (cached) { this.setData({ view: presentList(cached), loading: false, error: '' }); return; }
    this.setData({ loading: !this.data.view, error: '' });
    try {
      await api.ensureSession();
      if (!this.current(epoch) || request !== this._request) return;
      const data = await api.subscriptions(options);
      if (this.current(epoch) && request === this._request) this.setData({ view: presentList(data), loading: false });
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
