// Keep an accepted permission in memory until its idempotent appointment is saved.
// It is never renewed automatically or persisted as a permanent subscription.
let accepted = null;
const formatTime = value => value ? new Date(value + 8 * 3600000).toISOString().slice(0,16).replace('T',' ') : '';
function createDailyReminder(api, wx, render) {
  const epoch = api.accountEpoch();
  if (accepted?.epoch !== epoch) accepted = null;
  let visible = false, request = 0, saving = false, validated = null;
  let state = { loading:true, busy:false, savePending:false, error:'', notice:'', item:null, hasReported:false };
  const accountActive = () => epoch === api.accountEpoch() && !api.accountState();
  const current = () => visible && accountActive();
  const pending = () => accepted?.epoch === epoch ? accepted : null;
  function update(values) {
    state = {...state,...values};
    if (current()) render(state);
  }
  function showStatus(status) {
    const item = status.kinds.find(row => row.key === 'daily'), appointment = item?.appointment;
    const booked = appointment?.state === 'pending', sending = appointment?.state === 'sending';
    update({ loading:false, error:'', hasReported:status.has_reported,
      item:item ? {...item, booked, sending, timeText:formatTime(booked ? appointment.scheduled_at : item.scheduled_at),
        dayText:(booked ? appointment.report_day : item.report_day) || '',
        canBook:item.available && status.has_reported && !booked && !sending} : null });
  }
  async function load(options = {}) {
    if (!current() || state.busy || pending()) return;
    const id = ++request, cached = options.force ? null : api.peekReminders();
    const item = cached?.kinds.find(row => row.key === 'daily'), job = item?.appointment;
    // Notification links identify the permission just consumed. Only stale reminder
    // status is refreshed; the report and all other usage caches remain intact.
    const consumed = options.sourceId && job?.id === options.sourceId && ['pending','sending'].includes(job.state);
    const due = job?.state === 'pending' && job.scheduled_at <= Date.now();
    const rollover = item?.available && item.scheduled_at <= Date.now();
    const force = options.force === true || rollover || (cached !== validated && (consumed || due));
    if (cached && !force) { showStatus(cached); return; }
    update({loading:!state.item, error:''});
    try {
      await api.ensureSession();
      if (!current() || id !== request) return;
      const status = await api.reminders({force});
      if (current() && id === request) { validated = status; showStatus(status); }
    } catch (error) {
      if (current() && id === request) update({loading:false,error:error.message || '暂时无法读取日报提醒'});
    }
  }
  async function save() {
    const operation = pending();
    if (!operation || !accountActive() || saving) return;
    request++; saving = true;
    update({busy:true,savePending:true,notice:'',error:''});
    try {
      const task = operation.task || (operation.task = api.reserveReminder('daily',operation.requestId));
      const status = await task;
      if (!accountActive()) return;
      if (accepted === operation) accepted = null;
      showStatus(status);
      update({savePending:false,notice:'下次日报已预约。'});
    } catch (error) {
      if (accountActive()) update({savePending:true,notice:'微信已授权，预约尚未确认：'+error.message});
    } finally {
      operation.task = null; saving = false;
      update({busy:false});
    }
  }
  function subscribe() {
    // Must stay synchronous within the actual tap; no login or GET before this call.
    if (!current() || state.loading || state.error || state.busy || pending() || !state.item?.canBook || !state.item.template_id) return;
    if (typeof wx.requestSubscribeMessage !== 'function') { update({notice:'请更新微信后再试。'}); return; }
    request++;
    update({busy:true,notice:''});
    const templateId = state.item.template_id;
    wx.requestSubscribeMessage({tmplIds:[templateId],
      success:result => {
        if (!accountActive()) return;
        if (result[templateId] === 'accept') {
          accepted = {epoch,requestId:Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+'_'+Math.random().toString(36).slice(2),task:null};
          return save();
        }
        update({busy:false,notice:result[templateId] === 'ban' ? '微信通知未允许，可在提醒设置中检查。' : '本次未授权，下一次日报没有预约。'});
      },
      fail:error => { if (accountActive()) update({busy:false,notice:error.errCode === 20004 ? '微信通知未允许，可在提醒设置中检查。' : '本次未完成授权，请稍后重试。'}); },
    });
  }
  return {
    show(options = {}) {
      visible = true;
      const operation = pending();
      if (operation) {
        update({loading:false,savePending:true,notice:'微信已授权，请保存本次预约。'});
        if (operation.task) return save();
        return;
      }
      return load(options);
    },
    hide() { visible = false; request++; },
    load, subscribe, save,
  };
}
module.exports = { createDailyReminder };
