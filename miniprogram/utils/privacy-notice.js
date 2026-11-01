// Shown every time the mini program is opened, until the user taps “不再提示”.
// Presented by components/privacy-notice through the native wx.showModal API.
const KEY = 'privacy_notice_hidden_v2';
const REPO_URL = 'https://github.com/xmasdong/tokenrank';
const CONTENT = '上传每日用量、工具、模型、估算金额，以及同步程序的运行状态与版本。不会收集上传代码、对话、项目名和文件路径。\n\n参与排名后，头像昵称、用量及工具／模型偏好会公开，可在「我的」关闭排名。邮箱仅用于主动登记完整日报，不公开，可随时撤销。\n\n项目全部开源：\ngithub.com/xmasdong/tokenrank\n完整说明及地址复制见「使用说明」。';
let due = false, active = false, activeOwner = null;

function arm() { due = true; }

/** Consumes this launch's notice; only one page component can own its mask. */
function claim(wx, owner = null) {
  if (!due || active) return false;
  due = false;
  if (wx.getStorageSync(KEY)) return false;
  active = true;
  activeOwner = owner;
  return true;
}

function dismiss(wx, never, owner = null) {
  if (!active || activeOwner !== owner) return;
  active = false;
  activeOwner = null;
  due = false;
  try { if (never) wx.setStorageSync(KEY, 1); }
  catch { /* A storage failure must never leave the screen or dialog queue blocked. */ }
}

module.exports = { arm, claim, dismiss, KEY, REPO_URL, CONTENT };
