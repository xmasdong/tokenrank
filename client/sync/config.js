import { homedir } from 'node:os';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync, realpathSync } from 'node:fs';

export const SYNC_DIR = join(homedir(), '.tokenrank');
export const DEFAULT_DB = join(homedir(), '.tokenmeter', 'tokenmeter.db');
export function normalizeUrl(raw) {
  const url = new URL(String(raw || ''));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash)
    throw new Error('服务器地址需使用 HTTPS，且不含凭据、查询或片段');
  return url.href.replace(/\/+$/, '');
}
export function normalizeToken(raw) {
  const value = String(raw || '').trim();
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error('接入码应为 32 位十六进制码');
  return value;
}
export function readConfig(dir = SYNC_DIR) {
  const file = join(dir, 'config.json');
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('TokenRank 配置无法读取，请先备份 ~/.tokenrank/config.json 后重新接入'); }
}
export function writeConfig(config, dir = SYNC_DIR) {
  // Never follow a symlink into another application's files.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('同步器目录不能是符号链接');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('配置文件不能是符号链接');
  const temp = join(dir, `.config-${crypto.randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}
export function sourcePath(raw = DEFAULT_DB) { return resolve(raw); }
export function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && rel !== '..' && !isAbsolute(rel));
}
export function rejectSharedDirectory(dbPath, dir = SYNC_DIR) {
  const real = existsSync(dbPath) ? realpathSync(dbPath) : resolve(dbPath);
  const canonical = path => existsSync(path) ? realpathSync(path) : resolve(canonical(dirname(path)), basename(path));
  const own = canonical(resolve(dir));
  if (isInside(own, real)) throw new Error('原版统计库必须位于同步器目录之外，避免卸载或升级影响它');
  if (own === dirname(real)) throw new Error('同步器配置不能写入原版数据目录');
  return real;
}
