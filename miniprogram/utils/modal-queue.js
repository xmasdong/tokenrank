// wx.showModal can only show one dialog at a time; queue them so dialogs raised on open don't collide.
// A custom dialog (the privacy notice) can hold the queue while it is on screen.
let busy = false, held = false;
const queue = [];
function pump() {
  if (busy || held || !queue.length) return;
  const [wx, options] = queue.shift();
  busy = true;
  wx.showModal({ ...options, complete: res => {
    busy = false;
    if (options.complete) options.complete(res);
    pump();
  } });
}
function show(wx, options) { queue.push([wx, options]); pump(); }
function hold() { held = true; }
function release() { held = false; pump(); }
// Tests only: fake wx.showModal implementations may never call complete.
function _reset() { busy = false; held = false; queue.length = 0; }
module.exports = { show, hold, release, _reset };
