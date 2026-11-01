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
      if (this._noticeHeld || this._closing || !notice.claim(wx, this)) return;
      this._noticeHeld = true;
      this.setData({ visible: true });
    },
    copyRepo() {
      wx.setClipboardData({ data: notice.REPO_URL, success: () => wx.showToast({ title: '地址已复制，请在浏览器打开', icon: 'none' }) });
    },
    dismissOnce() { this.close(); },
    dismissForever() { this.close(true); },
    close(e) {
      // A restored view may still be visible after its instance flags were reset.
      // Always let that view close, without releasing another component's dialog.
      if (this._closing || (!this._noticeHeld && !this.data.visible)) return;
      this._closing = true;
      this._never = e === true || String(e?.currentTarget?.dataset?.never) === '1';
      // Release the next native dialog only after this mask has left the view.
      this.setData({ visible: false }, () => this.releaseNotice());
    },
    releaseNotice() {
      this._noticeHeld = false;
      this._closing = false;
      const never = this._never === true;
      this._never = false;
      notice.dismiss(wx, never, this);
    },
    noop() {},
  },
});
