import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Original token-watcher reads dsh's multi-frame .jsonl.zstd sessions through the zstd program; Node's
// built-in decoder stops after the first frame. Same lookup order as upstream src/zstd.js.
const BINS = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];

/** A message when dsh sessions exist but no zstd program is reachable, else null. */
export function zstdProblem({ home, platform, runner }) {
  if (!existsSync(join(home, '.dsh/sessions'))) return null;
  for (const bin of platform === 'win32' ? ['zstd'] : BINS) {
    try { runner(bin, ['--version'], { stdio: 'ignore', timeout: 5000 }); return null; } catch {}
  }
  const hint = platform === 'win32' ? 'winget install -e --id Meta.Zstandard（或 scoop install zstd），装好后重新打开 PowerShell'
    : platform === 'darwin' ? 'brew install zstd' : '用系统包管理器安装 zstd，如 sudo apt install zstd';
  return `检测到 dsh 会话，但本机没有 zstd 程序。原版读取 dsh 多帧压缩会话需要它，缺少时 dsh 用量会漏算，更新重算也会失败。请先安装：${hint}`;
}
