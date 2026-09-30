const api = require('../../utils/api');
const flow = require('../../utils/flow');
const connectPrompt = require('../../utils/connect-prompt');
const { loadCodeImage } = require('../../utils/share-code');
const { drawGroupPoster } = require('../../utils/group-poster');
const { profileEditor } = require('../../utils/profile-editor');

Page({
  ...profileEditor(api, wx, { requireAvatar: true, onSaved(user) {
    this._continueProfile = true;
    if (this._visible) return this.continueProfile(user);
  } }),
  data: { periods: flow.PERIODS, period: 'day', id: '', name: '', joined: null,
    user: null, members: 0, entries: [], me: null, loading: true, error: '', missing: false,
    total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '',
    nickname: '', avatarUrl: '', avatarDraft: '', saving: false, profileError: '',
    nicknameReady: false, nicknameFocus: false, privacyBusy: false, avatarNative: true, sourceName: '', draftName: '', named: true, canRename: false, myHidden: false, visibilitySaving: false,
    enterState: 'idle', enterError: '', joining: false, groupExists: false, owner_id: null, posterPath: '', shareCardPath: '', posterError: '',
    connState: 'pending', connText: '', hasReported: false, updated_fmt: '' },
  onLoad(options) {
    const id = options.g || options.id || '';
    // 从已加入的群列表或接入页返回时保留群上下文；卡片进入必须识别当前真实微信群。
    this._needsResolve = !['mine', 'connect'].includes(options.from) || !id;
    const missing = !id && options.enter !== '1' && options.create !== '1';
    this.setData({ id, missing, sourceName: flow.sourceName(options), enterState: this._needsResolve ? 'idle' : 'ready' });
  },
  onShow() {
    wx.showShareMenu({ menus: ['shareAppMessage'], withShareTicket: true });
    this._visible = true;
    this._unloaded = false;
    if (this.data.missing) return;
    if (this.data.enterState === 'profile') {
      this.checkNicknamePrivacy();
      if (this._continueProfile && flow.hasProfile(this.data.user)) return this.continueProfile(this.data.user);
      return;
    }
    return this._needsResolve ? this.tryEnterGroup() : this.init();
  },
  onHide() {
    this._visible = false;
    this._enterRequest = (this._enterRequest || 0) + 1;
    this._entering = false;
    this.setData({ joining: false, loadingMore: false, nicknameFocus: false });
    this._requestId = (this._requestId || 0) + 1;
    this._posterVersion = (this._posterVersion || 0) + 1;
  },
  onUnload() { this._unloaded = true; this._privacyCheck = (this._privacyCheck || 0) + 1; this.onHide(); },
  onReachBottom() { if (!this.data.moreError) return this.loadMore(); },
  async onPullDownRefresh() {
    if (this.data.enterState === 'profile') { wx.stopPullDownRefresh(); return; }
    try { await (this._needsResolve ? this.tryEnterGroup() : this.init({ force: true })); }
    finally { wx.stopPullDownRefresh(); }
  },
  async tryEnterGroup() {
    if (this._entering) return;
    this._entering = true;
    const attempt = this._enterRequest = (this._enterRequest || 0) + 1;
    const current = () => this._visible && attempt === this._enterRequest;
    this._groupRef = '';
    if (flow.enteredFromPrivateChat()) { this._entering = false; this.setData({ enterState: 'private', missing: false, loading: false }); return; }
    this.setData({ enterState: 'resolving', enterError: '', missing: false });
    try {
      const group = await flow.resolveCurrentGroup({}, current);
      if (!current()) return;
      if (!group.joined) {
        if (!group.group_ref) throw new Error('暂时未能识别本群，请重试。');
        this._groupRef = group.group_ref;
        this.setData({ id: group.id || '', name: group.name, members: group.members || 0, joined: false,
          groupExists: !!group.exists, enterState: 'confirm', loading: false });
        return;
      }
      if (!group.id) throw new Error('暂时未能找到本群榜单，请重试。');
      this._needsResolve = false;
      this.setData({ id: group.id, name: group.name, joined: true, enterState: 'ready', enterError: '' });
      await this.init({ joined: true });
    } catch (err) {
      if (current()) this.setData({ enterState: 'failed', enterError: err.message, loading: false });
    } finally { if (attempt === this._enterRequest) this._entering = false; }
  },
  async confirmJoin() {
    if (this._entering || this.data.joining || this.data.enterState !== 'confirm' || !this._groupRef) return;
    this._entering = true;
    const attempt = this._enterRequest = (this._enterRequest || 0) + 1;
    const current = () => this._visible && attempt === this._enterRequest;
    this.setData({ joining: true, enterError: '' });
    try {
      const user = await api.ensureLogin();
      if (!current()) return;
      if (!flow.hasProfile(user)) { this.beginProfile(user, 'join'); return; }
      const draft = this.data.groupExists ? '' : this.data.draftName.trim();
      if ([...draft].length > 100) { wx.showToast({ title: '群名最多 100 个字', icon: 'none' }); return; }
      const group = await flow.resolveCurrentGroup({ confirm: true, expected_group_ref: this._groupRef, ...(draft ? { name: draft } : {}) }, current);
      if (!current()) return;
      if (!group.id || !group.joined) throw new Error('加入未完成，请重新识别当前微信群');
      this._needsResolve = false;
      this.setData({ id: group.id, name: group.name, joined: true, enterState: 'ready', joining: false });
      await this.init({ joined: true });
    } catch (err) {
      if (current() && err.statusCode === 428) {
        const user = await api.ensureLogin({ force: true }).catch(() => null);
        if (user && current()) { this.beginProfile(user, 'join'); return; }
      }
      // A rejected group name keeps the user on the confirm step to edit it.
      if (current() && err.statusCode === 400 && /群名不可用/.test(err.message || '')) { wx.showToast({ title: err.message, icon: 'none' }); return; }
      if (current()) this.setData({ enterState: 'failed', enterError: err.message, loading: false });
    } finally {
      if (attempt === this._enterRequest) { this._entering = false; this.setData({ joining: false }); }
    }
  },
  cancelJoin() {
    if (this.data.joining) return;
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 });
    else this.goHome();
  },
  beginProfile(user, mode) {
    this._profileMode = mode;
    this._requestId = (this._requestId || 0) + 1;
    this._boardSnapshot = null;
    this._posterVersion = (this._posterVersion || 0) + 1;
    this.setData({ enterState: 'profile', user, loading: false, joining: false,
      nickname: this._dirty ? this.data.nickname : user.nickname || '',
      avatarUrl: this.data.avatarDraft || user.avatar_url || '',
      entries: [], me: null, total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '',
      posterPath: '', shareCardPath: '', profileError: '' });
    this.checkNicknamePrivacy();
  },
  async continueProfile(user) {
    if (!flow.hasProfile(user) || !this._visible || this._unloaded) return;
    this._continueProfile = false;
    if (this._profileMode === 'join') {
      this.setData({ enterState: 'confirm' });
      return this.confirmJoin();
    }
    this.setData({ enterState: 'ready' });
    return this.init({ force: true });
  },
  showInfo(user, info) {
    const owner = !!user && info.owner_id === user.user_id;
    this.setData({ user, name: info.name, members: info.members, joined: info.joined,
      owner_id: info.owner_id, myHidden: !!info.my_hidden, named: info.named !== false, canRename: info.can_rename ?? owner, ...flow.connection(user) });
  },
  showBoard(lb) {
    const changed = this._boardSnapshot !== lb;
    this._boardSnapshot = lb;
    if (changed) {
      this._posterVersion = (this._posterVersion || 0) + 1;
      this.setData({ posterPath: '', shareCardPath: '', posterError: '',
        entries: lb.entries.map(e => ({ ...e, tokens_fmt: api.fmtTokens(e.tokens), rk: api.cnRank(e.rank), initial: api.initialOf(e.nickname) })),
        total: lb.total ?? null, hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null,
        snapshot: lb.snapshot || '', loadingMore: false, moreError: '' });
    }
    this.setData({
      members: lb.members ?? this.data.members,
      me: lb.me ? { ...lb.me, tokens_fmt: api.fmtTokens(lb.me.tokens), rk: api.cnRank(lb.me.rank),
        global_rank_label: lb.me.global_rank ? api.cnRank(lb.me.global_rank).label : '' } : null,
      updated_fmt: api.fmtRelTime(lb.updated_at), loading: false, error: '',
    });
    if (changed || !this.data.posterPath) this.buildPoster();
    this.promptConnect();
  },
  promptConnect() {
    if (!this._visible || this.data.enterState !== 'ready') return;
    const { user, hasReported, joined } = this.data;
    connectPrompt.maybePrompt(wx, { user, hasReported, joined: joined === true }, () => this.goConnect());
  },
  async init(options = {}) {
    if (!this.data.id) return;
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const period = this.data.period;
    const cachedUser = options.force === true ? null : api.peekMe();
    const cachedInfo = options.force === true ? null : api.peekGroup(this.data.id);
    const cachedBoard = options.force === true ? null : api.peekLeaderboard({ scope: 'group', id: this.data.id, period });
    if (cachedUser && cachedInfo && cachedBoard && cachedInfo.joined) {
      this.showInfo(cachedUser, cachedInfo);
      if (!flow.hasProfile(cachedUser)) { this.beginProfile(cachedUser, 'member'); return; }
      this.showBoard(cachedBoard);
      return;
    }
    this._posterVersion = (this._posterVersion || 0) + 1;
    this._boardSnapshot = null;
    this.setData({ loading: true, error: '', me: null, posterPath: '', shareCardPath: '',
      entries: [], total: null, hasMore: false, nextOffset: null, snapshot: '', loadingMore: false, moreError: '' });
    try {
      await api.ensureSession();
      if (requestId !== this._requestId) return;
      // Membership already confirmed by the card entry: load the board alongside user and group info.
      const board = options.joined === true ? api.fetchLeaderboard({ scope: 'group', id: this.data.id, period }, options) : null;
      board?.catch(() => {});
      const [user, info] = await Promise.all([api.ensureLogin(options), api.groupInfo(this.data.id, options)]);
      if (requestId !== this._requestId) return;
      this.showInfo(user, info);
      if (!info.joined) { this.setData({ loading: false, entries: [] }); return; }
      if (!flow.hasProfile(user)) { this.beginProfile(user, 'member'); return; }
      const lb = await (board || api.fetchLeaderboard({ scope: 'group', id: this.data.id, period }, options));
      if (requestId !== this._requestId) return;
      this.showBoard(lb);
    } catch (err) {
      if (requestId === this._requestId && err.statusCode === 428) {
        const user = await api.ensureLogin({ force: true }).catch(() => null);
        if (user && requestId === this._requestId) { this.beginProfile(user, 'member'); return; }
      }
      if (requestId === this._requestId) this.setData({ loading: false, error: err.message });
    }
  },
  async loadMore() {
    if (!this._visible || this.data.enterState !== 'ready' || this.data.joined !== true || this.data.loading || this.data.loadingMore ||
      !this.data.hasMore || !this.data.snapshot) return;
    const requestId = this._requestId;
    const { id, period, snapshot, nextOffset } = this.data;
    const current = () => this._visible && requestId === this._requestId;
    this.setData({ loadingMore: true, moreError: '' });
    try {
      // Always validate continuation against current server data, even within
      // the first-page cache TTL. A changed ranking must start over.
      const lb = await api.fetchLeaderboard({ scope: 'group', id, period, offset: nextOffset, snapshot }, { force: true });
      if (!current()) return;
      if (lb.snapshot !== snapshot) { const err = new Error('榜单已有更新'); err.statusCode = 409; throw err; }
      this.setData({ entries: this.data.entries.concat(lb.entries.map(e => ({ ...e,
        tokens_fmt: api.fmtTokens(e.tokens), rk: api.cnRank(e.rank), initial: api.initialOf(e.nickname) }))),
        total: lb.total, hasMore: !!lb.has_more, nextOffset: lb.next_offset ?? null, loadingMore: false });
    } catch (err) {
      if (!current()) return;
      if (err.statusCode === 428) {
        const user = await api.ensureLogin({ force: true }).catch(() => null);
        if (user && current()) { this.beginProfile(user, 'member'); return; }
        if (current()) this.setData({ moreError: err.message, loadingMore: false });
      } else if (err.statusCode === 409) {
        await this.init({ force: true });
        if (this._visible && this.data.id === id && this.data.period === period && !this.data.error)
          wx.showToast({ title: '榜单有更新，已刷新', icon: 'none' });
      } else this.setData({ moreError: err.message || '加载失败，请重试', loadingMore: false });
    } finally { if (current()) this.setData({ loadingMore: false }); }
  },
  load() { return this.init({ force: true }); },
  async toggleGroupVisibility(e) {
    const hidden = !e.detail.value, id = this.data.id;
    this.setData({ visibilitySaving: true });
    try {
      await api.setGroupVisibility(id, hidden);
      if (!this._visible || this.data.id !== id) return;
      this.setData({ myHidden: hidden });
      wx.showToast({ title: hidden ? '已在本群隐藏' : '已在本群显示', icon: 'none' });
      await this.init({ force: true });
    } catch (err) {
      if (this._visible) { this.setData({ myHidden: this.data.myHidden }); wx.showToast({ title: err.message || '设置失败，请重试', icon: 'none' }); }
    } finally { if (this._visible) this.setData({ visibilitySaving: false }); }
  },
  onDraftName(e) { this.setData({ draftName: e.detail.value }); },
  rename() {
    const named = this.data.named;
    wx.showModal({ title: named ? '修改群榜名称' : '给群榜起个名字', editable: true, content: named ? this.data.name : '',
      placeholderText: '建议填微信群名，最多 100 字',
      success: async res => {
        const value = (res.content || '').trim();
        if (!res.confirm || !value) return;
        if ([...value].length > 100) { wx.showToast({ title: '群名最多 100 个字', icon: 'none' }); return; }
        try {
          await api.renameGroup(this.data.id, value);
          wx.showToast({ title: '已改名', icon: 'success' });
          await this.init({ force: true });
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
      },
    });
  },
  async buildPoster() {
    if (this._posterBusy) { this._posterPending = true; return; }
    this._posterBusy = true;
    const version = this._posterVersion;
    this.setData({ posterError: '' });
    try {
      const node = await new Promise(resolve => wx.createSelectorQuery().in(this)
        .select('#poster').fields({ node: true, size: true }).exec(res => resolve(res && res[0] && res[0].node)));
      if (!node || version !== this._posterVersion) return;
      const codeImage = await loadCodeImage(node);
      if (version !== this._posterVersion) return;
      const ctx = node.getContext('2d');
      const exportImage = (width, height) => new Promise((resolve, reject) => wx.canvasToTempFilePath({
        canvas: node, destWidth: width, destHeight: height, fileType: 'png',
        success: r => resolve(r.tempFilePath), fail: reject,
      }));
      node.width = 750; node.height = 1150;
      this.drawPoster(ctx, 750, 1150, codeImage);
      const posterPath = await exportImage(750, 1150);
      if (version !== this._posterVersion) return;
      node.width = 750; node.height = 600;
      this.drawShareCard(ctx, 750, 600, codeImage);
      const shareCardPath = await exportImage(750, 600);
      if (version === this._posterVersion) this.setData({ posterPath, shareCardPath });
    } catch (err) { if (version === this._posterVersion) this.setData({ posterError: err.message || '分享图生成失败，请重试' }); }
    finally {
      this._posterBusy = false;
      if (this._posterPending) {
        this._posterPending = false;
        if (this._visible && !this.data.loading) this.buildPoster();
      }
    }
  },
  drawShareCard(ctx, W, H, codeImage) { drawGroupPoster(ctx, { data: this.data, cover: true, codeImage }); },
  drawPoster(ctx, W, H, codeImage) { drawGroupPoster(ctx, { data: this.data, codeImage }); },

  previewPoster() {
    if (this.data.posterPath) wx.previewImage({ urls: [this.data.posterPath] });
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period) return;
    this.setData({ period });
    return this.init();
  },
  goConnect() { wx.navigateTo({ url: flow.connectUrl(this.data.id) }); },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
  goMine() { wx.switchTab({ url: '/pages/profile/profile' }); },
  goSquare() { wx.switchTab({ url: '/pages/square/square' }); },
  onShareAppMessage() {
    const card = flow.shareCard();
    const named = this.data.joined === true && this.data.name;
    // The card opens the recipient's own group; carry the source name so that page can say where the card came from.
    return { ...card, title: named ? `${this.data.name} · ${this.data.members} 人已加入` : card.title,
      path: named ? `${card.path}&src=${encodeURIComponent([...this.data.name].slice(0, 30).join(''))}` : card.path,
      imageUrl: this.data.shareCardPath || '/assets/share-cover.png' };
  },
});
