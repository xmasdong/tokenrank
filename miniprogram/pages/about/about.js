const flow = require('../../utils/flow');
const upstream = require('../../utils/upstream');
const AUDIT_PROMPT = `请审计这台电脑的 TokenRank 独立同步器 v0.2.7，并给出代码和文件证据：
1. 入口为 tokenrank，运行文件仅 bin/tokenrank.js 与 sync/。日常同步不调用旧 fork Store 或扫描器；安装阶段可以检测、安装原版并调用原版 scan / 自启。
2. 默认以 SQLite readOnly + query_only 读取 ~/.tokenmeter/tokenmeter.db，配置和同步进度写 ~/.tokenrank。确认原库及其 settings 未被改写。
3. 上报只包含 北京时间日期、原版总量、输入和输出计数、缓存计数、请求数、工具和模型名、随机设备 ID；用 rank push --full --dry-run 核对。接入码不要写入审计结果。
4. macOS 自启为 com.tokenrank.sync，Windows 为 TokenRankSync，Linux 为 tokenrank-sync.service。已有原版不低于 1.8.2 时不重装不升级，低于 1.8.2 时先升级重算、升级前不上传；缺失时在用户目录安装官方最新稳定版，macOS 调用原版自启，Windows 使用 TokenWatcherForTokenRank，Linux 使用 token-watcher-for-tokenrank.service。旧版服务迁移须先验证入口归属。
5. 卸载只移除独立自启和配置，不删除 ~/.tokenmeter、原版安装、原版服务或服务器历史。
6. 检查源数据库是否兼容，确认数据库改变后能够同步。当前榜单采用较新的来源快照，支持历史修正；多台独立电脑不相加，采用最近完成完整接入的电脑。
如实际与清单有出入，请指出，不要直接修改原版数据或服务。`;

Page({
  data: {
    upstream: upstream.info,
    auditHint: AUDIT_PROMPT,
    os: wx.getStorageSync('client_os') || 'mac',   // 与接入页共用同一份选择
    sourceGroup: '',
    updateCmds: [
      { key: 'mac', label: 'macOS / Linux 终端', cmd: 'curl -fsSL https://tokenrank.xmasdong.cn/update.sh | sh' },
      { key: 'win', label: 'Windows PowerShell', cmd: "& ([scriptblock]::Create((irm 'https://tokenrank.xmasdong.cn/update.ps1')))" },
    ],
  },

  onLoad(options) { this.setData({ sourceGroup: options.g || '' }); },
  copyUpstreamLink(e) { upstream.copyLink(e.currentTarget.dataset.key, wx); },
  goConnect() {
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2];
    if (previous && previous.route === 'pages/connect/connect') {
      wx.navigateBack({ delta: 1, success: () => wx.pageScrollTo({ scrollTop: 0, duration: 0 }) });
    }
    else wx.redirectTo({ url: flow.connectUrl(this.data.sourceGroup) });
  },

  /** 客户端系统切换（macOS / Windows）：影响终端名称与自启描述，选择本机记住 */
  switchOs(e) {
    const os = e.currentTarget.dataset.os;
    this.setData({ os });
    wx.setStorageSync('client_os', os);
  },

  copyAudit() {
    wx.setClipboardData({
      data: AUDIT_PROMPT,
      success: () => wx.showToast({ title: '审计提示词已复制', icon: 'success' }),
    });
  },

  copyCmd(e) {
    const cmd = e.currentTarget.dataset.cmd;
    if (!cmd) return;
    wx.setClipboardData({
      data: cmd,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },
});
