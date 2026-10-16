const { loadCodeImage } = require('./share-code');
const { SOCIAL_HEIGHT, drawToolsPoster, drawComparisonPoster, drawWeeklyPoster } = require('./social-poster');
function socialImages(wx, api) {
  return {
    resetSocialImages() {
      this._socialVersion = (this._socialVersion || 0) + 1; this._socialRecord = null;
      this.setData({ socialCoverPath: '', socialPosterPath: '', socialImageError: '' });
    },
    async buildSocialImages() {
      const record = this._socialRecord;
      if (!record || !this._socialCanvasReady || !this._socialVisible) return;
      if (this._socialDrawing) { this._socialPending = true; return; }
      this._socialDrawing = true;
      const version = this._socialVersion, epoch = api.accountEpoch();
      const current = () => this._socialVisible && version === this._socialVersion && epoch === api.accountEpoch();
      try {
        const canvas = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#socialCanvas')
          .fields({ node: true }).exec(res => resolve(res?.[0]?.node)));
        if (!canvas || !current()) return;
        const { loadAvatarImage } = require('./share-avatar');
        const urls = [...new Set([record.user.avatar_url, record.comparison?.source.user.avatar_url].filter(Boolean))];
        const [codeImage, images] = await Promise.all([loadCodeImage(canvas), Promise.all(urls.map(url => loadAvatarImage(canvas, url)))]);
        if (!current()) return;
        const avatarImages = Object.fromEntries(urls.map((url, i) => [url, images[i]]));
        for (const cover of [true, false]) {
          if (!cover && this._socialCoverOnly) break;
          canvas.width = 1000; canvas.height = cover ? 800 : SOCIAL_HEIGHT;
          const options = { ...record, cover, codeImage, avatarImages, avatarImage: avatarImages[record.user.avatar_url] };
          (record.style === 'comparison' ? drawComparisonPoster : record.style === 'weekly' ? drawWeeklyPoster : drawToolsPoster)(canvas.getContext('2d'), options);
          const file = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, destWidth: 1000, destHeight: canvas.height,
            fileType: 'png', success: res => resolve(res.tempFilePath), fail: reject }));
          if (!current()) return;
          this.setData(cover ? { socialCoverPath: file } : { socialPosterPath: file });
        }
      } catch { if (current()) this.setData({ socialImageError: '图片生成失败，可重试或直接转发' }); }
      finally { this._socialDrawing = false; if (this._socialPending) { this._socialPending = false; this.buildSocialImages(); } }
    },
  };
}
module.exports = { socialImages };
