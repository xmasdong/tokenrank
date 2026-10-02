#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SYNC_DIR, DEFAULT_DB, readConfig, writeConfig, normalizeUrl, normalizeToken, rejectSharedDirectory } from '../sync/config.js';
import { readDays, readLegacySettings } from '../sync/source.js';
import { sync } from '../sync/report.js';
import { acquireLock } from '../sync/lock.js';
import { installAgent, uninstallAgent, migrateLegacyAgent } from '../sync/agent.js';
import { prepareUpstream, startPreparedUpstream, inspectUpstream, collectorOutdated } from '../sync/upstream.js';
import { updateAndResync } from '../sync/update.js';
import { pruneDaily } from '../sync/cleanup.js';
import { startWatch } from '../sync/watch.js';
import { notifyStopped, readHealth } from '../sync/health.js';

const args = process.argv.slice(2), options = {}, positional = [];
try {
for (let i = 0; i < args.length; i++) {
  if (['--db', '--app-root'].includes(args[i])) { if (!args[i + 1]) throw new Error(`${args[i]} 缺少参数`); options[args[i].slice(2)] = args[++i]; }
  else if (['--full', '--dry-run', '--purge-data', '--help', '--version'].includes(args[i])) options[args[i].slice(2)] = true;
  else if (args[i].startsWith('--')) throw new Error(`未知选项：${args[i]}`);
  else positional.push(args[i]);
}
} catch (err) { console.error(`[tokenrank] ${err.message}`); process.exit(1); }
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const log = message => console.log(`[tokenrank] ${message}`);
const help = `TokenRank 独立同步器 v${version}
  connect <服务器> <接入码> [--db 路径]  只读原版统计库，配置写入 ~/.tokenrank
  rank push [--full] [--dry-run]          同步变化的日桶；--full 重传全部；--dry-run 只预览
  rank status | rank off                查看状态 / 断开上报
  doctor [--db 路径]                     只读检查数据库结构和统计
  prepare-upstream                      检测原版，缺失时安装并完成首次采集
  start-upstream                        为本脚本新安装的原版配置独立采集后台
  update-and-resync                     更新内核和同步器、备份重建、完整替换本账号云端统计
  update-if-outdated                    仅当原版低于去重修复版本时执行 update-and-resync
  migrate-config [--db 路径]             只读导入旧版 TokenRank 接入配置
  install-agent [--dry-run]              安装独立后台同步服务
  uninstall-agent                       停止独立后台服务
  watch                                 前台持续同步（原版采集器须独立运行）
  uninstall [--purge-data]               断开并移除自己的自启；可清除自己的配置

安装脚本会复用已有原版；缺失时安装官方最新稳定版，低于去重修复版本时先升级重算再上传。
日常同步只读原库；不会自动升级或卸载原版，也不改写原版程序。
`;

