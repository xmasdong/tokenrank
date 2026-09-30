const api = require('../../utils/api');
const privacyNotice = require('../../utils/privacy-notice');
const flow = require('../../utils/flow');
Page({
  data: { periods: flow.PERIODS, period: 'day', entries: [], me: null, loading: true, error: '', updated_fmt: '',
    total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '' },
  onShow() { privacyNotice.maybeShow(wx); this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this.setData({ loadingMore: false }); },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  present(entries) {
    return entries.map(e => ({ ...e, tokens_fmt: api.fmtTokens(e.tokens), rk: api.cnRank(e.rank), initial: api.initialOf(e.nickname) }));
  },
  showBoard(lb) {
    this.setData({ entries: this.present(lb.entries), total: lb.total ?? null, hasMore: !!lb.has_more,
      nextOffset: lb.next_offset ?? null, snapshot: lb.snapshot || '', loadingMore: false, moreError: '',
      me: lb.me ? { ...lb.me, tokens_fmt: api.fmtTokens(lb.me.tokens), rk: api.cnRank(lb.me.rank) } : null,
      updated_fmt: api.fmtRelTime(lb.updated_at), loading: false, error: '' });
  },
  async load(options = {}) {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const period = this.data.period;
    const cached = options.force === true ? null : api.peekLeaderboard({ scope: 'global', period });
    if (cached) { this.showBoard(cached); return; }
    this.setData({ loading: true, error: '', me: null });
    try {
      await api.ensureSession().catch(() => null);
      const lb = await api.fetchLeaderboard({ scope: 'global', period }, options);
      if (requestId !== this._requestId) return;
      this.showBoard(lb);
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message });
    }
  },
  // First page is 50; continuation must match the first page's snapshot or the list restarts.
  async loadMore() {
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
  goConnect() { wx.navigateTo({ url: flow.connectUrl() }); },
  onShareAppMessage() { return { title: 'AI 编码 Token 广场榜', path: '/pages/square/square', imageUrl: '/assets/share-cover.png' }; },
});
