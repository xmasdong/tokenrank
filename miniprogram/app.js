const connectPrompt = require('./utils/connect-prompt');

App({
  onLaunch() { this.checkUpdate(); },
  onShow() { connectPrompt.arm(); },
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
