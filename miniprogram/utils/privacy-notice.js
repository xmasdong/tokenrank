// Shown every time the mini program is opened, until the user taps “下次不提示”.
const modalQueue = require('./modal-queue');
const KEY = 'privacy_notice_hidden_v1';
const REPO = 'github.com/xmasdong/tokenrank';
let due = false;

function arm() { due = true; }

function maybeShow(wx) {
  if (!due) return false;
  due = false;
  if (wx.getStorageSync(KEY)) return false;
  modalQueue.show(wx, {
    title: '关于隐私和开源',
    content: `只上传每天的用量数字，和用了哪些工具、模型。代码、对话、项目名和文件路径都不会收集上传。\n小程序、服务端和电脑端程序全部开源：${REPO}\n不想上榜，可以在「我的」里关掉排名。`,
    confirmText: '知道了',
    cancelText: '不再提示',
    success: res => { if (res.cancel) wx.setStorageSync(KEY, 1); },
  });
  return true;
}

module.exports = { arm, maybeShow, KEY };
