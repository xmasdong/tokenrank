const api = require('../../utils/api');
const { presentList, CURRENCIES } = require('../../utils/subscriptions');
const { WIDTH, posterModel, posterHeight, iconKeys, drawSubscriptionPoster } = require('../../utils/subscription-poster');
const { loadCodeImage } = require('../../utils/share-code');
const loadImage = (canvas, src) => new Promise(resolve => { const img = canvas.createImage(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src; });
const DISPLAY_KEY = 'subscription_display_currency';
const readDisplay = () => { try { return CURRENCIES.find(c => c.key === wx.getStorageSync(DISPLAY_KEY))?.key || 'CNY'; } catch { return 'CNY'; } };
Page({
  data: { loading: true, error: '', view: null, posterBusy: false, currencyLabels: CURRENCIES.map(c => `${c.label} ${c.symbol}`), currencyIndex: 0 },
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
  sharePoster() {
    if (this.data.posterBusy || !this._data) return;
    wx.showActionSheet({ itemList: ['分享订阅清单', '分享订阅清单（隐藏金额）'], success: res => this.buildPoster(res.tapIndex === 1) });
  },
  async buildPoster(hideAmounts) {
    const data = this._data, display = readDisplay(), me = api.peekMe ? api.peekMe() : null;
    const model = posterModel(data, display, { hideAmounts, nickname: me?.nickname || '', day: data.today });
    if (!model.rows.length) { wx.showToast({ title: '先记一笔订阅再分享', icon: 'none' }); return; }
    this.setData({ posterBusy: true });
    try {
      const canvas = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#subPoster').fields({ node: true }).exec(r => resolve(r && r[0] && r[0].node)));
      if (!canvas) throw new Error('画布不可用');
      const [codeImage, ...images] = await Promise.all([loadCodeImage(canvas), ...iconKeys(model).map(src => loadImage(canvas, src))]);
      const icons = Object.fromEntries(iconKeys(model).map((src, i) => [src, images[i]]));
      const height = posterHeight(model);
      canvas.width = WIDTH; canvas.height = height;
      drawSubscriptionPoster(canvas.getContext('2d'), model, { codeImage, icons });
      const path = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, destWidth: WIDTH, destHeight: height, fileType: 'png',
        success: r => resolve(r.tempFilePath), fail: reject }));
      const preview = () => wx.previewImage({ urls: [path] });
      if (typeof wx.showShareImageMenu !== 'function') preview();
      else wx.showShareImageMenu({ path, fail: err => { if (!/cancel/i.test(err.errMsg || '')) preview(); } });
    } catch (err) { wx.showToast({ title: err.message || '清单图生成失败', icon: 'none' }); }
    finally { this.setData({ posterBusy: false }); }
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
