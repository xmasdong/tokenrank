const notice = require('../../utils/privacy-notice');

Component({
  data: { visible: false, repo: notice.REPO_URL.replace('https://', '') },
  // claim() is once per launch, so calling it from both hooks is safe.
  lifetimes: {
    attached() { if (notice.claim(wx)) this.setData({ visible: true }); },
    detached() { if (this.data.visible) notice.dismiss(wx, false); },
  },
  pageLifetimes: {
    show() { if (notice.claim(wx)) this.setData({ visible: true }); },
  },
  methods: {
    copyRepo() {
      wx.setClipboardData({ data: notice.REPO_URL, success: () => wx.showToast({ title: '地址已复制，请在浏览器打开', icon: 'none' }) });
    },
    close(e) {
      const never = e.currentTarget.dataset.never === '1';
      this.setData({ visible: false });
      notice.dismiss(wx, never);
    },
    noop() {},
  },
});
