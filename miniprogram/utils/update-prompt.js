// Tells users whose computer runs an older sync client to update it. The server decides what is
// outdated (sync_health.update_available), so a new client release needs no mini-program change.
// Armed on every App.onShow; shown at most once a day per release until the computer updates.
const modalQueue = require('./modal-queue');
const KEY = 'update_prompt_seen_v1';
const COMMANDS = {
  mac: 'curl -fsSL https://tokenrank.xmasdong.cn/update.sh | sh',
  win: "& ([scriptblock]::Create((irm 'https://tokenrank.xmasdong.cn/update.ps1')))",
};
let due = false;
let showing = false;

function arm() { due = true; }
function today(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function commandFor(platform) { return platform === 'win32' ? COMMANDS.win : COMMANDS.mac; }

function maybePrompt(wx, user, now = Date.now()) {
  const health = user && user.sync_health;
  if (!due || showing || !health || !health.supported || !health.update_available || health.state === 'stopped') return false;
  due = false;
  const seen = `${health.latest_client}:${today(now)}`;
  if (wx.getStorageSync(KEY) === seen) return false;
  wx.setStorageSync(KEY, seen);
  showing = true;
  const win = health.platform === 'win32';
  modalQueue.show(wx, {
    title: '电脑端有新版本',
    content: `你的电脑在用 ${health.client_version}，最新是 ${health.latest_client}。复制更新命令，在电脑${win ? ' PowerShell ' : '终端'}里运行一次就好，会顺带重算本机用量。`,
    confirmText: '复制命令',
    cancelText: '稍后',
    success: res => {
      if (res.confirm) wx.setClipboardData({ data: commandFor(health.platform), success: () => wx.showToast({ title: '已复制，请在电脑上运行', icon: 'none' }) });
    },
    complete: () => { showing = false; },
  });
  return true;
}

// Tests only.
function _reset() { due = false; showing = false; }
module.exports = { arm, maybePrompt, commandFor, COMMANDS, KEY, _reset };
