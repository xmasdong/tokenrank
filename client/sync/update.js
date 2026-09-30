import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, chmodSync, accessSync, constants, cpSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SYNC_DIR, readConfig, writeConfig, normalizeUrl, normalizeToken, rejectSharedDirectory } from './config.js';
import { findUpstream, findNpm, inspectUpstream, REGISTRY, UPSTREAM_VERSION as FIXED_VERSION, compareVersions, resolveUpdate } from './upstream.js';
import { updateServices, assertCollectorStopped } from './update-services.js';
import { acquireLock } from './lock.js';
import { readDays } from './source.js';
import { sync } from './report.js';
import { stageAdapter, activateRebuild } from './update-adapter.js';
import { pruneBackups } from './cleanup.js';

export { UPSTREAM_VERSION as FIXED_VERSION, FIXED_COMMIT, FIXED_SOURCE, compareVersions, resolveUpdate } from './upstream.js';
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 60000, ...options });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function backupSource(dbPath, destination) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('VACUUM INTO ?').run(destination); }
  finally { db.close(); }
  chmodSync(destination, 0o600);
}

/** Explicit user-triggered upgrade, upstream rescan and full replacement upload. */
export async function updateAndResync({ home = homedir(), dir = SYNC_DIR, platform = process.platform, path,
  runner = run, fetcher = fetch, upload = sync, services = updateServices, stopped = assertCollectorStopped,
  sleep = wait, log = console.log } = {}) {
  if (process.env.TOKENRANK_OFFLINE === '1' || process.env.TOKENMETER_OFFLINE === '1') throw new Error('当前为离线模式，未执行更新或回传');
  const config = readConfig(dir);
  if (!config.server || !config.token || !config.device_id) throw new Error('尚未绑定小程序，请先执行小程序里的接入命令');
  normalizeUrl(config.server); normalizeToken(config.token);
  const dbPath = rejectSharedDirectory(config.db_path, dir);
  if (dbPath !== realpathSync(join(home, '.tokenmeter/tokenmeter.db'))) throw new Error('自定义统计库需按原采集服务的配置升级；本命令未修改数据');
  readDays(dbPath);
  const releaseUpdate = acquireLock(dir, 'update');
  if (!releaseUpdate) throw new Error('已有更新正在进行，请等待该命令完成');
  let releaseSync, stage, adapter, work, coreStopped = false, syncStopped = false, scanStarted = false, scanned = false, plan, completionMessage;
  try {
    let found = findUpstream({ home, platform, path, preferred: config.upstream_entry, runner });
    if (!found) throw new Error('未找到已安装的原版 token-watcher，请先完成接入');
    plan = services({ home, dir, platform, found, runner, log });
    found = plan.found || found;
    const target = await resolveUpdate(fetcher);
    if (compareVersions(found.version, target.version) > 0) { target.version = found.version; target.spec = null; target.source = '本机较新版本'; }
    const needsUpdate = compareVersions(found.version, target.version) < 0;
    if (needsUpdate && (existsSync(join(found.root, '.git')) || /[\\/]Cellar[\\/]/.test(found.root)))
      throw new Error(`实际采集服务使用 ${found.version}，由源码或 Homebrew 管理。请先按原方式升级至 ${target.version}，再运行本命令重算回传；未覆盖该安装`);
    adapter = stageAdapter(dir);
    log(`统计内核：${found.version} → ${target.version}（${target.source}）`);
    if (target.source.startsWith('GitHub')) log(`npm 尚未发布去重修复，使用上游已合并的 ${FIXED_VERSION} 固定源码。`);
    let replacement;
    if (needsUpdate) {
      accessSync(dirname(found.root), constants.W_OK);
      stage = mkdtempSync(join(dirname(found.root), '.tokenrank-update-'));
      const npm = findNpm({ path, platform });
      log('下载原版及依赖，下载完成前保持现有服务运行…');
      runner(process.execPath, [npm, 'install', '--prefix', stage, '--install-strategy=nested', '--no-audit', '--no-fund',
        '--ignore-scripts', '--save-exact', '--registry', REGISTRY, target.spec], { stdio: 'inherit', timeout: 600000 });
      replacement = inspectUpstream(join(stage, 'node_modules/token-watcher/bin/tokenwatcher.js'));
      if (!replacement || replacement.version !== target.version) throw new Error('下载的原版包身份或版本不符，尚未停止服务');
      if (relative(found.root, found.entry) !== relative(replacement.root, replacement.entry))
        throw new Error('原版 CLI 文件名已变更，请先按原版说明升级启动入口；尚未停止服务或修改数据');
      // Official source archives omit the prebuilt menu bar app. Preserve the installed binary.
      const oldBar = join(found.root, 'bin/token-watcher.app'), newBar = join(replacement.root, 'bin/token-watcher.app');
      if (existsSync(oldBar) && !existsSync(newBar)) cpSync(oldBar, newBar, { recursive: true, errorOnExist: true, force: false });
      runner(process.execPath, ['--no-warnings', replacement.entry, '--version']);
    }
    log('等待当前同步结束，暂停采集与回传…');
    for (let attempt = 0; attempt < 60 && !releaseSync; attempt++) {
      releaseSync = acquireLock(dir, 'sync');
      if (!releaseSync) await sleep(1000);
    }
    if (!releaseSync) throw new Error('当前同步仍在运行，请稍后重试');
    // Save flags before stopping so partial service-stop failures also recover.
    syncStopped = true; for (const service of plan.sync) service.stop();
    coreStopped = true; for (const service of plan.collector) service.stop();
    await sleep(1000);
    stopped({ platform, found, runner });
    const watchLock = join(dir, 'watch.lock');
    if (existsSync(watchLock)) {
      const watcher = JSON.parse(readFileSync(watchLock, 'utf8'));
      if (!Number.isInteger(watcher.pid) || watcher.pid <= 0) throw new Error('同步后台锁无效，请检查后重试');
      let alive = true;
      try { process.kill(watcher.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('仍有手动启动的同步器在运行，请退出 tokenrank watch 后重试');
    }
    const backupDir = join(dir, 'backups', `update-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = join(backupDir, 'tokenmeter.db');
    backupSource(dbPath, backup);
    log(`统计库已备份：${backup}`);
    let packageBackup = null;
    if (needsUpdate) {
      packageBackup = found.root + `.tokenrank-backup-${Date.now()}`;
      renameSync(found.root, packageBackup);
      try { renameSync(replacement.root, found.root); }
      catch (err) { renameSync(packageBackup, found.root); throw err; }
    }
    const current = inspectUpstream(found.entry);
    if (!current || compareVersions(current.version, FIXED_VERSION) < 0) throw new Error('升级后未检测到修复版本');
    const adapterBackup = adapter.install();
    log(`本地同步脚本已升级至 ${adapter.version}。`);
    writeConfig({ ...readConfig(dir), upstream_entry: current.entry, upstream_version: current.version,
      last_update: { version: current.version, client_version: adapter.version, backup, adapter_backup: adapterBackup,
        package_backup: packageBackup, status: 'rescanning' } }, dir);
    scanStarted = true;
    work = mkdtempSync(join(dirname(dbPath),'.tokenrank-rebuild-'));
    const rebuilding = join(work,'working.db'), rebuilt = join(work,'ready.db');
    cpSync(backup,rebuilding);
    log('正在从现存原始日志重新计算，旧统计已备份；历史较多时需要几分钟…');
    runner(process.execPath, ['--no-warnings', join(import.meta.dirname, 'rebuild-worker.js'), current.root, rebuilding], { stdio: 'inherit', timeout: 0 });
    readDays(rebuilding);
    backupSource(rebuilding,rebuilt);
    activateRebuild(rebuilt,dbPath,backupDir);
    // The snapshot above already covers recovery; the moved original is a second full copy.
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(backupDir, 'original-database.db' + suffix), { force: true });
    scanned = true;
    writeConfig({ ...readConfig(dir), replace_pending: true, last_update: { ...readConfig(dir).last_update, status: 'ready-to-sync' } }, dir);
    for (const service of plan.collector) service.start();
    for (let attempt = 0; attempt < 15; attempt++) {
      if (plan.collector.every(service => service.check())) { coreStopped = false; break; }
      await sleep(1000);
    }
    if (coreStopped) throw new Error('重算完成，但采集后台尚未启动成功，请检查原版服务日志并重试');
    const latest = readConfig(dir);
    if (latest.server !== config.server || latest.token !== config.token || latest.device_id !== config.device_id || latest.db_path !== config.db_path)
      throw new Error('接入配置已改变，未向新账号回传；请重新执行更新命令');
    log('重算已完成，正在暂存完整用量；全部到达后清除本账号旧云端统计并替换…');
    const result = await upload({ dir, full: true, replace: true, log });
    if (result.ok !== true || result.skipped || result.replaced !== true) throw new Error('完整替换尚未完成，后台将继续回传；云端旧用量暂时保留');
    writeConfig({ ...readConfig(dir), last_update: { ...readConfig(dir).last_update, status: 'complete', completed_at: Date.now() } }, dir);
    pruneBackups({ dir, log });
    completionMessage = `更新与回传完成：token-watcher ${current.version}，同步器 ${adapter.version}；本账号云端旧统计已完整替换（${result.accepted} 天）。请在小程序下拉刷新。`;
    return { ...result, version: current.version };
  } catch (err) {
    if (scanStarted && !scanned) log('历史重算未完成，自动回传保持暂停。原始日志和备份已保留，请处理报错后重新执行同一更新命令。');
    throw err;
  } finally {
    const errors = [];
    if (coreStopped) for (const service of plan.collector) { try { service.start(); } catch { errors.push(`请手动恢复采集服务 ${service.name}`); } }
    // A failed scan must never be described as a completed correction, or uploaded by the old background adapter.
    if (syncStopped && (!scanStarted || scanned)) for (const service of plan.sync) { try { service.start(); } catch { errors.push(`请重新运行接入命令恢复同步服务 ${service.name}`); } }
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (work) rmSync(work,{recursive:true,force:true});
    adapter?.cleanup();
    releaseSync?.(); releaseUpdate();
    if (errors.length) throw new Error(errors.join('；'));
    if (completionMessage) log(completionMessage);
  }
}
