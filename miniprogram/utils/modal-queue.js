// wx.showModal can only show one dialog at a time; queue them so dialogs raised on open don't collide.
// Custom dialogs can hold the queue while they are on screen.
let busy = false, held = false;
const queue = [];
function pump() {
  if (busy || held || !queue.length) return;
  const [wx, options] = queue.shift();
  const { shouldShow, onSkip, ...nativeOptions } = options;
  if (shouldShow && !shouldShow()) { if (onSkip) onSkip(); pump(); return; }
  busy = true;
  let settled = false;
  const complete = res => {
    if (settled) return;
    settled = true;
    busy = false;
    if (options.complete) options.complete(res);
    pump();
  };
  try { wx.showModal({ ...nativeOptions, complete }); }
  catch (error) { complete({ errMsg: error.message || 'showModal:fail' }); }
}
function show(wx, options) { queue.push([wx, options]); pump(); }
function hold() { held = true; }
function release() { held = false; pump(); }
// Tests only: fake wx.showModal implementations may never call complete.
function _reset() { busy = false; held = false; queue.length = 0; }
module.exports = { show, hold, release, _reset };
