import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readConfig, writeConfig, SYNC_DIR, rejectSharedDirectory } from './config.js';
import { readDays } from './source.js';

// Minimum original release with the Codex replay and DSH duplicate fixes.
export const UPSTREAM_VERSION = '1.8.2';
export const FIXED_COMMIT = 'c5a84fcc4a3ea63fb46a44a860b164999b9f7748';
export const FIXED_SOURCE = `https://codeload.github.com/luwill/token-watcher/tar.gz/${FIXED_COMMIT}`;
export const REGISTRY = process.env.TOKENRANK_REGISTRY || 'https://registry.npmjs.org/';
const OWNER = 'tokenrank-upstream-bootstrap-v1';
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...options });
export const upstreamPrefix = (home = homedir(), platform = process.platform) => platform === 'win32'
  ? join(home, 'AppData', 'Local', 'TokenWatcher') : join(home, '.local', 'share', 'token-watcher');
const readJSON = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const canonical = file => { try { return realpathSync(file); } catch { return resolve(file); } };
const same = (a, b) => canonical(a) === canonical(b);
const decodeXML = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[k]);
const parts = version => /^\d+\.\d+\.\d+$/.test(version || '') ? version.split('.').map(Number) : null;
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) throw new Error('仅支持稳定版本号，尚未修改原版安装');
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
/** Versions without the duplicate-count fixes; unknown versions are left to the caller. */
export const collectorOutdated = version => !!parts(version) && compareVersions(version, UPSTREAM_VERSION) < 0;

/** Latest official stable release, never older than the fixed release. */
export async function resolveUpdate(fetcher = fetch) {
  const response = await fetcher(`${REGISTRY}token-watcher/latest`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`无法查询官方 npm 最新版本（HTTP ${response.status}），尚未修改原版安装`);
  const pkg = await response.json();
  if (pkg.name !== 'token-watcher' || !parts(pkg.version)) throw new Error('官方版本信息无效，尚未修改原版安装');
  if (compareVersions(pkg.version, UPSTREAM_VERSION) >= 0) return { version: pkg.version, spec: `token-watcher@${pkg.version}`, source: 'npm' };
  return { version: UPSTREAM_VERSION, spec: FIXED_SOURCE, source: `GitHub ${FIXED_COMMIT.slice(0, 7)}` };
}
const ps = value => "'" + String(value).replaceAll("'", "''") + "'";

/** Inspect package identity without executing a possibly old TokenRank alias. */
export function inspectUpstream(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  const path = canonical(candidate);
  for (let root = dirname(path), depth = 0; depth < 6; root = dirname(root), depth++) {
    const pkg = readJSON(join(root, 'package.json'));
    if (pkg) {
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      if (pkg.name !== 'token-watcher' || !/github\.com[:/]luwill\/token-watcher(?:\.git)?(?:#.*)?$/.test(repo || '')) return null;
      // Official pre-1.4 packages used tokenwatcher/tokenmeter before adding token-watcher.
      const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['token-watcher'] || pkg.bin?.tokenwatcher || pkg.bin?.tokenmeter;
      if (!relative) return null;
      const entry = resolve(root, relative);
      if (existsSync(entry) && entry.startsWith(root + (process.platform === 'win32' ? '\\' : '/')))
        return { entry: canonical(entry), version: pkg.version, root };
      return null;
    }
    if (dirname(root) === root) break;
  }
  return null;
}

function commandPaths(name, path = process.env.PATH || '', platform = process.platform) {
  return path.split(platform === 'win32' ? ';' : delimiter).filter(Boolean).flatMap(dir =>
    (platform === 'win32' ? [name + '.cmd', name + '.exe', name] : [name]).map(n => join(dir, n))).filter(existsSync);
}
export function findNpm({ path, platform = process.platform } = {}) {
  for (const executable of commandPaths('npm', path, platform)) {
    const candidates = [canonical(executable), join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
    const cli = candidates.find(p => p.endsWith('npm-cli.js') && existsSync(p));
    if (cli) return cli;
  }
  throw new Error('未找到 npm，请安装包含 npm 的 Node.js 22.13+ 后重试');
}

export function findUpstream({ home = homedir(), platform = process.platform, path, preferred, runner = run } = {}) {
  const candidates = preferred ? [preferred] : [];
  for (const alias of ['token-watcher', 'tokenwatcher', 'tokenmeter']) {
    for (const bin of commandPaths(alias, path, platform)) {
      candidates.push(bin, join(dirname(bin), 'node_modules/token-watcher/bin/tokenwatcher.js'),
        join(dirname(bin), '../token-watcher/bin/tokenwatcher.js'));
    }
  }
  if (platform === 'darwin') {
    for (const label of ['com.tokenwatcher.server', 'com.tokenmeter.server']) {
      const file = join(home, 'Library/LaunchAgents', label + '.plist');
      if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/<string>(.*?)<\/string>/gs)) candidates.push(decodeXML(match[1]));
    }
  }
  for (const candidate of candidates) { const found = inspectUpstream(candidate); if (found) return found; }
  // Read-only npm query also finds a global install whose command directory isn't on PATH.
  try {
    const npm = findNpm({ path, platform });
    const root = String(runner(process.execPath, [npm, 'root', '-g'], { timeout: 15000 })).trim();
    const found = inspectUpstream(join(root, 'token-watcher/bin/tokenwatcher.js'));
    if (found) return found;
  } catch {}
  return inspectUpstream(join(upstreamPrefix(home, platform), 'node_modules/token-watcher/bin/tokenwatcher.js'));
}

function saveState(prefix, state) {
  const temp = join(prefix, '.bootstrap-state.tmp');
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, join(prefix, 'tokenrank-bootstrap.json'));
}

