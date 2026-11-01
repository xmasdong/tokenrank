const notice = require('../../utils/privacy-notice');
const modalQueue = require('../../utils/modal-queue');

// Use the platform dialog: no custom overlay can intercept its buttons.
Component({
  data: { visible: false },
  lifetimes: {
    attached() { this._detached = false; this.showNotice(); },
    detached() {
      this._detached = true;
      // The native dialog owns its lifetime until complete, even across navigation.
      if (!this._nativeOpen) notice.dismiss(wx, false, this);
    },
  },
  pageLifetimes: {
    show() { this._hidden = false; this.showNotice(); },
    hide() { this._hidden = true; },
  },
  methods: {
    showNotice() {
      if (this._nativeOpen || !notice.claim(wx, this)) return;
      this._nativeOpen = true;
      this.setData({ visible: true });
      let finished = false, never = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this._nativeOpen = false;
        if (!this._detached) this.setData({ visible: false });
        notice.dismiss(wx, never, this);
      };
      try {
        modalQueue.show(wx, {
          title: '关于隐私和开源', content: notice.CONTENT,
          confirmText: '知道了', cancelText: '不再提示', confirmColor: '#07C160',
          success: result => { never = result.cancel === true; },
          complete: finish,
          shouldShow: () => !this._detached && !this._hidden,
          onSkip: finish,
        });
      } catch { finish(); }
    },
  },
});
