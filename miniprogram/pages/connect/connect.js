const api = require('../../utils/api');
const flow = require('../../utils/flow');
const upstream = require('../../utils/upstream');
const PRIVACY_ACK = 'privacy_notice_ack_v1';

function buildCommand(os, origin, token) {
  if (!origin || !token) return '';
  return os === 'win'
    ? `& ([scriptblock]::Create((irm "${origin}/releases/0.2.7/install.ps1"))) "${origin}" "${token}"`
    : `curl -fsSL ${origin}/releases/0.2.7/install.sh | sh -s -- ${origin} ${token}`;
}
function buildAiPrompt(command, os) {
  if (!command) return '';
  return `请帮我在这台${os === 'win' ? 'Windows' : 'macOS'}电脑上接入「Token 群排名」。
1. 检查 Node.js 版本，需要 22.13 或更高版本；如未安装，请协助安装。
2. 接入脚本会检查原版 token-watcher：缺失时安装官方最新稳定版到用户目录；已有版本低于 1.8.2（旧版会重复统计）时先升级并重新计算，再开始上传。不要另行全局重装原版。
原版开源仓库：${upstream.info.links[0].url}
原版功能与使用说明：${upstream.info.links[1].url}
3. 运行以下个人接入命令（其中含凭证，请勿公开转发）：
${command}
4. TokenRank 只读原版统计库，按北京时间日聚合原版 total_tokens 总用量（含缓存）并分批回填全部已保留历史，每批最多 400 天；只上传聚合数字与模型、工具名，不上传代码、对话或路径。自己的配置保存在 ~/.tokenrank，不写入原版数据库。
5. 安装脚本包含独立同步服务（macOS: com.tokenrank.sync；Windows: TokenRankSync）。如从旧版 TokenRank 升级，脚本仅停用确认属于旧版的后台服务，并保留程序备份和原统计库；新装原版也会配置采集后台；复用已有原版时保留其后台配置，请确认其仍在采集。
6. 使用 tokenrank doctor 和 tokenrank rank status 检查只读兼容性、首次上报及自启；命令未加入 PATH 时使用脚本输出路径。自定义原版数据库路径用 connect 的 --db 参数。核对报文用 rank push --full --dry-run。
最后告诉我接入、首次数据上报、后台自启是否成功。有失败时给出原因和下一步。`;
}

