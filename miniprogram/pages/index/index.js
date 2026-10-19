const api = require('../../utils/api');
const reminderPrompt = require('../../utils/reminder-prompt');
const flow = require('../../utils/flow');
const usage = require('../../utils/usage');
const { quickShare } = require('../../utils/quick-share');
const updatePrompt = require('../../utils/update-prompt');

Page({
  ...quickShare(api, wx),
  data: { periods: flow.PERIODS, period: 'day', user: null, myGroups: [],
    loading: true, error: '', connState: 'pending', connText: '', hasReported: false, usage: null, usageLoading: true, usageError: '' },
  onShow() { this._visible = true; wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true }); return this.load(); },
  onHide() { this._visible = false; this.clearQuickShare(); this._requestId = (this._requestId || 0) + 1; },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  async load(options = {}) {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const period = this.data.period;
    const cachedUser = options.force === true ? null : api.peekMe();
    const cachedGroups = options.force === true ? null : api.peekRankings(period);
    const cachedUsage = options.force === true ? null : api.peekUsage(period);
    if (cachedUser && cachedGroups && cachedUsage) {
      this.setData({ user: cachedUser, ...flow.connection(cachedUser), error: '', usageError: '' });
      this.showGroups(cachedGroups);
      this.setData({ usage: usage.present(cachedUsage), usageLoading: false });
      this.prepareUsageShare(cachedUsage);
      this.promptConnect();
      return;
    }
    this.setData({ loading: !cachedGroups, error: '', usage: cachedUsage ? usage.present(cachedUsage) : null,
      usageLoading: !cachedUsage, usageError: '' });
    if (cachedGroups) this.showGroups(cachedGroups);
    try {
      await api.ensureSession();
      if (requestId !== this._requestId) return;
      await Promise.all([
        api.ensureLogin(options).then(user => { if (requestId === this._requestId) this.setData({ user, ...flow.connection(user) }); }),
        this.loadGroups(period, requestId, options), this.loadUsage(period, requestId, options),
      ]);
      if (requestId === this._requestId) this.promptConnect();
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message, usageLoading: false, usageError: err.message });
    }
  },
  showGroups(result) {
    const myGroups = result.groups.map(g => ({ ...g,
      my_rank_label: g.rank_hidden ? '未参与排名' : g.group_hidden ? '本群已隐藏' : g.profile_required ? '待完善资料' : g.my_rank ? String(g.my_rank) : '未上榜',
      tokens_fmt: api.fmtTokens(g.my_tokens),
      updated_fmt: g.updated_at ? api.fmtRelTime(g.updated_at) : '等待首次上报',
    }));
    this.setData({ myGroups, loading: false });
  },
  async loadGroups(period, requestId, options) {
    try {
      const result = await api.myRankings(period, options);
      if (requestId !== this._requestId) return;
      this.showGroups(result);
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message });
    }
  },
  async loadUsage(period, requestId, options) {
    try {
      const result = await api.myUsage(period, options);
      if (requestId === this._requestId) {
        this.setData({ usage: usage.present(result), usageLoading: false });
        this.prepareUsageShare(result);
      }
    } catch (err) {
      if (requestId === this._requestId) this.setData({ usageError: err.message, usageLoading: false });
    }
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period) return;
    this.clearQuickShare();
    this.setData({ period });
    return this.load();
  },
  promptConnect() {
    updatePrompt.maybePrompt(wx, this.data.user);
    reminderPrompt.maybePrompt(api, wx, this.data.user, () => this._visible);
  },
  openGroup(e) { wx.navigateTo({ url: flow.groupUrl(e.currentTarget.dataset.id) }); },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goProfile() { wx.switchTab({ url: '/pages/profile/profile' }); },
  onReady() { this.buildQuickCover(); },
  prepareUsageShare(result) {
    if (!result.has_history) { this.clearQuickShare(); return; }
    this.prepareQuickShare({ stamp: `${result.summary.tokens}:${result.last_report_at || ''}` });
  },
  goShare() { wx.navigateTo({ url: usage.shareUrl(this.data.period) }); },
  goSquare() { wx.switchTab({ url: '/pages/square/square' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
  onShareAppMessage(options = {}) { return options.target?.dataset?.kind === 'personal' ? this.quickShareCard() || flow.shareCard() : flow.shareCard(); },
});
