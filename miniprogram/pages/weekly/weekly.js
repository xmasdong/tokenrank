const api = require('../../utils/api');
const { weeklyView, weeklyTitle } = require('../../utils/history');
const { socialImages } = require('../../utils/social-images');
Page({
  ...socialImages(wx, api),
  data: { week: '', loading: true, error: '', report: null, record: null, user: null, initial: '我', avatarFailed: false,
    groupIndex: 0, groupOptions: ['不含群排名'], groupIds: [''], sharePreparing: false, shareError: '', saving: false,
    socialCoverPath: '', socialPosterPath: '', socialImageError: '', selectedDay: null },
  onLoad(options) { this._initialGroup = options.g || ''; this.setData({ week: options.week || '' }); wx.hideShareMenu(); },
  onShow() { this._socialVisible = true; return this.load(); },
  onReady() { this._socialCanvasReady = true; return this.buildSocialImages(); },
  onHide() { this._socialVisible = false; this._recordEpoch = null; this._requestId = (this._requestId || 0) + 1;
    this._shareRequest = (this._shareRequest || 0) + 1; this.resetSocialImages(); this.setData({ sharePreparing: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  async load(options = {}) {
    const request = this._requestId = (this._requestId || 0) + 1, epoch = api.accountEpoch();
    this._shareRequest = (this._shareRequest || 0) + 1; this.resetSocialImages(); wx.hideShareMenu();
    this.setData({ loading: true, error: '', report: null, record: null, sharePreparing: false, shareError: '', selectedDay: null });
    try {
      if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
      const user = await api.ensureLogin();
      if (request !== this._requestId || epoch !== api.accountEpoch()) return;
      const result = await api.weekly(this.data.week, options);
      if (request !== this._requestId || epoch !== api.accountEpoch()) return;
      const ids = ['', ...result.groups.map(group => group.id)];
      const previousGroup = this._initialGroup || this.data.groupIds[this.data.groupIndex]; this._initialGroup = '';
      this._raw = result;
      this.setData({ week: result.weekly.week_start, report: weeklyView(result), user, initial: [...(user.nickname || '我')][0],
        groupOptions: ['不含群排名', ...result.groups.map(group => group.name)], groupIds: ids,
        groupIndex: Math.max(0, ids.indexOf(previousGroup)), loading: false });
      if (result.has_history) return this.prepareShare(options.retry === true);
    } catch (error) { if (request === this._requestId) this.setData({ loading: false, error: error.message || '周报暂不可用，请重试' }); }
  },
  switchWeek(e) { const week = e.currentTarget.dataset.week; if (week && week !== this.data.week) { this.setData({ week }); return this.load(); } },
  selectDay(e) { this.setData({ selectedDay: this.data.report.daily[Number(e.currentTarget.dataset.index)] || null }); },
  selectGroup(e) {
    const groupIndex = Number(e.detail.value);
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex >= this.data.groupIds.length || groupIndex === this.data.groupIndex) return;
    this.setData({ groupIndex }); return this.prepareShare();
  },
  async prepareShare(retried = false) {
    if (!this._socialVisible || !this._raw?.has_history) return;
    const shareRequest = this._shareRequest = (this._shareRequest || 0) + 1, request = this._requestId, epoch = api.accountEpoch();
    const current = () => this._socialVisible && shareRequest === this._shareRequest && request === this._requestId && epoch === api.accountEpoch();
    const group = this.data.groupIds[this.data.groupIndex];
    this.resetSocialImages(); wx.hideShareMenu(); this.setData({ record: null, sharePreparing: true, shareError: '' });
    try {
      const record = await api.createWeeklyShare({ week: this.data.week, week_snapshot: this._raw.snapshot, ...(group ? { group_id: group } : {}) });
      if (!current()) return;
      this._recordEpoch = epoch; this._socialRecord = record;
      this.setData({ record, report: weeklyView({ ...this._raw, group_standing: record.usage.group_standing }) });
      wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true });
      return this.buildSocialImages();
    } catch (error) {
      if (!current()) return;
      if (error.statusCode === 409 && !retried) return this.load({ force: true, retry: true });
      this.setData({ shareError: error.message || '分享暂不可用，请重试' });
    } finally { if (current()) this.setData({ sharePreparing: false }); }
  },
  retryShare() { return this.prepareShare(); },
  avatarError() { this.setData({ avatarFailed: true }); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  preview() { if (this.data.socialPosterPath) wx.previewImage({ urls: [this.data.socialPosterPath] }); },
  savePoster() {
    if (!this.data.socialPosterPath || this.data.saving) return;
    this.setData({ saving: true });
    wx.saveImageToPhotosAlbum({ filePath: this.data.socialPosterPath, success: () => wx.showToast({ title: '已保存', icon: 'success' }),
      fail: error => { if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '可点开图片，长按保存', icon: 'none' }); },
      complete: () => this.setData({ saving: false }) });
  },
  onShareAppMessage() {
    const record = this.data.record;
    return record && !api.accountState() && this._recordEpoch === api.accountEpoch() ? { title: weeklyTitle(record.user, record.usage),
      path: '/pages/record/record?id=' + record.id, imageUrl: this.data.socialCoverPath || '/assets/share-cover.png' }
      : { title: 'Token 群排名', path: '/pages/index/index', imageUrl: '/assets/share-cover.png' };
  },
});
