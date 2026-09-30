const api = require('../../utils/api');

Page({
  data: { state: '', busy: false, confirming: false, error: '', loginNeeded: false },
  onShow() { this.setData({ state: api.accountState() }); },
  confirmDeletion() {
    if (this.data.busy || this.data.confirming || this.data.state === 'deleted') return;
    this.setData({ confirming: true });
    wx.showModal({
      title: '确认注销账号？',
      content: '头像、昵称、全部云端用量和分享记录将永久删除。电脑接入码立即失效，无法恢复。',
      confirmText: '确认注销', confirmColor: '#B03A2E', cancelText: '取消',
      success: res => { if (res.confirm) this.removeAccount(); },
      complete: () => this.setData({ confirming: false }),
    });
  },
  async removeAccount() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', loginNeeded: false });
    try {
      await api.deleteAccount();
      // Destroy every existing tab/page so no old nickname, avatar or usage remains.
      wx.reLaunch({ url: '/pages/account/account', fail: () => this.setData({ state: api.accountState() }) });
    } catch (err) {
      const pending = api.accountState() === 'pending';
      this.setData({ state: api.accountState(), loginNeeded: err.statusCode === 401,
        error: err.statusCode === 401 ? '登录凭证已失效，暂时无法确认注销结果。请重新登录后核对。'
          : pending ? '暂未收到注销结果。请重试确认，期间不会自动登录或恢复账号。' : err.message || '注销失败，请重试' });
    } finally { this.setData({ busy: false }); }
  },
  async loginAgain() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await api.startNewAccount();
      wx.reLaunch({ url: '/pages/profile/profile' });
    } catch (err) { this.setData({ state: api.accountState(), error: api.accountState() === 'deleted' && err.code === 'ACCOUNT_DELETED' ? '' : err.message || '登录失败，请重试' }); }
    finally { this.setData({ busy: false }); }
  },
});
