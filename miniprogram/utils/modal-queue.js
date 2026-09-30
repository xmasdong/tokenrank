// wx.showModal can only show one dialog at a time; queue them so dialogs raised on open don't collide.
let busy = false;
const queue = [];
function pump() {
  if (busy || !queue.length) return;
  const [wx, options] = queue.shift();
  busy = true;
  wx.showModal({ ...options, complete: res => {
    busy = false;
    if (options.complete) options.complete(res);
    pump();
  } });
}
function show(wx, options) { queue.push([wx, options]); pump(); }
// Tests only: fake wx.showModal implementations may never call complete.
function _reset() { busy = false; queue.length = 0; }
module.exports = { show, _reset };