Page({
  data: { upstream: upstream.info, command: '', rawToken: '', loading: true, checking: false, error: '', rotating: false,
    os: wx.getStorageSync('client_os') || 'mac', aiPrompt: '', showAi: false,
    connState: 'pending', connText: '', hasReported: false, sourceGroup: '' },
  onLoad(options) { this.setData({ sourceGroup: options.g || '' }); },
  onShow() {
    this._visible = true;
    const os = wx.getStorageSync('client_os') || this.data.os;
    const command = buildCommand(os, api.BASE_URL, this.data.rawToken);
    this.setData({ os, command, aiPrompt: buildAiPrompt(command, os) });
    return this.load();
  },
  onHide() { this._visible = false; this._requestId = (this._requestId || 0) + 1; this.stopPolling(); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  stopPolling() { if (this._pollTimer) clearTimeout(this._pollTimer); this._pollTimer = null; },
  switchOs(e) {
    const os = e.currentTarget.dataset.os;
    const command = buildCommand(os, api.BASE_URL, this.data.rawToken);
    this.setData({ os, command, aiPrompt: buildAiPrompt(command, os) });
    wx.setStorageSync('client_os', os);
  },
  async load(options = {}) {
    this.stopPolling();
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const silent = options.silent === true;
    this.setData({ checking: true, ...(silent ? {} : { loading: !this.data.command, error: '' }) });
    try {
      await api.ensureLogin();
      const c = await api.getConnect();
      if (requestId !== this._requestId) return;
      const command = buildCommand(this.data.os, api.BASE_URL, c.token || '');
      this.setData({ loading: false, checking: false, error: '', command, rawToken: c.token || '',
        aiPrompt: buildAiPrompt(command, this.data.os), ...flow.connection(c) });
    } catch (err) {
      if (requestId === this._requestId) this.setData({ loading: false, checking: false,
        error: (this.data.command ? '暂时无法确认同步状态：' : '暂未获取到接入命令：') + err.message });
    } finally {
      if (requestId === this._requestId && this._visible) {
        this._pollTimer = setTimeout(() => this.load({ silent: true }), this.data.hasReported ? 30000 : 5000);
      }
    }
  },
  // Manual check: always say what the server returned, even when nothing changed.
  async checkNow() {
    await this.load();
    if (!this._visible) return;
    const title = this.data.error ? '暂时无法确认，请稍后再试'
      : this.data.hasReported ? this.data.connText : '还没收到用量，确认电脑上的命令已运行完成';
    wx.showToast({ title, icon: 'none', duration: 2500 });
  },
  copyRepo() { wx.setClipboardData({ data: 'https://github.com/xmasdong/tokenrank', success: () => wx.showToast({ title: '地址已复制，请在浏览器打开', icon: 'none' }) }); },
  copyDryRun() { wx.setClipboardData({ data: 'tokenrank rank push --full --dry-run', success: () => wx.showToast({ title: '已复制', icon: 'none' }) }); },
  toggleAi() { this.setData({ showAi: !this.data.showAi }); },
  copyUpstreamLink(e) { upstream.copyLink(e.currentTarget.dataset.key, wx); },
  // First copy only (command or AI prompt): say plainly what is uploaded and that the code is open.
  withPrivacyNotice(copy) {
    if (wx.getStorageSync(PRIVACY_ACK)) return copy();
    wx.showModal({
      title: '接入前先说明',
      content: '只上传每天的用量数字，和用了哪些工具、模型。\n代码、对话、项目名和文件路径都不会收集上传。\n代码全部开源，接入后也可以在「我的」里关掉排名。',
      confirmText: '继续复制', cancelText: '看源码',
      success: res => {
        if (res.confirm) { wx.setStorageSync(PRIVACY_ACK, 1); copy(); }
        else if (res.cancel) this.copyRepo();
      },
    });
  },
  copyCommand() {
    if (!this.data.command) return;
    this.withPrivacyNotice(() => wx.setClipboardData({ data: this.data.command,
      success: () => wx.showToast({ title: '已复制，请发到电脑', icon: 'none' }) }));
  },
  copyAiPrompt() {
    if (!this.data.aiPrompt) return;
    this.withPrivacyNotice(() => wx.setClipboardData({ data: this.data.aiPrompt,
      success: () => wx.showToast({ title: '已复制，请发给电脑上的 AI', icon: 'none' }) }));
  },
  goBoard() {
    const id = this.data.sourceGroup;
    if (!id) { wx.switchTab({ url: '/pages/profile/profile' }); return; }
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2];
    if (previous && previous.route === 'pages/group/group' && previous.data.id === id) {
      wx.navigateBack({ delta: 1 });
    } else { wx.redirectTo({ url: flow.groupUrl(id, 'connect') }); }
  },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' + (this.data.sourceGroup ? `?g=${encodeURIComponent(this.data.sourceGroup)}` : '') }); },
  rotate() {
    if (this.data.rotating) return;
    wx.showModal({ title: '重置接入码', content: '旧码会立即失效，所有已接入的电脑都需要重新运行新命令。历史榜单数据会保留。',
      success: async res => {
        if (!res.confirm || this.data.rotating) return;
        this.stopPolling();
        this._requestId = (this._requestId || 0) + 1;
        this.setData({ rotating: true });
        try {
          await api.rotateConnect();
          this.setData({ command: '', rawToken: '', aiPrompt: '', hasReported: false, connState: 'pending' });
          await this.load();
          wx.showToast({ title: '请用新命令重新接入', icon: 'none' });
        } catch (err) {
          this.setData({ error: '重置失败：' + err.message });
          if (this._visible) this._pollTimer = setTimeout(() => this.load({ silent: true }), 5000);
        } finally { this.setData({ rotating: false }); }
      },
    });
  },
});
