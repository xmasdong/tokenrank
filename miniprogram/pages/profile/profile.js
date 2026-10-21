const api = require('../../utils/api');
const reminderPrompt = require('../../utils/reminder-prompt');
const flow = require('../../utils/flow');
const usage = require('../../utils/usage');
const { quickShare } = require('../../utils/quick-share');
const { profileEditor } = require('../../utils/profile-editor');
Page({
  ...quickShare(api, wx),
  ...profileEditor(api, wx),
  data: { user: null, nickname: '', avatarUrl: '', avatarDraft: '', saving: false, loading: true, error: '', profileError: '',
    periods: usage.PERIODS, period: 'day', usage: null, usageLoading: true, usageError: '',
    expanded: false, selectedDay: null, nicknameReady: false, nicknameFocus: false, privacyBusy: false, avatarNative: true,
    connState: 'pending', connText: '', hasReported: false },
  onShow() { this._visible = true; this._unloaded = false; this.checkNicknamePrivacy(); return this.load(); },
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
  onHide() { this._visible = false; this.clearQuickShare(); this._requestId = (this._requestId || 0) + 1; this.setData({ nicknameFocus: false }); },
  onUnload() { this._unloaded = true; this._privacyCheck = (this._privacyCheck || 0) + 1; this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  showUser(user, profileRevision) {
    if (profileRevision === (this._profileRevision || 0)) {
      this.setData({ user, nickname: this._dirty ? this.data.nickname : user.nickname || '',
        avatarUrl: this.data.avatarDraft || user.avatar_url || '', loading: false, ...flow.connection(user) });
    } else this.setData({ loading: false });
    reminderPrompt.maybePrompt(api, wx, user, () => this._visible);
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
      this.prepareUsageShare(cachedUsage);
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
          if (requestId === this._requestId) {
            this.setData({ usage: usage.present(result), usageLoading: false });
            this.prepareUsageShare(result);
          }
        }).catch(err => { if (requestId === this._requestId) this.setData({ usageLoading: false, usageError: err.message }); }),
      ]);
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, usageLoading: false, error: err.message });
    }
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (!usage.PERIODS.some(p => p.key === period) || period === this.data.period) return;
    this.clearQuickShare();
    this.setData({ period, expanded: false, selectedDay: null });
    return this.load();
  },
  selectDay(e) { this.setData({ selectedDay: this.data.usage.daily[e.currentTarget.dataset.index] }); },
  toggleDetails() { this.setData({ expanded: !this.data.expanded }); },
  onReady() { this.buildQuickCover(); },
  prepareUsageShare(result) {
    if (!result.has_history) { this.clearQuickShare(); return; }
    this.prepareQuickShare({ stamp: `${result.summary.tokens}:${result.last_report_at || ''}` });
  },
  goShare() { wx.navigateTo({ url: usage.shareUrl(this.data.period) }); },
  goTools() { wx.navigateTo({ url: usage.shareUrl(this.data.period) + '&style=tools' }); },
  goCalendar() { wx.navigateTo({ url: '/pages/calendar/calendar' }); },
  goDaily() { wx.navigateTo({ url: '/pages/daily/daily' }); },
  goWeekly() { wx.navigateTo({ url: '/pages/weekly/weekly' }); },
  goAnalysis() { wx.navigateTo({ url: '/pages/analysis/analysis?scope=mine&period=' + this.data.period }); },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goReminders() { wx.navigateTo({ url: '/pages/reminders/reminders' }); },
  goGroups() { wx.switchTab({ url: '/pages/index/index' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
  onShareAppMessage() { return this.quickShareCard() || { title: 'Token 用量统计', path: '/pages/index/index' }; },
  goAccount() { wx.navigateTo({ url: '/pages/account/account' }); },
});
