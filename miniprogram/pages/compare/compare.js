const api = require('../../utils/api');
const { comparisonView, comparisonTitle } = require('../../utils/social-share');
const { socialImages } = require('../../utils/social-images');
Page({
  ...socialImages(wx, api),
  data: { id: '', groupMode: false, groupId: '', targetRank: 0, snapshot: '', period: 'day', loading: true, error: '', errorCode: '', record: null, comparison: null,
    sourceName: '', from: '', to: '', socialCoverPath: '', socialPosterPath: '', socialImageError: '', saving: false, revoking: false },
  onLoad(options) {
    this.setData({ id: /^[0-9a-f]{24}$/.test(options.id || '') ? options.id : '', groupMode: !!options.g,
      groupId: String(options.g || '').slice(0, 128), targetRank: Number.isSafeInteger(Number(options.rank)) ? Number(options.rank) : 0, snapshot: options.snapshot || '',
      period: options.period || 'day' });
    if (options.g) wx.setNavigationBarTitle?.({ title: '群内 PK' });
    wx.hideShareMenu();
  },
  onShow() { this._socialVisible = true; return this.load(); },
  onReady() { this._socialCanvasReady = true; return this.buildSocialImages(); },
  onHide() { this._recordEpoch = null; this._socialVisible = false; this._requestId = (this._requestId || 0) + 1; this.resetSocialImages(); },
  onUnload() { this.onHide(); },
  async load() {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    this.resetSocialImages(); wx.hideShareMenu();
    this.setData({ loading: true, error: '', errorCode: '', record: null, comparison: null });
    if (this.data.groupMode) return this.loadGroup(requestId);
    if (!this.data.id) { this.setData({ loading: false, error: '链接无效，请重新打开分享卡片' }); return; }
    try {
      if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
      const source = await api.sharedRecord(this.data.id);
      if (requestId !== this._requestId) return;
      const original = source.comparison?.source || source;
      this.setData({ sourceName: original.user.nickname, from: original.usage.from, to: original.usage.to, period: original.usage.period });
      await api.ensureLogin();
      if (requestId !== this._requestId) return;
      const epoch = api.accountEpoch();
      const record = await api.compareShare(this.data.id);
      if (requestId !== this._requestId || epoch !== api.accountEpoch() || api.accountState()) return;
      this._recordEpoch = epoch;
      this._socialRecord = record;
      this.setData({ record, comparison: comparisonView(record), loading: false });
      wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true });
      return this.buildSocialImages();
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message || '对比暂不可用，请重试', errorCode: err.code || '' });
    }
  },
  async loadGroup(requestId) {
    try {
      if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
      await api.ensureLogin();
      if (requestId !== this._requestId) return;
      const epoch = api.accountEpoch();
      const record = await api.groupComparison(this.data.groupId, { period: this.data.period, rank: this.data.targetRank, snapshot: this.data.snapshot });
      if (requestId !== this._requestId || epoch !== api.accountEpoch() || api.accountState()) return;
      const comparison = comparisonView(record);
      this._recordEpoch = epoch; this._socialRecord = record;
      this.setData({ record, comparison, loading: false });
      return this.buildSocialImages();
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message || '对比暂不可用，请重试', errorCode: err.code || '' });
    }
  },
  goBack() { wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/index/index' }) }); },
  comparisonAvatarError(e) {
    const side = e.currentTarget.dataset.side;
    if (['left', 'right'].includes(side)) this.setData({ [`comparison.${side}.avatarFailed`]: true });
  },
  goConnect() { wx.navigateTo({ url: api.accountState() ? '/pages/account/account' : '/pages/connect/connect' }); },
  goMine() { wx.switchTab({ url: '/pages/profile/profile' }); },
  goTools() { wx.navigateTo({ url: '/pages/share/share?style=tools&period=' + encodeURIComponent(this.data.period || 'week') }); },
  preview() { if (this.data.socialPosterPath) wx.previewImage({ urls: [this.data.socialPosterPath] }); },
  savePoster() {
    if (!this.data.socialPosterPath || this.data.saving) return;
    this.setData({ saving: true });
    wx.saveImageToPhotosAlbum({ filePath: this.data.socialPosterPath,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: err => { if (!/cancel/i.test(err.errMsg || '')) wx.showToast({ title: '可点开图片，长按保存', icon: 'none' }); },
      complete: () => this.setData({ saving: false }) });
  },
  revoke() {
    if (this.data.groupMode || !this.data.record || this.data.revoking) return;
    const id = this.data.record.id;
    wx.showModal({ title: '关闭这张对比卡的链接？', content: '原作者的卡片和已发出的图片不受影响。',
      success: async res => {
        if (!res.confirm) return;
        this.setData({ revoking: true });
        try {
          await api.revokeShare(id); this.resetSocialImages(); wx.hideShareMenu();
          this.setData({ record: null, comparison: null, error: '这张对比卡的链接已关闭', errorCode: 'REVOKED' });
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
        finally { this.setData({ revoking: false }); }
      } });
  },
  onShareAppMessage() {
    if (this.data.groupMode) return { title: '群内 Token 排名', path: '/pages/group/group?enter=1', imageUrl: '/assets/share-cover.png' };
    const record = this.data.record;
    return record && !api.accountState() && this._recordEpoch === api.accountEpoch() ? {
      title: comparisonTitle(record), path: '/pages/record/record?id=' + record.id,
      imageUrl: this.data.socialCoverPath || '/assets/share-cover.png',
    } : { title: 'Token 用量统计', path: '/pages/record/record?id=' + this.data.id };
  },
});
