const api = require('../../utils/api');
const STATES = { pending: '已预约本次', sending: '正在提交发送', sent: '本次已提交微信', cancelled: '已取消', needs_permission: '需要重新授权', failed: '本次发送失败', unknown: '发送结果待确认', skipped: '本次未发送' };
const formatTime = value => value ? new Date(value + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
function rows(status) {
  return status.kinds.map(item => {
    const state = item.appointment?.state;
    return { ...item, statusText: !item.available ? '暂未开放' : item.appointment?.error_code === 'NO_DAY_USAGE' ? '该日没有同步记录' : item.appointment?.error_code === 'DAILY_EXPIRED' ? '本次预约已过期' : STATES[state] || '未预约',
      dayText: (state === 'pending' ? item.appointment.report_day : item.report_day) || '',
      timeText: formatTime(state === 'pending' ? item.appointment.scheduled_at : item.scheduled_at),
      canBook: item.available && status.has_reported && !['pending', 'sending'].includes(state) };
  });
}
Page({
  data: { loading: true, error: '', items: [], hasReported: false, busy: '', savePending: '', notice: '', focus: '' },
  onLoad(options) { this.setData({ focus: options.kind === 'weekly' ? 'daily' : ['daily', 'sync_error'].includes(options.kind) ? options.kind : '' }); },
  onShow() { this._visible = true;
    const epoch = api.accountEpoch();
    if (this._accountEpoch !== undefined && this._accountEpoch !== epoch) {
      this._pendingSave = null; this._saving = false;
      this.setData({ items: [], hasReported: false, busy: '', savePending: '', notice: '', error: '' });
    }
    this._accountEpoch = epoch;
    if (this._pendingSave && !this._saving) this.setData({ savePending: this._pendingSave.kind, busy: '', notice: '微信已授权，请重试保存本次预约。' });
    return this.load(); },
  onHide() { this._visible = false; this._request = (this._request || 0) + 1; },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { if (!this.data.busy) await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  showStatus(status) { this.setData({ items: rows(status), hasReported: status.has_reported, loading: false, error: '' }); },
  async load(options = {}) {
    if (this.data.busy) return;
    const request = this._request = (this._request || 0) + 1, epoch = api.accountEpoch();
    const current = () => this._visible && request === this._request && epoch === api.accountEpoch() && !api.accountState();
    const cached = options.force ? null : api.peekReminders();
    if (cached && !api.accountState()) { this.showStatus(cached); return; }
    this.setData({ loading: !this.data.items.length, error: '' });
    try {
      if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
      await api.ensureSession();
      if (!current()) return;
      const status = await api.reminders(options);
      if (current()) this.showStatus(status);
    } catch (error) { if (current()) this.setData({ loading: false, error: error.message || '暂时无法读取提醒设置' }); }
  },
  // Native subscription must be invoked synchronously inside a real button tap.
  subscribe(e) {
    const kind = e.currentTarget.dataset.kind, item = this.data.items.find(row => row.key === kind);
    if (!this._visible || this._accountEpoch !== api.accountEpoch() || api.accountState() || this.data.loading || this.data.busy || this.data.savePending || !item?.canBook || !item.template_id) return;
    if (typeof wx.requestSubscribeMessage !== 'function') { wx.showToast({ title: '请更新微信后再试', icon: 'none' }); return; }
    const epoch = api.accountEpoch(), active = () => epoch === api.accountEpoch() && !api.accountState();
    this.setData({ busy: kind, notice: '' });
    wx.requestSubscribeMessage({ tmplIds: [item.template_id],
      success: result => {
        if (!active()) return;
        if (result[item.template_id] === 'accept') {
          const requestId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + '_' + Math.random().toString(36).slice(2);
          this._pendingSave = { kind, requestId, epoch };
          return this.saveAppointment();
        }
        this.setData({ busy: '', notice: result[item.template_id] === 'ban' ? '微信通知未允许，可在微信设置中检查。' : '本次未授权，提醒没有开启。' });
      },
      fail: error => { if (active()) this.setData({ busy: '', notice: error.errCode === 20004 ? '微信通知未允许，可在微信设置中检查。' : '本次未完成授权，请稍后重试。' }); },
    });
  },
  async saveAppointment() {
    const pending = this._pendingSave;
    if (!pending || pending.epoch !== api.accountEpoch() || api.accountState() || this._saving) return;
    this._saving = true;
    if (this._visible) this.setData({ busy: pending.kind, notice: '' });
    try {
      const status = await api.reserveReminder(pending.kind, pending.requestId);
      if (pending.epoch !== api.accountEpoch() || api.accountState()) return;
      this._pendingSave = null;
      if (this._visible) { this.showStatus(status); this.setData({ savePending: '', notice: '已预约本次提醒。下次需要再次预约。' }); }
    } catch (error) {
      if (this._visible && pending.epoch === api.accountEpoch() && !api.accountState()) this.setData({ savePending: pending.kind, notice: '微信已授权，预约尚未确认：' + error.message });
    } finally { this._saving = false; if (pending.epoch === api.accountEpoch() && !api.accountState()) this.setData({ busy: '' }); }
  },
  async cancel(e) {
    const kind = e.currentTarget.dataset.kind, item = this.data.items.find(row => row.key === kind), epoch = api.accountEpoch();
    if (!this._visible || this._accountEpoch !== epoch || this.data.busy || this.data.savePending || api.accountState() || item?.appointment?.state !== 'pending') return;
    this.setData({ busy: kind, notice: '' });
    try {
      const status = await api.cancelReminder(kind, item.appointment.id);
      if (this._visible && epoch === api.accountEpoch() && !api.accountState()) { this.showStatus(status); this.setData({ notice: '本次预约已取消。' }); }
    } catch (error) { if (this._visible && epoch === api.accountEpoch() && !api.accountState()) this.setData({ notice: error.message }); }
    finally { if (epoch === api.accountEpoch() && !api.accountState()) this.setData({ busy: '' }); }
  },
  openSettings() { wx.openSetting({ withSubscriptions: true }); },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
});
