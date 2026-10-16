const connectPrompt = require('./utils/connect-prompt');
const privacyNotice = require('./utils/privacy-notice');
const updatePrompt = require('./utils/update-prompt');
const api = require('./utils/api');
function publicEntry(options, pages) {
  const page = pages[pages.length - 1], path = options.path || page?.route;
  return path === 'pages/record/record' || path === 'pages/trends/trends' || (path === 'pages/analysis/analysis' &&
    (options.query?.scope || page?.options?.scope || page?.data?.scope) === 'public');
}

App({
  onLaunch() { this.checkUpdate(); },
  onShow(options = {}) {
    if (api.accountState()) {
      if (api.accountState() === 'deleted') api.clearAvatarFiles();
      const pages = getCurrentPages();
      // Viewing someone else's public share does not require a new account.
      if (publicEntry(options, pages)) return;
      if (pages[pages.length - 1]?.route !== 'pages/account/account') wx.reLaunch({ url: '/pages/account/account' });
      return;
    }
    // Public records show the author's content before any onboarding notice.
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (publicEntry(options, pages)) return;
    privacyNotice.arm(); connectPrompt.arm(); updatePrompt.arm();
  },
  // Old cached builds keep running until the next cold start; apply a
  // downloaded release immediately so fixes reach every user.
  checkUpdate() {
    if (!wx.getUpdateManager) return;
    const manager = wx.getUpdateManager();
    manager.onUpdateReady(() => {
      wx.showModal({ title: '新版本已下载', content: '重启后使用新版本', showCancel: false, confirmText: '重启',
        complete: () => manager.applyUpdate() });
    });
  },
});
