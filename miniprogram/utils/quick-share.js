const { shareTitle } = require('./share-story');
const { loadCodeImage } = require('./share-code');
const { drawAchievementPoster } = require('./achievement-poster');

// Freeze the public record ahead of the native share tap. Canvas work is optional:
// a slow avatar or failed export never blocks a valid author's record link.
function quickShare(api, wx) {
  return {
    clearQuickShare() {
      this._quickVersion = (this._quickVersion || 0) + 1;
      this._quickKey = ''; this._quickRecord = null; this._quickTask = null;
      this.setData({ quickShareReady: false, quickSharePreparing: false, quickCoverPath: '', quickShareError: '' });
    },
    prepareQuickShare({ groupId = '', stamp = '' } = {}) {
      const period = this.data.period;
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const key = `${day}:${period}:${groupId}:${stamp}`;
      if (this._quickKey === key && this._quickTask) return this._quickTask;
      this.clearQuickShare();
      this._quickKey = key; this._quickGroup = groupId;
      const version = this._quickVersion;
      const epoch = api.accountEpoch?.();
      this._quickEpoch = epoch;
      const current = () => version === this._quickVersion && (!api.accountEpoch || epoch === api.accountEpoch());
      this.setData({ quickSharePreparing: true });
      const task = (async () => {
        try {
          let record;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { record = await api.createShare(period, 'usage', groupId); break; }
            catch (err) { if (err.statusCode !== 409 || attempt) throw err; }
            if (!current()) return null;
          }
          if (!current()) return null;
          if (!/^[0-9a-f]{24}$/.test(record?.id) || (groupId && !record.usage.group_standing))
            throw new Error('分享记录暂不可用，请重试');
          this._quickRecord = record;
          this.setData({ quickShareReady: true, quickSharePreparing: false });
          this.buildQuickCover();
          this.onQuickShareReady?.(record);
          return record;
        } catch (err) {
          if (current()) { this._quickKey = ''; this.setData({ quickSharePreparing: false, quickShareError: err.message || '分享准备失败，请重试' }); }
          return null;
        }
      })();
      this._quickTask = task;
      return task;
    },
    async buildQuickCover() {
      if (!this._quickRecord) return;
      if (this._quickDrawing) { this._quickDrawPending = true; return; }
      this._quickDrawing = true;
      const version = this._quickVersion, record = this._quickRecord;
      try {
        const canvas = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#quickShareCanvas')
          .fields({ node: true }).exec(res => resolve(res?.[0]?.node)));
        if (!canvas || version !== this._quickVersion) return;
        const { loadAvatarImage } = require('./share-avatar');
        const [codeImage, avatarImage] = await Promise.all([loadCodeImage(canvas), loadAvatarImage(canvas, record.user.avatar_url)]);
        if (version !== this._quickVersion) return;
        canvas.width = 1000; canvas.height = 800;
        drawAchievementPoster(canvas.getContext('2d'), { ...record, cover: true, codeImage, avatarImage });
        const path = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, destWidth: 1000, destHeight: 800,
          fileType: 'png', success: res => resolve(res.tempFilePath), fail: reject }));
        if (version === this._quickVersion) this.setData({ quickCoverPath: path });
      } catch { /* The public record is still shareable with the bundled cover. */ }
      finally {
        this._quickDrawing = false;
        if (this._quickDrawPending) { this._quickDrawPending = false; this.buildQuickCover(); }
      }
    },
    quickShareCard() {
      const record = this._quickRecord;
      return record && !api.accountState?.() && (!api.accountEpoch || this._quickEpoch === api.accountEpoch()) && record.usage.period === this.data.period ? { title: shareTitle(record.user, record.usage), path: '/pages/record/record?id=' + record.id,
        imageUrl: this.data.quickCoverPath || '/assets/share-cover.png' } : null;
    },
    retryQuickShare() { return this.prepareQuickShare({ groupId: this._quickGroup || '' }); },
  };
}
module.exports = { quickShare };
