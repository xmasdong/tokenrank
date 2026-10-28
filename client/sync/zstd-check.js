import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readConfig } from './config.js';

// Original token-watcher reads dsh's multi-frame .jsonl.zstd sessions through the zstd program; Node's
// built-in decoder stops after the first frame. Same lookup order as upstream src/zstd.js.
const BINS = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];
// Official Windows build from facebook/zstd v1.5.7 (zstd-v1.5.7-win64.zip), mirrored on the TokenRank server.
export const WINDOWS_ZSTD = { version: '1.5.7', file: 'zstd-1.5.7-win64.exe',
  sha256: '8076aae03feac7c66b319579e82172eed168deed2a3f25e5e2d3c60f55e84111' };

/** ~/.tokenrank/bin goes first on PATH for upstream scans and the Windows collector. */
export const zstdBin = dir => join(dir, 'bin');
export function zstdEnv(dir, platform, env = process.env) {
  if (platform !== 'win32') return env;
  // Windows keeps the original spelling (usually "Path"); a second "PATH" key would be ambiguous.
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: zstdBin(dir) + ';' + (env[key] || '') };
}

const reachable = (platform, runner, env) => (platform === 'win32' ? ['zstd'] : BINS).some(bin => {
  try { runner(bin, ['--version'], { stdio: 'ignore', timeout: 5000, env }); return true; } catch { return false; }
});
const hint = platform => platform === 'win32' ? 'winget install -e --id Meta.Zstandard（或 scoop install zstd），装好后重新打开 PowerShell'
  : platform === 'darwin' ? 'brew install zstd' : '用系统包管理器安装 zstd，如 sudo apt install zstd';
const problem = (platform, reason = '') => `检测到 dsh 会话，但本机没有可用的 zstd 程序${reason}。原版读取 dsh 多帧压缩会话需要它，`
  + `缺少时 dsh 用量会漏算，更新重算也会失败。请先安装：${hint(platform)}`;

/**
 * Make zstd reachable when dsh sessions exist. On Windows, fetch the pinned official build into ~/.tokenrank/bin
 * (no admin rights, system PATH untouched); elsewhere only report how to install it.
 * Returns { problem, env }: env is what upstream scans should run with.
 */
export async function ensureZstd({ home, dir, platform, runner, fetcher = fetch, server, log = () => {} }) {
  const env = zstdEnv(dir, platform);
  if (!existsSync(join(home, '.dsh/sessions')) || reachable(platform, runner, env)) return { problem: null, env };
  if (platform !== 'win32') return { problem: problem(platform), env };
  const origin = server || readConfig(dir).server || process.env.TOKENRANK_SERVER;
  if (!origin) return { problem: problem(platform), env };
  const target = join(zstdBin(dir), 'zstd.exe'), temp = target + '.download';
  try {
    log(`检测到 dsh 会话，下载官方 zstd ${WINDOWS_ZSTD.version}（约 1.6 MB，仅放在 ${zstdBin(dir)}）…`);
    const response = await fetcher(`${origin.replace(/\/+$/, '')}/dl/${WINDOWS_ZSTD.file}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_ZSTD.sha256) throw new Error('下载内容校验不符');
    mkdirSync(zstdBin(dir), { recursive: true });
    writeFileSync(temp, bytes); renameSync(temp, target);
    if (!reachable(platform, runner, env)) throw new Error('下载后仍无法运行');
    log(`zstd ${WINDOWS_ZSTD.version} 已就绪。`);
    return { problem: null, env };
  } catch (err) {
    rmSync(temp, { force: true });
    if (existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') !== WINDOWS_ZSTD.sha256) rmSync(target, { force: true });
    return { problem: problem(platform, `（自动准备失败：${err.message}）`), env };
  }
}