/** Dependency preparation is explicit; the read-only upload loop never installs or starts upstream. */
export async function prepareUpstream({ home = homedir(), platform = process.platform, dir = SYNC_DIR, path, runner = run, fetcher = fetch, log = console.log } = {}) {
  const config = readConfig(dir), prefix = upstreamPrefix(home, platform);
  const defaultDB = join(home, '.tokenmeter/tokenmeter.db');
  const db = rejectSharedDirectory(config.db_path || defaultDB, dir);
  // Refuse incompatible existing data BEFORE invoking upstream's writable scan/migrations.
  if (existsSync(db)) readDays(db);
  let found = findUpstream({ home, platform, path, preferred: config.upstream_entry, runner });
  let state = readJSON(join(prefix, 'tokenrank-bootstrap.json'));
  if (!found) {
    if (!same(db, defaultDB)) throw new Error('自定义统计库对应的原版安装未找到，请先把原版 token-watcher 加入 PATH 后重试');
    const npm = findNpm({ path, platform });
    const target = await resolveUpdate(fetcher);
    if (existsSync(prefix) && (lstatSync(prefix).isSymbolicLink() || state?.owner !== OWNER))
      throw new Error(`原版安装目录已被其他内容占用：${prefix}；未覆盖，请先独立安装 token-watcher 后重试`);
    mkdirSync(prefix, { recursive: true });
    state = { owner: OWNER, ready: false, scanned: false, collector: false };
    saveState(prefix, state); // Allows retry of interrupted downloads without touching global packages.
    log(`未检测到原版，安装 token-watcher ${target.version}（${target.source}）到用户目录（无需管理员权限）…`);
    runner(process.execPath, [npm, 'install', '--prefix', prefix, '--install-strategy=nested', '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact',
      '--registry', REGISTRY, target.spec], { stdio: 'inherit' });
    found = inspectUpstream(join(prefix, 'node_modules/token-watcher/bin/tokenwatcher.js'));
    if (!found || found.version !== target.version) throw new Error('原版安装未完成或版本不符合预期；尚未配置同步');
  } else if (collectorOutdated(found.version)) {
    log(`已检测到 token-watcher ${found.version}，低于修复重复统计的 ${UPSTREAM_VERSION}；接入后会自动升级并重新计算，升级前不上传用量。`);
  } else log(`已检测到 token-watcher ${found.version}，已包含去重修复，直接复用。`);
  const managed = state?.owner === OWNER && same(found.entry, join(prefix, 'node_modules/token-watcher/bin/tokenwatcher.js'));
  if (!existsSync(db) || (managed && !state.scanned)) {
    if (!same(db, defaultDB)) throw new Error('自定义统计库不存在，请先确认原版采集器的数据路径');
    log('调用原版完成首次采集；统计库由原版自行维护，首次扫描可能需要几分钟…');
    runner(process.execPath, ['--no-warnings', found.entry, 'scan'], { stdio: 'inherit' });
    if (managed) { state.scanned = true; saveState(prefix, state); }
  }
  readDays(db);
  writeConfig({ ...readConfig(dir), db_path: canonical(db), upstream_entry: found.entry, upstream_version: found.version }, dir);
  return { ...found, managed, prefix };
}

