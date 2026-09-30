// Reminds members who joined a group board but never connected a computer.
// Armed on every App.onShow (cold start or back from background) and shown at most once per show.
const modalQueue = require('./modal-queue');
let due = false;
let showing = false;

function arm() { due = true; }

/** conditions: { user, hasReported, joined } — joined means at least one group board. */
function maybePrompt(wx, { user, hasReported, joined }, goConnect) {
  if (!due || showing || !user || hasReported || !joined) return false;
  due = false;
  showing = true;
  modalQueue.show(wx, {
    title: '还没有接入电脑',
    content: '群榜里还没有你的用量。在电脑上运行一次接入命令，用量会自动同步。',
    confirmText: '去接入',
    cancelText: '稍后',
    success: res => { if (res.confirm) goConnect(); },
    complete: () => { showing = false; },
  });
  return true;
}

// Tests only.
function _reset() { due = false; showing = false; }
module.exports = { arm, maybePrompt, _reset };
