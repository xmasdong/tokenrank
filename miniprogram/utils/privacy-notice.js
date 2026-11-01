// Shown every time the mini program is opened, until the user taps “不再提示”.
// Rendered by components/privacy-notice so the repository address can be copied.
const modalQueue = require('./modal-queue');
const KEY = 'privacy_notice_hidden_v2';
const REPO_URL = 'https://github.com/xmasdong/tokenrank';
let due = false, active = false;

function arm() { due = true; }

/** Consumes this launch's notice; only one page component can own its mask. */
function claim(wx) {
  if (!due || active) return false;
  due = false;
  if (wx.getStorageSync(KEY)) return false;
  active = true;
  modalQueue.hold();
  return true;
}

function dismiss(wx, never) {
  if (!active) return;
  active = false;
  due = false;
  try { if (never) wx.setStorageSync(KEY, 1); }
  catch { /* A storage failure must never leave the screen or dialog queue blocked. */ }
  finally { modalQueue.release(); }
}

module.exports = { arm, claim, dismiss, KEY, REPO_URL };
