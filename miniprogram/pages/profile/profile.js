const api = require('../../utils/api');
const privacyNotice = require('../../utils/privacy-notice');
const flow = require('../../utils/flow');
const usage = require('../../utils/usage');
const { profileEditor } = require('../../utils/profile-editor');
Page({
  ...profileEditor(api, wx),
  data: { user: null, nickname: '', avatarUrl: '', avatarDraft: '', saving: false, loading: true, error: '', profileError: '',
    periods: usage.PERIODS, period: 'day', usage: null, usageLoading: true, usageError: '',
    expanded: false, selectedDay: null, nicknameReady: false, nicknameFocus: false, privacyBusy: false, avatarNative: true,
    connState: 'pending', connText: '', hasReported: false },
  onShow() { privacyNotice.maybeShow(wx); this._unloaded = false; this.checkNicknamePrivacy(); return this.load(); },
  async toggleRanking(e) {
    const hidden = !e.detail.value;
    this.setData({ rankingSaving: true });
    try {
      const user = await api.setRanking(hidden);
      if (this._unloaded) return;
      this.setData({ user: { ...this.data.user, ...user } });
      wx.showToast({ title: hidden ? '已关闭排名' : '已恢复排名', icon: 'none' });
    } catch (err) {
      if (!this._unloaded) { this.setData({ user: { ...this.data.user } }); wx.showToast({ title: err.message || '设置失败，请重试', icon: 'none' }); }
    } finally { if (!this._unloaded) this.setData({ rankingSaving: false }); }
  },
  onHide() { this._requestId = (this._requestId || 0) + 1; this.setData({ nicknameFocus: false }); },
  onUnload() { this._unloaded = true; this._privacyCheck = (this._privacyCheck || 0) + 1; this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  showUser(user, profileRevision) {
    if (profileRevision === (this._profileRevision || 0)) {
      this.setData({ user, nickname: this._dirty ? this.data.nickname : user.nickname || '',
        avatarUrl: this.data.avatarDraft || user.avatar_url || '', loading: false, ...flow.connection(user) });
    } else this.setData({ loading: false });
  },
  async load(options = {}) {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const profileRevision = this._profileRevision || 0;
    const period = this.data.period;
    const cachedUser = options.force === true ? null : api.peekMe();
    const cachedUsage = options.force === true ? null : api.peekUsage(period);
    if (cachedUser && cachedUsage) {
      this.showUser(cachedUser, profileRevision);
      this.setData({ usage: usage.present(cachedUsage), usageLoading: false, error: '', usageError: '' });
      return;
    }
    this.setData({ loading: !cachedUser, error: '', usageLoading: !cachedUsage, usageError: '',
      usage: cachedUsage ? usage.present(cachedUsage) : null, selectedDay: null });
    if (cachedUser) this.showUser(cachedUser, profileRevision);
    try {
      await api.ensureSession();
      if (requestId !== this._requestId) return;
      await Promise.all([
        api.ensureLogin(options).then(user => { if (requestId === this._requestId) this.showUser(user, profileRevision); }),
        api.myUsage(period, options).then(result => {
          if (requestId === this._requestId) this.setData({ usage: usage.present(result), usageLoading: false });
        }).catch(err => { if (requestId === this._requestId) this.setData({ usageLoading: false, usageError: err.message }); }),
      ]);
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, usageLoading: false, error: err.message });
    }
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (!usage.PERIODS.some(p => p.key === period) || period === this.data.period) return;
    this.setData({ period, expanded: false, selectedDay: null });
    return this.load();
  },
  selectDay(e) { this.setData({ selectedDay: this.data.usage.daily[e.currentTarget.dataset.index] }); },
  toggleDetails() { this.setData({ expanded: !this.data.expanded }); },
  goShare() { wx.navigateTo({ url: usage.shareUrl(this.data.period) }); },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goGroups() { wx.switchTab({ url: '/pages/index/index' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
});
