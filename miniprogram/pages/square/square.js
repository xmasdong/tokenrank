const api = require('../../utils/api');
const flow = require('../../utils/flow');
const { presentEntries, presentMe } = require('../../utils/leaderboard');
const { presentAnalysis } = require('../../utils/analytics');
Page({
  data: { periods: flow.PERIODS, period: 'day', entries: [], me: null, user: null, loading: true, error: '', updated_fmt: '',
    total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '', mode: 'ranking', insights: null },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this.setData({ loadingMore: false }); },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  present(entries) {
    return presentEntries(entries, this.data.me);
  },
  showBoard(lb) {
    this.setData({ entries: presentEntries(lb.entries, lb.me), total: lb.total ?? null, hasMore: !!lb.has_more,
      nextOffset: lb.next_offset ?? null, snapshot: lb.snapshot || '', loadingMore: false, moreError: '',
      me: presentMe(lb.me),
      updated_fmt: api.fmtRelTime(lb.updated_at), loading: false, error: '' });
  },
  async load(options = {}) {
    if (this.data.mode !== 'ranking') return this.loadInsights(options);
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const period = this.data.period;
    this.setData({ user: api.peekMe() || null });
    const cached = options.force === true ? null : api.peekLeaderboard({ scope: 'global', period });
    if (cached) { this.showBoard(cached); return; }
    this.setData({ loading: true, error: '', me: null });
    try {
      await api.ensureSession().catch(() => null);
      if (requestId !== this._requestId) return;
      // Own avatar/profile loads in parallel; a slow profile cannot hold up the ranking.
      api.ensureLogin(options).then(user => {
        if (requestId === this._requestId) this.setData({ user });
      }).catch(() => {});
      const lb = await api.fetchLeaderboard({ scope: 'global', period }, options);
      if (requestId !== this._requestId) return;
      this.showBoard(lb);
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message });
    }
  },
  // First page is 50; continuation must match the first page's snapshot or the list restarts.
  async loadMore() {
    if (this.data.mode !== 'ranking') return;
    if (!this._visible || this.data.loading || this.data.loadingMore || !this.data.hasMore || !this.data.snapshot) return;
    const requestId = this._requestId;
    const { period, snapshot, nextOffset } = this.data;
    const current = () => this._visible && requestId === this._requestId;
    this.setData({ loadingMore: true, moreError: '' });
    try {
      const lb = await api.fetchLeaderboard({ scope: 'global', period, offset: nextOffset, snapshot }, { force: true });
      if (!current()) return;
      if (lb.snapshot !== snapshot) { const err = new Error('榜单已有更新'); err.statusCode = 409; throw err; }
      this.setData({ entries: this.data.entries.concat(this.present(lb.entries)), total: lb.total ?? this.data.total,
        hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null, loadingMore: false });
    } catch (err) {
      if (!current()) return;
      if (err.statusCode === 409) {
        await this.load({ force: true });
        if (this._visible && this.data.period === period && !this.data.error) wx.showToast({ title: '榜单有更新，已刷新', icon: 'none' });
      } else this.setData({ moreError: err.message || '加载失败，请重试', loadingMore: false });
    } finally { if (current()) this.setData({ loadingMore: false }); }
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period) return;
    this.setData({ period });
    return this.load();
  },
  switchMode(e) {
    const mode = e.currentTarget.dataset.key;
    if (!['ranking','tools','models'].includes(mode) || mode === this.data.mode) return;
    this.setData({ mode, insights: null }); return this.load();
  },
  async loadInsights(options = {}) {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const query = { scope: 'public', period: this.data.period, dimension: this.data.mode };
    const cached = options.force === true ? null : api.peekAnalysis?.(query);
    if (cached) { this.setData({ insights: presentAnalysis(cached), loading: false, error: '', me: null, updated_fmt: api.fmtRelTime(cached.updated_at) }); return; }
    this.setData({ loading: true, error: '', me: null, insights: null });
    try {
      const result = await api.analysis(query, options);
      if (requestId !== this._requestId) return;
      this.setData({ insights: presentAnalysis(result), loading: false, updated_fmt: api.fmtRelTime(result.updated_at) });
    } catch (err) { if (requestId === this._requestId) this.setData({ loading: false, error: err.message }); }
  },
  goTrends() { wx.navigateTo({ url: '/pages/trends/trends?period=' + (this.data.period === 'month' ? 'month' : 'week') + '&dimension=' + (this.data.mode === 'models' ? 'models' : 'tools') }); },
  goAnalysis(e) {
    const name = e.currentTarget?.dataset?.name;
    wx.navigateTo({ url: '/pages/analysis/analysis?scope=public&period=' + this.data.period +
      '&dimension=' + (this.data.mode === 'models' ? 'models' : 'tools') + (name ? '&name=' + encodeURIComponent(name) : '') });
  },
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  goMine() { wx.switchTab({ url: '/pages/profile/profile' }); },
  onShareAppMessage() { return this.data.mode === 'ranking' ? { title: 'AI 编码 Token 广场榜', path: '/pages/square/square', imageUrl: '/assets/share-cover.png' }
    : { title: `${this.data.mode === 'models' ? '模型' : '工具'} · 广场使用分布`, path: '/pages/analysis/analysis?scope=public&period=' + this.data.period + '&dimension=' + this.data.mode, imageUrl: '/assets/share-cover.png' }; },
});
