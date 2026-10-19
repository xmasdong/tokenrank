// Inline server metadata avoids a new request on every tab visit.
const queue = require('./modal-queue');
const pending = new Set();
const keyFor = id => 'reminder_prompt_seen_v1:' + id;
function maybePrompt(api, wx, user, isCurrent = () => true) {
  const id = user?.user_id;
  if (!id || !user.reminder_prompt_eligible || !user.reminder_kinds?.length || pending.has(id) || wx.getStorageSync(keyFor(id))) return false;
  const epoch = api.accountEpoch();
  const current = () => isCurrent() && epoch === api.accountEpoch() && !api.accountState();
  if (!current()) return false;
  pending.add(id);
  const kinds = user.reminder_kinds;
  const label = kinds.includes('daily') && kinds.includes('sync_error') ? '日报和同步异常' : kinds.includes('daily') ? '日报' : '同步异常';
  queue.show(wx, {
    title: '电脑已接入', content: `要接收${label}提醒吗？每项提醒一次，可在「我的」管理。`,
    confirmText: '设置提醒', cancelText: '暂不开启', shouldShow: current,
    onSkip: () => pending.delete(id),
    success: result => {
      if (!current() || (!result.confirm && !result.cancel)) return;
      wx.setStorageSync(keyFor(id), true);
      // A failed acknowledgement must not re-open the prompt on every poll.
      api.ackReminderPrompt().catch(() => {});
      if (result.confirm) wx.navigateTo({ url: '/pages/reminders/reminders?from=first' });
    },
    complete: () => pending.delete(id),
  });
  return true;
}
module.exports = { maybePrompt, keyFor, _reset: () => pending.clear() };
