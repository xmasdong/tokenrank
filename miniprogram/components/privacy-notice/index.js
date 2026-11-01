const notice = require('../../utils/privacy-notice');

Component({
  data: { visible: false, repo: notice.REPO_URL.replace('https://', '') },
  lifetimes: {
    attached() { this.showNotice(); },
    detached() { this.releaseNotice(); },
  },
  pageLifetimes: {
    show() { this.showNotice(); },
    hide() { this.close(); },
  },
  methods: {
    showNotice() {
      if (this._noticeHeld || this._closing || !notice.claim(wx)) return;
      this._noticeHeld = true;
      this.setData({ visible: true });
    },
    copyRepo() {
      wx.setClipboardData({ data: notice.REPO_URL, success: () => wx.showToast({ title: '地址已复制，请在浏览器打开', icon: 'none' }) });
    },
    dismissOnce() { this.close(); },
    dismissForever() { this.close(true); },
    close(e) {
      if (!this._noticeHeld || this._closing) return;
      this._closing = true;
      this._never = e === true || String(e?.currentTarget?.dataset?.never) === '1';
      // Release the next native dialog only after this mask has left the view.
      this.setData({ visible: false }, () => this.releaseNotice());
    },
    releaseNotice() {
      if (!this._noticeHeld) return;
      this._noticeHeld = false;
      this._closing = false;
      const never = this._never === true;
      this._never = false;
      notice.dismiss(wx, never);
    },
    noop() {},
  },
});
