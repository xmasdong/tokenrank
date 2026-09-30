const api = require('../../utils/api');
const usage = require('../../utils/usage');
const { drawUsagePoster } = require('../../utils/usage-poster');
const { loadCodeImage } = require('../../utils/share-code');
const { loadAvatarImage } = require('../../utils/share-avatar');
const { shareTitle } = require('../../utils/share-story');
Page({
  data: { period: 'day', theme: 'paper', loading: true, error: '', generating: false,
    shareId: '', revoking: false, imageError: '', posterPath: '', coverPath: '', saving: false, periodLabel: '今日', basisLabel: '总用量 · 含缓存', hasHistory: false },
  onLoad(options) {
    wx.hideShareMenu();
    const period = usage.PERIODS.some(p => p.key === options.period) ? options.period : 'day';
    const theme = wx.getStorageSync('usage_card_theme') === 'ink' ? 'ink' : 'paper';
    this.setData({ period, theme, periodLabel: usage.PERIODS.find(p => p.key === period).label });
  },
  onShow() {
    this._visible = true;
    if (this._revoked) return;
    if (!this._snapshot) return this.load();
    if (!this.data.posterPath) return this.buildImages();
  },
  onReady() { this._canvasReady = true; return this.buildImages(); },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this._imageVersion = (this._imageVersion || 0) + 1; },
  onUnload() { this.onHide(); },
  async load() {
    this._revoked = false;
    const requestId = this._requestId = (this._requestId || 0) + 1;
    this._imageVersion = (this._imageVersion || 0) + 1;
    this._snapshot = null;
    wx.hideShareMenu();
    this.setData({ loading: true, error: '', shareId: '', hasHistory: false, posterPath: '', coverPath: '', imageError: '' });
    try {
      await api.ensureLogin();
      const result = await api.myUsage(this.data.period);
      if (requestId !== this._requestId) return;
      if (!result.has_history) { this.setData({ loading: false, hasHistory: false }); return; }
      const record = await api.createShare(this.data.period);
      if (requestId !== this._requestId) return;
      this._snapshot = { user: record.user, usage: record.usage };
      this.setData({ loading: false, hasHistory: true, shareId: record.id, basisLabel: usage.usageBasis(record.usage).basisLabel });
      return this.buildImages();
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message });
    }
  },
  switchTheme(e) {
    const theme = e.currentTarget.dataset.theme;
    if (!['paper', 'ink'].includes(theme) || theme === this.data.theme) return;
    wx.setStorageSync('usage_card_theme', theme);
    wx.hideShareMenu();
    this.setData({ theme, posterPath: '', coverPath: '' });
    this._imageVersion = (this._imageVersion || 0) + 1;
    return this.buildImages();
  },
  async buildImages() {
    if (!this._canvasReady || !this._snapshot || !this._visible) return;
    if (this._drawing) { this._drawPending = true; return; }
    this._drawing = true;
    const version = this._imageVersion;
    const snapshot = this._snapshot, theme = this.data.theme;
    this.setData({ generating: true, imageError: '' });
    try {
      const canvas = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#usageCanvas')
        .fields({ node: true }).exec(res => resolve(res && res[0] && res[0].node)));
      if (!canvas) throw new Error('画布暂未就绪，请重试');
      if (version !== this._imageVersion) return;
      const [codeImage, avatarImage] = await Promise.all([loadCodeImage(canvas), loadAvatarImage(canvas, snapshot.user.avatar_url)]);
      if (version !== this._imageVersion) return;
      const exportImage = (height, cover) => {
        canvas.width = 1000; canvas.height = height;
        drawUsagePoster(canvas.getContext('2d'), { ...snapshot, theme, cover, codeImage, avatarImage });
        return new Promise((resolve, reject) => wx.canvasToTempFilePath({
          canvas, destWidth: 1000, destHeight: height, fileType: 'png',
          success: r => resolve(r.tempFilePath), fail: () => reject(new Error('图片生成失败，请重试')),
        }));
      };
      const posterPath = await exportImage(1400, false);
      if (version !== this._imageVersion) return;
      const coverPath = await exportImage(800, true);
      if (version === this._imageVersion) {
        this.setData({ posterPath, coverPath });
        wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true });
      }
    } catch (err) {
      if (version === this._imageVersion) this.setData({ imageError: err.message });
    } finally {
      this._drawing = false;
      this.setData({ generating: false });
      if (this._drawPending) { this._drawPending = false; if (this._visible) this.buildImages(); }
    }
  },
  preview() { if (this.data.posterPath) wx.previewImage({ urls: [this.data.posterPath] }); },
  previewRecord() {
    if (this.data.shareId && !this.data.revoking) wx.navigateTo({ url: '/pages/record/record?id=' + this.data.shareId });
  },
  savePoster() {
    if (!this.data.posterPath || this.data.generating || this.data.saving) return;
    this.setData({ saving: true });
    wx.saveImageToPhotosAlbum({
      filePath: this.data.posterPath,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: err => {
        if (/cancel/i.test(err.errMsg || '')) return;
        wx.getSetting({ success: res => {
          if (res.authSetting['scope.writePhotosAlbum'] === false) {
            wx.showModal({ title: '允许保存到相册', content: '需要相册权限才能保存图片。', confirmText: '去设置',
              success: result => { if (result.confirm) wx.openSetting({}); } });
          } else wx.showToast({ title: '保存失败，请重试或长按预览图保存', icon: 'none' });
        }, fail: () => wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' }) });
      },
      complete: () => this.setData({ saving: false }),
    });
  },
  goConnect() { wx.navigateTo({ url: '/pages/connect/connect' }); },
  revoke() {
    if (!this.data.shareId || this.data.revoking) return;
    wx.showModal({ title: '关闭这张卡片的链接？', content: '已发出的图片不受影响，卡片链接将无法打开。',
      success: async r => {
        if (!r.confirm) return;
        this.setData({ revoking: true });
        try {
          await api.revokeShare(this.data.shareId); this._imageVersion = (this._imageVersion || 0) + 1;
          this._snapshot = null; this._revoked = true; wx.hideShareMenu();
          this.setData({ shareId: '', posterPath: '', coverPath: '', error: '这张卡片的链接已关闭。' });
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
        finally { this.setData({ revoking: false }); }
      } });
  },
  onShareAppMessage() {
    const snapshot = this._snapshot;
    return { title: snapshot ? shareTitle(snapshot.user, snapshot.usage) : 'Token 用量统计',
      path: this.data.shareId ? '/pages/record/record?id=' + this.data.shareId : '/pages/index/index',
      imageUrl: this.data.coverPath || '/assets/share-cover.png' };
  },
});