async function push(flags = options) {
  const release = acquireLock(SYNC_DIR, 'sync');
  if (!release) return { skipped: 'sync-running' };
  try { return await sync({ full: !!flags.full, dryRun: !!flags['dry-run'], log }); }
  finally { release(); }
}
async function main() {
  const [cmd, sub, third] = positional;
  if (options.version) { console.log(version); return; }
  if (options.help || !cmd) { console.log(help); return; }
  if (cmd === 'prepare-upstream') { await prepareUpstream({ log }); }
  else if (cmd === 'start-upstream') { startPreparedUpstream({ log }); }
  else if (cmd === 'update-if-outdated') {
    // Install flow: an existing pre-fix original is upgraded and rebuilt before any usage is published.
    const current = inspectUpstream(readConfig().upstream_entry);
    if (!current || !collectorOutdated(current.version)) { log(`统计内核 ${current?.version || '未知'} 无需升级。`); return; }
    await updateAndResync({ log });
  }
  else if (cmd === 'update-and-resync') {
    if (options['dry-run']) throw new Error('update-and-resync 不支持 --dry-run；预览上报请使用 rank push --full --dry-run');
    await updateAndResync({ log });
  }
  else if (cmd === 'connect' || cmd === 'migrate-config') {
    const dbPath = rejectSharedDirectory(resolve(options.db || readConfig().db_path || DEFAULT_DB));
    readDays(dbPath); // Validate compatibility before writing any account settings.
    const legacy = cmd === 'migrate-config' ? readLegacySettings(dbPath) : {};
    const server = normalizeUrl(cmd === 'connect' ? sub : legacy['rank.url']);
    const token = normalizeToken(cmd === 'connect' ? third : legacy['rank.token']);
    const previous = readConfig();
    const same = previous.server === server && previous.token === token && previous.db_path === dbPath;
    writeConfig({ ...previous, server, token, db_path: dbPath,
      device_id: previous.device_id || legacy['rank.device_id'] || crypto.randomUUID(),
      synced_days: same ? previous.synced_days || {} : {},
      // A new credential may belong to a fresh account after deletion. Its first
      // upload needs a full snapshot, even if this computer already speaks v2.
      initial_sync_pending: same ? !!previous.initial_sync_pending : true,
      replace_pending: same ? !!previous.replace_pending : false,
      last_ok_at: same ? previous.last_ok_at || null : null,
      last_error: null });
    const result = await push(); log(JSON.stringify(result));
  } else if (cmd === 'doctor') {
    const dbPath = rejectSharedDirectory(resolve(options.db || readConfig().db_path || DEFAULT_DB));
    const days = readDays(dbPath);
    console.log(JSON.stringify({ compatible: true, read_only: true, days: days.length, latest_day: days.at(-1)?.day || null,
      note: '日常采集由原版负责；一键接入脚本可自动准备缺失的原版' }, null, 2));
  } else if ((cmd === 'rank' && sub === 'push') || cmd === 'push') {
    console.log(JSON.stringify(await push(), null, 2));
  } else if ((cmd === 'rank' && sub === 'status') || cmd === 'status') {
    const c = readConfig();
    console.log(JSON.stringify({ version, connected: !!(c.server && c.token), server: c.server || null, source: c.db_path || DEFAULT_DB,
      read_only: true, synced_days: Object.keys(c.synced_days || {}).length, last_ok_at: c.last_ok_at || null, last_error: c.last_error || null,
      sync_health: readHealth(SYNC_DIR,c) }, null, 2));
  } else if ((cmd === 'rank' && sub === 'off') || cmd === 'off') {
    const c = readConfig(); writeConfig({ ...c, token: null, synced_days: {}, last_error: null }); log('已断开上报，原版数据保持不变。');
    if (!await notifyStopped('USER_DISABLED',{config:c})) log('未能通知云端；本机已停止上传。');
  } else if (cmd === 'watch' || cmd === 'rank-watch') {
    const release = acquireLock(SYNC_DIR, 'watch');
    if (!release) { log('已有独立同步器在运行。'); return; }
    process.on('exit', release);
    const watcher=startWatch({log,onIdle:()=>{try {pruneDaily({log});} catch {log('备份清理跳过');}}});
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal,async()=>{await watcher.stop();release();process.exit(0);});
  } else if (cmd === 'install-agent') installAgent({ dryRun: !!options['dry-run'] });
  else if (cmd === 'uninstall-agent') { uninstallAgent(); await notifyStopped('SERVICE_STOPPED'); log('已移除 TokenRank 独立自启。'); }
  else if (cmd === 'migrate-legacy-agent') migrateLegacyAgent({ appRoot: options['app-root'] });
  else if (cmd === 'uninstall') {
    uninstallAgent();
    const c = readConfig();
    if (options['purge-data']) rmSync(join(SYNC_DIR, 'config.json'), { force: true });
    else writeConfig({ ...c, token: null, synced_days: {} });
    await notifyStopped('USER_UNINSTALLED',{config:c});
    log('已停止同步并清除接入凭证；token-watcher 与其统计库保持不变。');
  } else throw new Error('未知命令，请运行 tokenrank --help');
}
main().catch(err => { console.error(`[tokenrank] ${err.message}`); process.exitCode = 1; });
