// Shown every time the mini program is opened, until the user taps “不再提示”.
// Rendered by components/privacy-notice so the repository address can be copied.
const modalQueue = require('./modal-queue');
const KEY = 'privacy_notice_hidden_v1';
const REPO_URL = 'https://github.com/xmasdong/tokenrank';
let due = false;

function arm() { due = true; }

/** Consumes this launch's notice; returns true when the dialog should open. */
function claim(wx) {
  if (!due) return false;
  due = false;
  if (wx.getStorageSync(KEY)) return false;
  modalQueue.hold();
  return true;
}

function dismiss(wx, never) {
  if (never) wx.setStorageSync(KEY, 1);
  modalQueue.release();
}

module.exports = { arm, claim, dismiss, KEY, REPO_URL };