/** Only a collector installed by this bootstrap gets a new background service. Existing installs are left alone. */
export function startPreparedUpstream({ home = homedir(), platform = process.platform, dir = SYNC_DIR, runner = run, log = console.log } = {}) {
  const prefix = upstreamPrefix(home, platform), state = readJSON(join(prefix, 'tokenrank-bootstrap.json'));
  const found = inspectUpstream(readConfig(dir).upstream_entry);
  if (!found) throw new Error('尚未准备好原版 token-watcher，请先运行 prepare-upstream');
  if (state?.owner !== OWNER || !same(found.entry, join(prefix, 'node_modules/token-watcher/bin/tokenwatcher.js'))) {
    if (platform === 'darwin' && readConfig(dir).legacy_collector_retired) {
      // The verified legacy fork owned the collector label. Restore collection using the existing original.
      let service = null;
      for (const label of ['com.tokenwatcher.server', 'com.tokenmeter.server']) {
        const file = join(home, 'Library/LaunchAgents', label + '.plist');
        if (existsSync(file)) {
          const entries = [...readFileSync(file, 'utf8').matchAll(/<string>(.*?)<\/string>/gs)].map(m => decodeXML(m[1]));
          if (!entries.includes(found.entry)) throw new Error(`已有 ${label} 配置，未覆盖；请确认原版服务入口`);
          service = file;
        }
        let loaded = false;
        try { runner('launchctl', ['print', `gui/${process.getuid()}/${label}`]); loaded = true; } catch {}
        if (loaded) {
          if (!existsSync(file)) throw new Error(`已有 ${label} 正在运行但无法确认入口，未替换`);
          writeConfig({ ...readConfig(dir), legacy_collector_retired: false }, dir);
          return { reused: true };
        }
      }
      if (service) runner('launchctl', ['bootstrap', `gui/${process.getuid()}`, service]);
      else runner(process.execPath, ['--no-warnings', found.entry, 'install-agent'], { stdio: 'inherit' });
      writeConfig({ ...readConfig(dir), legacy_collector_retired: false }, dir);
      log('旧版 TokenRank 采集服务已由现有原版接管；原版程序与统计库未覆盖。');
      return { started: true };
    }
    log('复用已有原版安装，保留其后台配置；请保持原版采集器运行。'); return { reused: true };
  }
  if (state.collector) { log('原版后台已配置，跳过重复安装。'); return { reused: true }; }
  if (platform === 'darwin') {
    // Original install-agent rewrites its own label, so refuse pre-existing services of any ownership.
    let ownService = null;
    for (const label of ['com.tokenwatcher.server', 'com.tokenmeter.server']) {
      const file = join(home, 'Library/LaunchAgents', label + '.plist');
      if (existsSync(file)) {
        const entries = [...readFileSync(file, 'utf8').matchAll(/<string>(.*?)<\/string>/gs)].map(m => decodeXML(m[1]));
        if (label === 'com.tokenwatcher.server' && entries.some(p => p === found.entry)) ownService = file;
        else throw new Error(`已有 ${label} 配置，未覆盖；请确认原版服务入口后重试`);
      }
      let loaded = false;
      try { runner('launchctl', ['print', `gui/${process.getuid()}/${label}`]); loaded = true; } catch {}
      if (loaded && !(label === 'com.tokenwatcher.server' && ownService)) throw new Error(`已有 ${label} 正在运行，未替换，请确认其归属`);
      if (loaded && label === 'com.tokenwatcher.server' && ownService) {
        state.collector = true; state.ready = true; saveState(prefix, state);
        log('原版采集服务已在运行，复用现有配置。'); return { reused: true };
      }
    }
    if (ownService) runner('launchctl', ['bootstrap', `gui/${process.getuid()}`, ownService]);
    else runner(process.execPath, ['--no-warnings', found.entry, 'install-agent'], { stdio: 'inherit' });
  } else if (platform === 'win32') {
    // Upstream 1.8.0 only provides launchd; wrap the unmodified serve command on Windows.
    const vbs = join(prefix, 'collector.vbs'), quote = s => '"' + s.replaceAll('"', '""') + '"';
    const script = `CreateObject("WScript.Shell").Run ${quote(quote(process.execPath) + ' --no-warnings ' + quote(found.entry) + ' serve --no-open')}, 0, True\r\n`;
    writeFileSync(vbs, '\uFEFF' + script, 'utf16le');
    const command = `$ErrorActionPreference='Stop'; $name='TokenWatcherForTokenRank'; `
      + `$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; `
      + `if($existing){if((($existing.Actions | Out-String).Contains(${ps(vbs)}))){Start-ScheduledTask -TaskName $name; exit 0}else{throw '同名采集任务已存在，未覆盖'}}; `
      + `$a=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${ps('"' + vbs + '"')}; `
      + `$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; `
      + `$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); `
      + `Register-ScheduledTask -TaskName $name -Action $a -Trigger $t -Settings $s -User $env:USERNAME -RunLevel Limited | Out-Null; Start-ScheduledTask -TaskName $name`;
    runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  } else if (platform === 'linux') {
    const folder = join(home, '.config/systemd/user'), unit = 'token-watcher-for-tokenrank.service';
    const file = join(folder, unit);
    mkdirSync(folder, { recursive: true });
    const quote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
    const unitText = `[Unit]\nDescription=Original Token Watcher for TokenRank\n[Service]\nExecStart=${quote(process.execPath)} --no-warnings ${quote(found.entry)} serve --no-open\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
    if (existsSync(file) && readFileSync(file, 'utf8') !== unitText) throw new Error('已有同名采集服务，未覆盖，请检查原版服务状态');
    if (!existsSync(file)) writeFileSync(file, unitText);
    runner('systemctl', ['--user', 'daemon-reload']); runner('systemctl', ['--user', 'enable', '--now', unit]);
  } else throw new Error('此系统需要手动运行原版 token-watcher serve 后再接入');
  state.collector = true; state.ready = true; saveState(prefix, state);
  log('已配置原版采集后台；接下来配置独立榜单同步。');
  return { started: true };
}
