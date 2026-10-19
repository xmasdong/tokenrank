const api = require('../../utils/api');
const usage = require('../../utils/usage');
const { createDailyReminder } = require('../../utils/daily-reminder');
const { socialImages } = require('../../utils/social-images');
const { dailyTitle } = require('../../utils/daily-share');
function view(report) {
  return { ...report, ...(report.has_history ? usage.present(report) : {}),
    dateText: report.day.replace(/-/g, '.'), topTool: report.top_tool?.name || '未分类', topModel: report.top_model?.name || '未分类' };
}
Page({
  ...socialImages(wx,api),
  data: { day: '', loading: true, error: '', report: null, expanded: false, reminder: {loading:true},
    record:null, sharePreparing:false, shareError:'', socialCoverPath:'', socialPosterPath:'', socialImageError:'' },
  onLoad(options) { this.setData({ day: options.day || '' }); this._sourceReminder = /^[a-f0-9]{24}$/.test(options.reminder_id || '') ? options.reminder_id : ''; wx.hideShareMenu(); },
  onShow() { this._visible = true; this._socialVisible = true;
    const epoch = api.accountEpoch();
    if (this._epoch !== undefined && this._epoch !== epoch) { this._raw = null; this.clearDailyShare(); this._renewal?.hide(); this._renewal = null; this.setData({ report: null, expanded: false, loading: true, error: '', reminder:{loading:true} }); }
    this._epoch = epoch;
    if (api.accountState()) return this.load();
    if (!this._renewal) this._renewal = createDailyReminder(api,wx,reminder=>this.setData({reminder}));
    return Promise.all([this.load(),this._renewal.show({sourceId:this._sourceReminder})]); },
  onReady() { this._socialCanvasReady = true; return this.buildSocialImages(); },
  onHide() { this._visible = false; this._socialVisible = false; this._renewal?.hide(); this._request = (this._request || 0) + 1;
    this._shareRequest = (this._shareRequest || 0)+1; this._recordEpoch = null; this._socialVersion = (this._socialVersion || 0)+1; this.setData({sharePreparing:false}); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await Promise.all([this.load({ force: true }),this._renewal?.load({force:true})]); } finally { wx.stopPullDownRefresh(); } },
  async load(options = {}) {
    const request = this._request = (this._request || 0) + 1, epoch = api.accountEpoch();
    const current = () => request === this._request && this._visible && epoch === api.accountEpoch() && !api.accountState();
    if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
    const cached = options.force ? null : api.peekDaily(this.data.day);
    if (cached) { this.showReport(cached); return this.prepareShare(); }
    const sameDay = this.data.report?.day === this.data.day;
    if (options.force || !sameDay) this.clearDailyShare();
    this.setData({ loading: !sameDay, error: '', ...(sameDay ? {} : { report: null, expanded: false }) });
    try {
      await api.ensureSession(); if (!current()) return;
      const report = await api.daily(this.data.day, options);
      if (current()) { this.showReport(report); return this.prepareShare(options.retry === true,{force:options.force === true}); }
    } catch (error) { if (current()) this.setData({ loading: false, error: error.message || '日报暂不可用，请重试' }); }
  },
  showReport(report) {
    const same = this._raw === report; this._raw = report;
    this.setData({ day: report.day, report: same && this.data.report ? this.data.report : view(report), loading: false, error: '' });
    if (!report.has_history) this.clearDailyShare();
  },
  clearDailyShare() {
    this._preparedKey = ''; this._recordEpoch = null; this._shareRequest = (this._shareRequest || 0)+1;
    this.resetSocialImages(); wx.hideShareMenu(); this.setData({record:null,sharePreparing:false,shareError:''});
  },
  async prepareShare(retried = false, options = {}) {
    if (!this._visible || !this._raw?.has_history || api.accountState()) return;
    const id=this._shareRequest=(this._shareRequest || 0)+1, request=this._request, epoch=api.accountEpoch(), day=this.data.day;
    const current=()=>this._visible && id===this._shareRequest && request===this._request && epoch===api.accountEpoch() && !api.accountState();
    const user=api.peekMe?.(),key=JSON.stringify([day,this._raw.snapshot,epoch,user?.nickname,user?.avatar_url]);
    if (!options.force && this._preparedKey===key && this.data.record && (!this.data.record.expires_at || this.data.record.expires_at>Date.now())) {
      this._recordEpoch=epoch;this._socialRecord=this.data.record;
      wx.showShareMenu({menus:['shareAppMessage'],withShareTicket:true});this.buildSocialImages();return;
    }
    this._preparedKey='';this.resetSocialImages();wx.hideShareMenu();this.setData({record:null,sharePreparing:true,shareError:''});
    try {
      const record=await api.createDailyShare({day,day_snapshot:this._raw.snapshot},options);
      if (!current()) return;
      if (record.style!=='daily' || record.usage.from!==day || record.usage.to!==day || !/^[a-f0-9]{24}$/.test(record.id)) throw new Error('日报分享记录无效，请重试');
      this._preparedKey=key;this._recordEpoch=epoch;this._socialRecord=record;
      this.setData({record});wx.showShareMenu({menus:['shareAppMessage'],withShareTicket:true});this.buildSocialImages();
    } catch(error) {
      if (!current()) return;
      if (error.code==='DAY_CHANGED' && !retried) return this.load({force:true,retry:true});
      this.setData({shareError:error.message || '分享准备失败，请重试'});
    } finally { if(current())this.setData({sharePreparing:false}); }
  },
  retryShare() { return this.prepareShare(false,{force:true}); },
  shareDailyImage() {
    const record=this.data.record,epoch=api.accountEpoch(),path=this.data.socialPosterPath;
    if (!path || !record || this._recordEpoch!==epoch || api.accountState() || record.usage.from!==this.data.day) return;
    const preview=()=>{if(this._visible && epoch===api.accountEpoch() && !api.accountState())wx.previewImage({urls:[path]});};
    if (typeof wx.showShareImageMenu!=='function') {preview();return;}
    wx.showShareImageMenu({path,needShowEntrance:true,entrancePath:'/pages/record/record?id='+record.id,
      fail:error=>{if(!/cancel/i.test(error.errMsg || ''))preview();}});
  },
  switchDay(e) { const day = e.currentTarget.dataset.day; if (day && day !== this.data.day) { this.setData({ day, expanded: false }); return this.load(); } },
  toggleDetails() { this.setData({ expanded: !this.data.expanded }); },
  subscribeNextDaily() { this._renewal?.subscribe(); },
  retryDailyAppointment() { return this._renewal?.save(); },
  reloadDailyReminder() { return this._renewal?.load({force:true}); },
  goReminders() { wx.navigateTo({ url: '/pages/reminders/reminders?kind=daily' }); },
  goEmail() { wx.navigateTo({ url: '/pages/email/email' }); },
  goCalendar() { wx.navigateTo({ url: '/pages/calendar/calendar?month=' + this.data.day.slice(0,7) }); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  onShareAppMessage() {
    const record=this.data.record;
    return record && this._recordEpoch===api.accountEpoch() && !api.accountState() && record.usage.from===this.data.day
      ? {title:dailyTitle(record.user,record.usage),path:'/pages/record/record?id='+record.id,imageUrl:this.data.socialCoverPath || '/assets/share-cover.png'}
      : {title:'Token 群排名',path:'/pages/index/index',imageUrl:'/assets/share-cover.png'};
  },
});
