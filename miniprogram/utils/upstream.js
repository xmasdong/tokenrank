const info = {
  name: 'Token Watcher',
  attribution: 'luwill / token-watcher · MIT 开源',
  description: '统计 Claude Code、Codex、Cursor 等 AI 工具的 Token 用量，提供本地面板、趋势、模型分布与会话明细。',
  features: '配额、费用估算、数据导出、macOS 菜单栏等功能见原版说明。',
  relationship: 'token-watcher 负责采集和本地面板，本小程序只读取它汇总的用量。',
  links: [
    { key: 'source', label: '开源仓库', url: 'https://github.com/luwill/token-watcher' },
    { key: 'guide', label: '功能与使用说明（中文）', url: 'https://github.com/luwill/token-watcher/blob/main/README.zh-CN.md' },
  ],
  dashboard: 'http://127.0.0.1:8787',
};

function copyLink(key, platform) {
  const url = key === 'dashboard' ? info.dashboard : info.links.find(item => item.key === key)?.url;
  if (!url) return;
  platform.setClipboardData({ data: url,
    success: () => platform.showToast({ title: '地址已复制，请在浏览器打开', icon: 'none' }),
    fail: () => platform.showToast({ title: '复制失败，可长按地址复制', icon: 'none' }),
  });
}
module.exports = { info, copyLink };
