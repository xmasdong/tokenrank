const api = require('../../utils/api');
const flow = require('../../utils/flow');
const usage = require('../../utils/usage');
const connectPrompt = require('../../utils/connect-prompt');

Page({
  data: { periods: flow.PERIODS, period: 'day', user: null, myGroups: [],
    loading: true, error: '', connState: 'pending', connText: '', hasReported: false, usage: null, usageLoading: true, usageError: '' },
  onShow() { wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true }); return this.load(); },
  onHide() { this._requestId = (this._requestId || 0) + 1; },
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
      my_rank_label: g.rank_hidden ? '未参与排名' : g.group_hidden ? '本群已隐藏' : g.profile_required ? '待完善资料' : g.my_rank ? api.cnRank(g.my_rank).label : '未上榜',
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
      if (requestId === this._requestId) this.setData({ usage: usage.present(result), usageLoading: false });
    } catch (err) {
      if (requestId === this._requestId) this.setData({ usageError: err.message, usageLoading: false });
    }
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period) return;
    this.setData({ period });
    return this.load();
  },
  promptConnect() {
    const { user, hasReported, myGroups } = this.data;
    connectPrompt.maybePrompt(wx, { user, hasReported, joined: myGroups.length > 0 }, () => this.goConnect());
  },
  openGroup(e) { wx.navigateTo({ url: flow.groupUrl(e.currentTarget.dataset.id) }); },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goProfile() { wx.switchTab({ url: '/pages/profile/profile' }); },
  goShare() { wx.navigateTo({ url: usage.shareUrl(this.data.period) }); },
  goSquare() { wx.switchTab({ url: '/pages/square/square' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
  onShareAppMessage() { return flow.shareCard(); },
});
