import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { DEFAULT_DB } from './config.js';
const REQUIRED = ['ts', 'tool', 'model', 'total_tokens', 'input_tokens', 'output_tokens', 'cached_input', 'cache_write'];
const MAX = { tokens: 1e13, input_tokens: 1e13, output_tokens: 1e13, requests: 1e7, cache_read: 1e13, cache_write: 1e13 };

export function openSource(path = DEFAULT_DB) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error('未找到 token-watcher 统计库。请运行小程序中的接入命令自动准备原版并完成采集；自定义路径可用 --db 指定。');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.function('report_name', { deterministic: true }, value => String(value || '').slice(0, 60));
    const columns = db.prepare('PRAGMA table_info(events)').all();
    const missing = REQUIRED.filter(key => !columns.some(c => c.name === key));
    if (missing.length) throw new Error(`统计库结构不兼容，缺少 ${missing.join(', ')}；未修改原库，请更新适配器`);
    return db;
  } catch (err) {
    db?.close();
    throw new Error(`无法只读打开 token-watcher 数据：${err.message}`);
  }
}

/** All SELECTs share one snapshot, including committed WAL records. No upstream Store or scanner is loaded. */
export function readDays(path, { now = Date.now(), fromDay = null, costing = null } = {}) {
  const db = openSource(path);
  try {
    db.exec('BEGIN');
    const from = fromDay ? Date.parse(fromDay + 'T00:00:00+08:00') : 0;
    const rows = db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum,
      SUM(total_tokens) AS tokens, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_input) AS cache_read,
      SUM(cache_write) AS cache_write, COUNT(*) AS requests
      FROM events WHERE ts >= ? AND ts <= ? GROUP BY daynum ORDER BY daynum`).all(from, now);
    const grouped = key => db.prepare(`SELECT CAST((ts + 28800000) / 86400000 AS INTEGER) AS daynum,
      report_name(${key}) AS name, SUM(total_tokens) AS tokens FROM events
      WHERE ts >= ? AND ts <= ? AND ${key} IS NOT NULL AND ${key} != ''
      GROUP BY daynum, name ORDER BY daynum, tokens DESC, name ASC`).all(from, now);
    const models = grouped('model'), tools = grouped('tool');
    const detailMap = list => {
      const map = new Map();
      for (const r of list) {
        const items = map.get(r.daynum) || [];
        if (items.length < 8 && r.tokens > 0) items.push([String(r.name).slice(0, 60), r.tokens]);
        map.set(r.daynum, items);
      }
      return map;
    };
    const modelMap = detailMap(models), toolMap = detailMap(tools);
    const costs = costing ? costing(db, from, now) : null;
    const days = rows.map(row => {
      const day = new Date(row.daynum * 86400000).toISOString().slice(0, 10);
      for (const [key, max] of Object.entries(MAX)) {
        if (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > max)
          throw new Error(`${day} 的 ${key} 超出当前上报协议范围；已停止同步，不截断或改写原始数据`);
      }
      return { day, tokens: row.tokens, input_tokens: row.input_tokens, output_tokens: row.output_tokens, requests: row.requests, cache_read: row.cache_read, cache_write: row.cache_write,
        models: modelMap.get(row.daynum) || [], tools: toolMap.get(row.daynum) || [],
        ...(costs?.has(row.daynum) ? { cost: costs.get(row.daynum) } : {}) };
    });
    db.exec('COMMIT');
    return days;
  } finally { db.close(); }
}

export function readLegacySettings(path) {
  const db = openSource(path);
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!table) return {};
    const result = {};
    for (const key of ['rank.url', 'rank.token', 'rank.device_id']) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (row) { try { result[key] = JSON.parse(row.value); } catch {} }
    }
    return result;
  } finally { db.close(); }
}
