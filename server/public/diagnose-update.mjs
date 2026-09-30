// Read-only, local comparison. This file never uploads data or starts a collector.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DAY = 86400000, OFFSET = 8 * 3600000;
const dayOf = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const columns = ['tokens', 'requests', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write'];
const empty = () => Object.fromEntries(columns.map(key => [key, 0]));
const add = (target, row) => { for (const key of columns) target[key] += row[key]; };
const delta = (before, after) => Object.fromEntries(columns.map(key => [key, after[key] - before[key]]));

function readCounts(path, cutoff) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error('统计库或备份不存在，无法比较。');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    return db.prepare(`SELECT date(ts/1000,'unixepoch','+8 hours') AS day, tool,
      COUNT(*) AS requests, SUM(total_tokens) AS tokens, SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens, SUM(cached_input) AS cache_read, SUM(cache_write) AS cache_write
      FROM events WHERE ts >= 0 AND ts <= ? GROUP BY day,tool ORDER BY day,tool`).all(cutoff);
  } catch { throw new Error('无法只读查询统计库；请确认更新已结束，且使用支持 node:sqlite 的 Node.js 22.13+。'); }
  finally { db?.close(); }
}

export function compareCounts(beforeRows, afterRows, cutoff) {
  const to = dayOf(cutoff), periods = {};
  for (const [name, days] of [['today', 1], ['last_7_days', 7], ['last_30_days', 30], ['all', null]]) {
    const from = days ? dayOf(cutoff - (days - 1) * DAY) : null;
    const before = empty(), after = empty();
    for (const [rows, target] of [[beforeRows, before], [afterRows, after]])
      for (const row of rows) if ((!from || row.day >= from) && row.day <= to) add(target, row);
    periods[name] = { from, to, before, after, change: delta(before, after) };
  }
  const groups = key => {
    const map = new Map();
    for (const [rows, side] of [[beforeRows, 'before'], [afterRows, 'after']]) for (const row of rows) {
      const label = row[key] || 'unknown';
      if (!map.has(label)) map.set(label, { [key]: label, before: empty(), after: empty() });
      add(map.get(label)[side], row);
    }
    return [...map.values()].map(row => ({ ...row, change: delta(row.before, row.after) }))
      .sort((a, b) => Math.abs(b.change.tokens) - Math.abs(a.change.tokens));
  };
  return { periods, tools: groups('tool'), changed_days: groups('day').filter(row =>
    columns.some(key => row.change[key] !== 0)).slice(0, 10) };
}

export function diagnoseUpdate({ home = homedir(), now = Date.now() } = {}) {
  const dir = join(home, '.tokenrank');
  let config;
  try { config = readJSON(join(dir, 'config.json')); }
  catch { throw new Error('未找到可读取的 TokenRank 接入配置。'); }
  for (const kind of ['update', 'sync']) {
    const file = join(dir, kind + '.lock');
    if (!existsSync(file)) continue;
    let lock; try { lock = readJSON(file); } catch { throw new Error('后台锁无法核实，请稍后再执行诊断。'); }
    if (Number.isInteger(lock.pid) && lock.pid > 0) {
      let active = true; try { process.kill(lock.pid, 0); } catch (err) { if (err.code === 'ESRCH') active = false; }
      if (active) throw new Error('更新或同步仍在运行，请完成后再执行这条只读诊断命令。');
    }
  }
  const folder = join(dir, 'backups');
  const backups = (existsSync(folder) ? readdirSync(folder) : []).flatMap(name => {
    const match = /^update-(\d{13})-[a-zA-Z0-9-]+$/.exec(name), file = join(folder, name, 'tokenmeter.db');
    return match && Number(match[1]) <= now && existsSync(file) && statSync(file).isFile()
      ? [{ path: file, time: Number(match[1]) }] : [];
  }).sort((a, b) => a.time - b.time);
  // The latest backup may already contain corrected data after a second update.
  const backup = backups[0];
  if (!backup) throw new Error('没有找到更新前的统计库备份，无法判断增减原因；无需为诊断再次运行更新命令。');
  if (!config.db_path || !existsSync(config.db_path)) throw new Error('当前统计库不存在。');
  if (realpathSync(config.db_path) === realpathSync(backup.path)) throw new Error('当前库与备份指向同一文件，无法比较。');
  let version = null;
  try {
    const pkg = readJSON(join(dirname(dirname(config.upstream_entry)), 'package.json'));
    if (pkg.name === 'token-watcher' && /^\d+\.\d+\.\d+$/.test(pkg.version)) version = pkg.version;
  } catch {}
  return { format: 'tokenrank-update-audit-v1', timezone: 'Asia/Shanghai',
    checked_at: new Date(now).toISOString(), cutoff: new Date(backup.time).toISOString(),
    current_kernel_version: version, latest_update_status: config.last_update?.status || null,
    backup_count: backups.length, compared_backup: 'earliest_available',
    note: '使用最早保留的更新前备份；两边均只统计该备份时刻之前的请求。今日及近7/30天也以该时刻为准。增减仍需结合原始用量记录判断；本报告不含会话内容、账号凭证或设备ID。',
    ...compareCounts(readCounts(backup.path, backup.time), readCounts(config.db_path, backup.time), backup.time),
  };
}

export function formatReport(report) {
  const number = n => n.toLocaleString('zh-CN');
  const signed = n => (n > 0 ? '+' : '') + number(n);
  const time = new Date(Date.parse(report.cutoff) + OFFSET).toISOString().slice(0, 19).replace('T', ' ');
  const row = (label, value, field = 'tokens') => `${label} | ${number(value.before[field])} → ${number(value.after[field])} | ${signed(value.change[field])}`;
  const lines = ['TokenRank 只读更新对比', `共同统计截止：${time}（北京时间）`,
    `内核：${report.current_kernel_version || '未确认'}；最近更新状态：${report.latest_update_status || '未确认'}`,
    `发现 ${report.backup_count} 份备份，使用最早保留的一份。`, '', '周期 | 更新前 Tokens → 当前重算 Tokens | 变化'];
  for (const [key, label] of [['today', '当日'], ['last_7_days', '近7天'], ['last_30_days', '近30天'], ['all', '累计']])
    lines.push(row(label, report.periods[key]));
  lines.push('', '工具累计 | 更新前 Tokens → 当前重算 Tokens | 变化');
  for (const tool of report.tools) lines.push(row(tool.tool, tool));
  lines.push('', '工具请求数 | 更新前 → 当前重算 | 变化');
  for (const tool of report.tools) lines.push(row(tool.tool, tool, 'requests'));
  lines.push('', '缓存命中 Tokens | 更新前 → 当前重算 | 变化');
  for (const tool of report.tools) lines.push(row(tool.tool, tool, 'cache_read'));
  lines.push('', '变化最大的日期 | 更新前 Tokens → 当前重算 Tokens | 变化');
  for (const day of report.changed_days) lines.push(row(day.day, day));
  if (!report.changed_days.length) lines.push('同一截止时间内，用量未变化。');
  lines.push('', report.note);
  return lines.join('\n');
}

if (!process.argv[1] || process.argv[1] === '-' || resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(formatReport(diagnoseUpdate())); }
  catch (err) { console.error('[tokenrank] ' + err.message); process.exitCode = 1; }
}
