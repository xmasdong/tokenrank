const api = require('../../utils/api');
const { calendarView } = require('../../utils/history');
const { insightImages } = require('../../utils/insight-poster');
const {DEFAULTS,readDisplay,saveDisplay,displayOptions}=require('../../utils/calendar-display');
Page({
  ...insightImages(wx, api),
  data: { month: '', loading: true, error: '', report: null, selected: null, display:{...DEFAULTS},displayOptions:displayOptions(DEFAULTS),customizing:false },
  onLoad(options) { const display=readDisplay(wx);this.setData({ month: /^20\d{2}-\d{2}$/.test(options.month || '') ? options.month : '',display,displayOptions:displayOptions(display) }); wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true }); },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  async load(options = {}) {
    const request = this._requestId = (this._requestId || 0) + 1, epoch = api.accountEpoch();
    const cached = options.force === true ? null : api.peekCalendar?.(this.data.month);
    if (cached) { this.showReport(cached); return; }
    this.setData({ loading: true, error: '', report: null, selected: null });
    try {
      if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
      await api.ensureLogin();
      if (request !== this._requestId || epoch !== api.accountEpoch()) return;
      const result = await api.calendar(this.data.month, options);
      if (request !== this._requestId || epoch !== api.accountEpoch()) return;
      this.showReport(result);
    } catch (error) { if (request === this._requestId) this.setData({ loading: false, error: error.message || '日历暂不可用，请重试' }); }
  },
  showReport(result) {
    if (this._raw === result && this.data.report) { this.setData({ loading: false, error: '' }); return; }
    const report = calendarView(result), days=report.heatmap.days.filter(day=>!day.outside&&!day.future);
    const selected = days.find(day => day.day === this.data.selected?.day) || days.find(day => day.day === result.today) || [...days].reverse().find(day => day.reported) || days[0];
    this._raw = result;
    this.setData({ month: result.month, report, selected, loading: false, error: '' });
    if(selected)this.chooseDate(selected.day);
  },
  switchMonth(e) {
    const month = e.currentTarget.dataset.month;
    if (!month || month === this.data.month) return;
    this.setData({ month }); return this.load();
  },
  selectDay(e) {
    this.chooseDate(e.currentTarget.dataset.day);
  },
  chooseDate(day) { const days=this.data.report?.heatmap.days||[], selected=days.find(item=>item.day===day&&!item.future&&!item.outside);
    if(selected)this.setData({selected,canPrevious:days.some(item=>item.day<day&&!item.outside&&!item.future),canNext:days.some(item=>item.day>day&&!item.outside&&!item.future)});
  },
  pickDate(e) { this.chooseDate(e.detail.value); },
  toggleDisplayOptions(){this.setData({customizing:!this.data.customizing});},
  changeDisplay(e){const chosen=new Set(Array.isArray(e.detail?.value)?e.detail.value:[]);
    const display=saveDisplay(wx,Object.fromEntries(Object.keys(DEFAULTS).map(key=>[key,chosen.has(key)])));
    this._insightImage=null;this.setData({display,displayOptions:displayOptions(display)});
  },
  stepDay(e) { const days=this.data.report?.heatmap.days.filter(day=>!day.outside&&!day.future)||[],i=days.findIndex(day=>day.day===this.data.selected?.day);
    const delta=Number(e.currentTarget.dataset.delta);if(i>=0&&[-1,1].includes(delta)&&days[i+delta])this.chooseDate(days[i+delta].day);
  },
  goDaily() { const day = this.data.selected?.day; if (day && day < this.data.report.today) wx.navigateTo({ url: '/pages/daily/daily?day=' + day }); },
  goWeekly() {
    const day = this.data.selected?.day;
    if (!day) return;
    const date = new Date(day + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    wx.navigateTo({ url: '/pages/weekly/weekly?week=' + date.toISOString().slice(0, 10) });
  },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  insightImageOptions() { return { kind: 'calendar', nickname: api.peekMe?.()?.nickname || '',display:this.data.display }; },
  onShareAppMessage() { return { title: 'Token 群排名 · 使用日历', path: '/pages/index/index', imageUrl: '/assets/share-cover.png' }; },
});
