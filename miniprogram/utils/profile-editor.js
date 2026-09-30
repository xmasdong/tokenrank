// Shared native WeChat avatar/nickname form. Dependencies are injected for page tests.
function profileEditor(api, wx, { requireAvatar = false, onSaved } = {}) {
  return {
  checkNicknamePrivacy() {
    const avatarNative = !wx.canIUse || wx.canIUse('button.open-type.chooseAvatar');
    if (avatarNative !== this.data.avatarNative) this.setData({ avatarNative });
    if (!wx.getPrivacySetting) { this.setData({ nicknameReady: true }); return; }
    const check = this._privacyCheck = (this._privacyCheck || 0) + 1;
    wx.getPrivacySetting({ success: res => {
      if (!this._unloaded && check === this._privacyCheck) this.setData({ nicknameReady: !res.needAuthorization });
    }, fail: () => {} });
  },
  enableNickname() { this.requestPrivacy({ nicknameFocus: true }); },
  // One consent covers both the avatar button and the nickname input.
  requestPrivacy(extra, after) {
    if (this.data.saving || this.data.privacyBusy) return;
    if (!wx.requirePrivacyAuthorize) { this.setData({ nicknameReady: true, ...extra }); if (after) after.call(this); return; }
    this._privacyCheck = (this._privacyCheck || 0) + 1;
    this.setData({ privacyBusy: true });
    // No custom consent handler: WeChat displays its official privacy dialog.
    wx.requirePrivacyAuthorize({ success: () => {
      this._privacyCheck = (this._privacyCheck || 0) + 1;
      if (this._unloaded) return;
      this.setData({ nicknameReady: true, ...extra });
      if (after) after.call(this);
    }, fail: err => {
      if (!this._unloaded && ![103, 104].includes(err.errno) && !/deny|denied|cancel|disagree/i.test(err.errMsg || '')) {
        wx.showToast({ title: '微信授权暂时无法启用，请稍后重试', icon: 'none' });
      }
    }, complete: () => { if (!this._unloaded) this.setData({ privacyBusy: false }); } });
  },
  onNicknameInput(e) { this._dirty = true; this.setData({ nickname: e.detail.value }); },
  // Native chooseAvatar only runs after privacy consent; otherwise the tap
  // requests consent first. Clients without chooseAvatar fall back to the album.
  onAvatarTap() {
    if (this.data.saving || !this.data.user) return;
    if (!this.data.nicknameReady) {
      this.requestPrivacy({}, () => {
        if (this.data.avatarNative === false) this.pickAvatarFromAlbum();
        else wx.showToast({ title: '已授权，请再点一次头像', icon: 'none' });
      });
    } else if (this.data.avatarNative === false) this.pickAvatarFromAlbum();
  },
  pickAvatarFromAlbum() {
    if (!wx.chooseMedia) { wx.showToast({ title: '当前微信版本不支持选择头像，请升级微信', icon: 'none' }); return; }
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: res => this.onChooseAvatar({ detail: { avatarUrl: res.tempFiles?.[0]?.tempFilePath } }),
      fail: err => this.reportAvatarError(err) });
  },
  reportAvatarError(err) {
    const msg = (err && err.errMsg) || '';
    if (this._unloaded || !msg || /cancel/i.test(msg)) return;
    wx.showToast({ title: /privacy|scope/i.test(msg) ? '头像权限未生效，请重启小程序后重试' : '头像选择失败，请重试', icon: 'none' });
  },
  onChooseAvatar(e) {
    const path = e.detail && e.detail.avatarUrl;
    if (!path) { if (e.detail && e.detail.errMsg) this.reportAvatarError(e.detail); return; }
    if (this.data.saving) return;
    this.setData({ avatarDraft: path, avatarUrl: path });
  },
  async save(e) {
    if (this.data.saving) return;
    // Only the authorized branch mounts a native input. Preserve the current
    // nickname for avatar-only edits; never restore input cleared by WeChat.
    const nickname = String(e?.detail?.value?.nickname ?? (this.data.nicknameReady ? '' : this.data.nickname)).trim();
    this._dirty = true;
    this.setData({ nickname, profileError: '' });
    if (!nickname || [...nickname].length > 16) {
      this.setData({ profileError: '昵称请填写 1–16 个字' });
      wx.showToast({ title: '昵称请填写 1–16 个字', icon: 'none' }); return;
    }
    if (requireAvatar && !this.data.avatarDraft && !this.data.user?.avatar_url) {
      this.setData({ profileError: '请选择微信头像后继续' });
      wx.showToast({ title: '请选择微信头像', icon: 'none' }); return;
    }
    this._profileRevision = (this._profileRevision || 0) + 1;
    this.setData({ saving: true });
    try {
      const user = this.data.avatarDraft ? await api.uploadProfile(nickname, this.data.avatarDraft) : await api.setProfile(nickname);
      if (this._unloaded) return;
      if (requireAvatar && (!user.nickname?.trim() || !user.avatar_url)) throw new Error('资料尚未保存完整，请重试');
      this._profileRevision++;
      this._dirty = false;
      this.setData({ user, nickname: user.nickname || nickname, avatarDraft: '', avatarUrl: user.avatar_url || '' });
      if (onSaved) await onSaved.call(this, user);
      else wx.showToast({ title: '资料已保存', icon: 'success' });
    } catch (err) { if (!this._unloaded) { this.setData({ profileError: err.message }); wx.showToast({ title: err.message, icon: 'none' }); } }
    finally { if (!this._unloaded) this.setData({ saving: false }); }
  },
  };
}
module.exports = { profileEditor };
