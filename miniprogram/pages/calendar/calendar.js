const api = require('../../utils/api');
const { calendarView } = require('../../utils/history');
Page({
  data: { month: '', loading: true, error: '', report: null, selected: null, weekdays: ['一','二','三','四','五','六','日'] },
  onLoad(options) { this.setData({ month: /^20\d{2}-\d{2}$/.test(options.month || '') ? options.month : '' }); wx.hideShareMenu(); },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  async load(options = {}) {
    const request = this._requestId = (this._requestId || 0) + 1, epoch = api.accountEpoch();
    this.setData({ loading: true, error: '', report: null, selected: null });
    try {
      if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
      await api.ensureLogin();
      if (request !== this._requestId || epoch !== api.accountEpoch()) return;
      const result = await api.calendar(this.data.month, options);
      if (request !== this._requestId || epoch !== api.accountEpoch()) return;
      const report = calendarView(result), selected = report.days.find(day => day.day === result.today) || [...report.days].reverse().find(day => day.reported) || report.days[0];
      this.setData({ month: result.month, report, selected, loading: false });
    } catch (error) { if (request === this._requestId) this.setData({ loading: false, error: error.message || '日历暂不可用，请重试' }); }
  },
  switchMonth(e) {
    const month = e.currentTarget.dataset.month;
    if (!month || month === this.data.month) return;
    this.setData({ month }); return this.load();
  },
  selectDay(e) {
    const selected = this.data.report?.days.find(day => day.day === e.currentTarget.dataset.day && !day.future);
    if (selected) this.setData({ selected });
  },
  goWeekly() {
    const day = this.data.selected?.day;
    if (!day) return;
    const date = new Date(day + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    wx.navigateTo({ url: '/pages/weekly/weekly?week=' + date.toISOString().slice(0, 10) });
  },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
});
