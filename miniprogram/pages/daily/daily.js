const api = require('../../utils/api');
const usage = require('../../utils/usage');
function view(report) {
  return { ...report, ...(report.has_history ? usage.present(report) : {}),
    dateText: report.day.replace(/-/g, '.'), topTool: report.top_tool?.name || '未分类', topModel: report.top_model?.name || '未分类' };
}
Page({
  data: { day: '', loading: true, error: '', report: null, expanded: false },
  onLoad(options) { this.setData({ day: options.day || '' }); wx.hideShareMenu(); },
  onShow() { this._visible = true;
    const epoch = api.accountEpoch();
    if (this._epoch !== undefined && this._epoch !== epoch) { this._raw = null; this.setData({ report: null, expanded: false, loading: true, error: '' }); }
    this._epoch = epoch; return this.load(); },
  onHide() { this._visible = false; this._request = (this._request || 0) + 1; },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  async load(options = {}) {
    const request = this._request = (this._request || 0) + 1, epoch = api.accountEpoch();
    const current = () => request === this._request && this._visible && epoch === api.accountEpoch() && !api.accountState();
    if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
    const cached = options.force ? null : api.peekDaily(this.data.day);
    if (cached) { this.showReport(cached); return; }
    const sameDay = this.data.report?.day === this.data.day;
    this.setData({ loading: !sameDay, error: '', ...(sameDay ? {} : { report: null, expanded: false }) });
    try {
      await api.ensureSession(); if (!current()) return;
      const report = await api.daily(this.data.day, options);
      if (current()) this.showReport(report);
    } catch (error) { if (current()) this.setData({ loading: false, error: error.message || '日报暂不可用，请重试' }); }
  },
  showReport(report) {
    const same = this._raw === report; this._raw = report;
    this.setData({ day: report.day, report: same && this.data.report ? this.data.report : view(report), loading: false, error: '' });
  },
  switchDay(e) { const day = e.currentTarget.dataset.day; if (day && day !== this.data.day) { this.setData({ day, expanded: false }); return this.load(); } },
  toggleDetails() { this.setData({ expanded: !this.data.expanded }); },
  goReminders() { wx.navigateTo({ url: '/pages/reminders/reminders?kind=daily' }); },
  goEmail() { wx.navigateTo({ url: '/pages/email/email' }); },
  goCalendar() { wx.navigateTo({ url: '/pages/calendar/calendar?month=' + this.data.day.slice(0,7) }); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
});
