const api = require('../../utils/api');
const { normalizeEmail } = require('../../utils/email');
Page({
  data: { loading: true, error: '', notice: '', status: null, editing: false, email: '', consent: false, busy: false },
  onShow() {
    this._visible = true;
    const epoch = api.accountEpoch();
    if (this._accountEpoch !== undefined && this._accountEpoch !== epoch) {
      this.setData({ status: null, email: '', consent: false, editing: false, busy: false, notice: '', error: '' });
    }
    this._accountEpoch = epoch;
    return this.load();
  },
  onHide() { this._visible = false; this._request = (this._request || 0) + 1; },
  onUnload() { this.onHide(); },
  current(epoch) { return this._visible && epoch === api.accountEpoch() && !api.accountState(); },
  showStatus(status) {
    this.setData({ status, loading: false, error: '', editing: false, email: '', consent: false });
  },
  async load(options = {}) {
    if (this.data.busy) return;
    const epoch = api.accountEpoch(), request = this._request = (this._request || 0) + 1;
    if (api.accountState()) { wx.navigateTo({ url: '/pages/account/account' }); return; }
    const cached = options.force ? null : api.peekEmailRegistration();
    if (cached) {
      if (!this.data.editing) this.showStatus(cached);
      return;
    }
    this.setData({ loading: !this.data.status, error: '' });
    try {
      await api.ensureSession();
      if (!this.current(epoch) || request !== this._request) return;
      const status = await api.emailRegistration(options);
      if (this.current(epoch) && request === this._request) this.showStatus(status);
    } catch (error) { if (this.current(epoch) && request === this._request) this.setData({ loading: false, error: error.message || '暂时无法读取邮箱登记' }); }
  },
  async onPullDownRefresh() { try { await this.load({ force: true }); } finally { wx.stopPullDownRefresh(); } },
  inputEmail(e) { if (!this.data.busy) this.setData({ email: e.detail.value, error: '', notice: '' }); },
  changeConsent(e) { if (!this.data.busy) this.setData({ consent: e.detail.value.includes('email'), error: '', notice: '' }); },
  editEmail() { if (!this.data.busy && this.data.status?.registered) this.setData({ editing: true, email: this.data.status.email, consent: false, error: '', notice: '' }); },
  cancelEdit() { if (!this.data.busy) this.setData({ editing: false, email: '', consent: false, error: '', notice: '' }); },
  async save() {
    const epoch = api.accountEpoch(), status = this.data.status;
    if (!this.current(epoch) || this._accountEpoch !== epoch || this.data.busy || this.data.loading || !status) return;
    const email = normalizeEmail(this.data.email);
    if (!email) { this.setData({ error: '请填写有效的邮箱地址' }); return; }
    if (!this.data.consent) { this.setData({ error: '请先同意邮箱登记说明' }); return; }
    this._request = (this._request || 0) + 1;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const result = await api.saveEmailRegistration({ email, consent: true, consent_version: status.consent_version, expected_revision: status.revision });
      if (this.current(epoch)) { this.showStatus(result); this.setData({ notice: '邮箱已登记，推送尚未开放。' }); }
    } catch (error) {
      if (this.current(epoch)) {
        if (error.code === 'EMAIL_REGISTRATION_CHANGED') {
          this.setData({ busy: false }); await this.load({ force: true });
        }
        if (this.current(epoch)) this.setData({ error: error.message || '登记尚未确认，请重试' });
      }
    } finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
  },
  remove() {
    const epoch = api.accountEpoch(), revision = this.data.status?.revision;
    if (!this.current(epoch) || this._accountEpoch !== epoch || this.data.busy || !this.data.status?.registered) return;
    wx.showModal({ title: '撤销邮箱登记', content: '将删除已填写的邮箱，不影响用量和微信提醒。', confirmText: '撤销登记', confirmColor: '#FA5151',
      success: async result => {
        if (!result.confirm || !this.current(epoch) || this.data.busy || this.data.status?.revision !== revision) return;
        this._request = (this._request || 0) + 1;
        this.setData({ busy: true, error: '', notice: '' });
        try {
          const status = await api.removeEmailRegistration(revision);
          if (this.current(epoch)) { this.showStatus(status); this.setData({ notice: '邮箱登记已撤销。' }); }
        } catch (error) {
          if (this.current(epoch)) {
            if (error.code === 'EMAIL_REGISTRATION_CHANGED') { this.setData({ busy: false }); await this.load({ force: true }); }
            if (this.current(epoch)) this.setData({ error: error.message || '撤销尚未确认，请重试' });
          }
        } finally { if (epoch === api.accountEpoch()) this.setData({ busy: false }); }
      },
    });
  },
});
