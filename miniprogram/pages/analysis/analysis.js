const api = require('../../utils/api');
const { PERIODS, compact } = require('../../utils/usage');
const { presentAnalysis } = require('../../utils/analytics');
const { openInsight } = require('../../utils/insight-access');
Page({
  data: { scope: 'mine', period: 'day', periods: PERIODS, dimension: 'tools', tool: '', view: 'donut', metric: 'tokens',
    loading: true, error: '', report: null, focusName: '', selectedDay: null, visibleCount: 8, hasReported: false,
    audienceName: '', audience: [], audienceTotal: null, audienceLoading: false, audienceError: '',
    audienceHasMore: false, audienceSnapshot: '', audienceNext: null, gateBusy: false },
  onLoad(options) {
    const scope = options.scope === 'public' ? 'public' : 'mine';
    this.setData({ scope, period: PERIODS.some(item => item.key === options.period) ? options.period : 'day',
      dimension: options.tool || options.dimension === 'models' ? 'models' : 'tools', tool: String(options.tool || '').slice(0, 60), focusName: String(options.name || '').slice(0, 100) });
    wx.setNavigationBarTitle?.({ title: scope === 'public' ? '广场数据分析' : '我的数据分析' });
    if (scope === 'public') wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true }); else wx.hideShareMenu();
  },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this._audienceVersion = (this._audienceVersion || 0) + 1;
    this.setData({ gateBusy: false, audienceLoading: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  resetAudience() {
    this._audienceVersion = (this._audienceVersion || 0) + 1; this._audienceGrant = null;
    this.setData({ audienceName: '', audience: [], audienceTotal: null, audienceError: '', audienceLoading: false,
      audienceHasMore: false, audienceSnapshot: '', audienceNext: null, gateBusy: false });
  },
  async load(options = {}) {
    const request = this._requestId = (this._requestId || 0) + 1, epoch = api.accountEpoch();
    const query = { scope: this.data.scope, period: this.data.period, dimension: this.data.dimension, ...(this.data.tool ? { tool: this.data.tool } : {}) };
    this.resetAudience(); this.setData({ loading: true, error: '', selectedDay: null, visibleCount: 8, report: null });
    try {
      if (query.scope === 'mine') {
        if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
        const user = await api.ensureLogin();
        if (request !== this._requestId || epoch !== api.accountEpoch()) return;
        this.setData({ hasReported: !!user.last_report_at });
      }
      const result = api.peekAnalysis?.(query) && options.force !== true ? api.peekAnalysis(query) : await api.analysis(query, options);
      if (request !== this._requestId || (query.scope === 'mine' && epoch !== api.accountEpoch())) return;
      this._raw = result;
      if (!result.items.some(item => !item.unclassified && item.name === this.data.focusName)) this.setData({ focusName: '' });
      this.render(); this.setData({ loading: false });
    } catch (err) { if (request === this._requestId) this.setData({ loading: false, error: err.message || '数据暂不可用，请重试' }); }
  },
  render() { if (this._raw) this.setData({ report: presentAnalysis(this._raw, { metric: this.data.metric, name: this.data.focusName }),
    updatedText: api.fmtRelTime(this._raw.updated_at) }); },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (!PERIODS.some(item => item.key === period) || period === this.data.period) return;
    this.setData({ period }); return this.load();
  },
  switchDimension(e) {
    const dimension = e.currentTarget.dataset.key;
    if (!['tools','models'].includes(dimension) || dimension === this.data.dimension) return;
    this.setData({ dimension, tool: '', focusName: '' }); return this.load();
  },
  switchView(e) {
    const view = e.currentTarget.dataset.key;
    if (['donut','trend','list'].includes(view)) this.setData({ view, selectedDay: null });
  },
  switchMetric(e) {
    const metric = e.currentTarget.dataset.key;
    if (this.data.scope !== 'public' || !['tokens','people'].includes(metric)) return;
    this.setData({ metric }); this.render();
  },
  chooseItem(e) {
    if (e.detail?.aggregate || e.detail?.unclassified) return;
    const name = e.detail?.name || e.currentTarget?.dataset?.name;
    if (!this._raw?.items.some(item => !item.unclassified && item.name === name)) return;
    this.resetAudience(); this.setData({ focusName: this.data.focusName === name ? '' : name, selectedDay: null }); this.render();
  },
  clearFocus() { this.resetAudience(); this.setData({ focusName: '', selectedDay: null }); this.render(); },
  selectDay(e) { this.setData({ selectedDay: this.data.report.daily[e.detail.index] || null }); },
  moreItems() { this.setData({ visibleCount: this.data.visibleCount + 12 }); },
  openToolModels(e) {
    const tool = e.currentTarget?.dataset?.name;
    if (this.data.dimension !== 'tools' || !this._raw?.items.some(item => !item.unclassified && item.name === tool)) return;
    wx.navigateTo({ url: '/pages/analysis/analysis?scope=' + this.data.scope + '&period=' + this.data.period + '&dimension=models&tool=' + encodeURIComponent(tool) });
  },
  backToTools() { wx.redirectTo({ url: '/pages/analysis/analysis?scope=' + this.data.scope + '&period=' + this.data.period + '&dimension=tools' }); },
  async openAudience(e) {
    if (this.data.scope !== 'public' || this.data.gateBusy || this.data.audienceLoading) return;
    const name = e.currentTarget?.dataset?.name || this.data.focusName;
    if (!this._raw?.items.some(item => !item.unclassified && item.name === name)) return;
    this.resetAudience(); this.setData({ focusName: name, audienceName: name, gateBusy: true }); this.render();
    const version = this._audienceVersion, request = this._requestId;
    const current = () => this._visible && version === this._audienceVersion && request === this._requestId;
    try {
      const opened = await openInsight({ feature: 'community_audience', policy: this._raw.access,
        context: { name, period: this.data.period, dimension: this.data.dimension, tool: this.data.tool }, current }, async grant => {
        this._audienceGrant = grant; await this.fetchAudience(false, current);
      });
      if (!opened && current()) this.resetAudience();
    } catch (err) { if (current()) { this.setData({ audienceError: err.message || '暂时无法查看，请重试' }); wx.showToast({ title: err.message || '暂时无法查看', icon: 'none' }); } }
    finally { if (current()) this.setData({ gateBusy: false }); }
  },
  async fetchAudience(more, current, force = false) {
    const query = { period: this.data.period, dimension: this.data.dimension, name: this.data.audienceName,
      ...(this.data.tool ? { tool: this.data.tool } : {}),
      ...(more ? { offset: this.data.audienceNext, snapshot: this.data.audienceSnapshot } : {}) };
    this.setData({ audienceLoading: true, audienceError: '' });
    try {
      const result = await api.insightUsers(query, { force: more || force, grant: this._audienceGrant });
      if (!current()) return;
      const entries = result.entries.map(item => ({ ...item, amount: compact(item.tokens), initial: [...item.nickname][0] || '?' }));
      this.setData({ audience: more ? this.data.audience.concat(entries) : entries, audienceTotal: result.total,
        audienceHasMore: result.has_more, audienceNext: result.next_offset, audienceSnapshot: result.snapshot },
        () => { if (!more && current()) wx.pageScrollTo?.({ selector: '#audience', duration: 160 }); });
    } catch (err) {
      if (!current()) return;
      if (more && err.statusCode === 409) { await this.fetchAudience(false, current, true); return; }
      this.setData({ audienceError: err.message || '暂时无法查看，请重试' });
    } finally { if (current()) this.setData({ audienceLoading: false }); }
  },
  moreAudience() {
    if (!this.data.audienceHasMore || this.data.audienceLoading) return;
    const version = this._audienceVersion, request = this._requestId;
    return this.fetchAudience(true, () => this._visible && version === this._audienceVersion && request === this._requestId);
  },
  audienceAvatarError(e) { this.setData({ [`audience[${e.currentTarget.dataset.index}].avatarFailed`]: true }); },
  goConnect() { wx.navigateTo({ url: api.accountState() ? '/pages/account/account' : '/pages/connect/connect' }); },
  goShareTools() { wx.navigateTo({ url: '/pages/share/share?style=tools&period=' + encodeURIComponent(this.data.period) }); },
  goMine() { wx.navigateTo({ url: api.accountState() ? '/pages/account/account' : '/pages/analysis/analysis?scope=mine&period=' + this.data.period + '&dimension=' + this.data.dimension +
    (this.data.tool ? '&tool=' + encodeURIComponent(this.data.tool) : '') }); },
  onShareAppMessage() { return { title: `${this.data.tool ? this.data.tool + ' · ' : ''}${this.data.focusName || (this.data.dimension === 'models' ? '模型' : '工具')} · 广场使用分布`,
    path: '/pages/analysis/analysis?scope=public&period=' + this.data.period + '&dimension=' + this.data.dimension +
      (this.data.tool ? '&tool=' + encodeURIComponent(this.data.tool) : '') +
      (this.data.focusName ? '&name=' + encodeURIComponent(this.data.focusName) : ''), imageUrl: '/assets/share-cover.png' }; },
});
