const api = require('../../utils/api');
const { trendsView } = require('../../utils/history');
Page({
  data: { period: 'week', dimension: 'tools', metric: 'users', end: '', loading: true, error: '', report: null, loadingMore: false, moreError: '' },
  onLoad(options) { this.setData({ period: options.period === 'month' ? 'month' : 'week', dimension: options.dimension === 'models' ? 'models' : 'tools',
    metric: options.metric === 'tokens' ? 'tokens' : 'users', end: options.end || '' }); wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true }); },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this.setData({ loadingMore: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  query() { return { period: this.data.period, dimension: this.data.dimension, metric: this.data.metric, end: this.data.end }; },
  async load(options = {}) {
    const request = this._requestId = (this._requestId || 0) + 1;
    this.setData({ loading: true, error: '', report: null, loadingMore: false, moreError: '' });
    try {
      const report = await api.trends(this.query(), options);
      if (request !== this._requestId) return;
      this.setData({ report: trendsView(report), loading: false });
    } catch (error) { if (request === this._requestId) this.setData({ loading: false, error: error.message || '趋势榜暂不可用，请重试' }); }
  },
  switchOption(e) {
    const { field, value } = e.currentTarget.dataset;
    const allowed = { period: ['week','month'], dimension: ['tools','models'], metric: ['users','tokens'] };
    if (!allowed[field]?.includes(value) || this.data[field] === value) return;
    this.setData({ [field]: value }); return this.load();
  },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  async loadMore() {
    if (!this._visible || this.data.loading || this.data.loadingMore || !this.data.report?.has_more) return;
    const request = this._requestId, first = this.data.report;
    this.setData({ loadingMore: true, moreError: '' });
    try {
      const result = await api.trends({ ...this.query(), end: first.to, offset: first.next_offset, snapshot: first.snapshot }, { force: true });
      if (request !== this._requestId) return;
      this.setData({ report: trendsView({ ...result, entries: [...first.entries, ...result.entries] }) });
    } catch (error) {
      if (request !== this._requestId) return;
      if (error.statusCode === 409) { await this.load({ force: true }); return; }
      this.setData({ moreError: error.message || '加载失败，请重试' });
    } finally { if (request === this._requestId) this.setData({ loadingMore: false }); }
  },
  onShareAppMessage() { const r = this.data.report;
    return { title: (this.data.dimension === 'models' ? '模型' : '工具') + '趋势榜' + (r ? ' · ' + r.from.slice(5) + '—' + r.to.slice(5) : ''),
      path: '/pages/trends/trends?period=' + this.data.period + '&dimension=' + this.data.dimension + '&metric=' + this.data.metric + (r ? '&end=' + r.to : ''), imageUrl: '/assets/share-cover.png' };
  },
});
