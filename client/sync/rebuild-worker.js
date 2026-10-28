// Explicit repair only: rebuild derived records in a COPY, using unmodified upstream collectors.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describeScanErrors } from './scan-errors.js';
const [root, dbPath] = process.argv.slice(2);
try {
  const { Store } = await import(pathToFileURL(join(root,'src/store.js')).href);
  const { Scanner } = await import(pathToFileURL(join(root,'src/scanner.js')).href);
  const { SOURCES } = await import(pathToFileURL(join(root,'src/config.js')).href);
  const sources = SOURCES.filter(source => source.collector && source.kind !== 'poller');
  if (!sources.length) throw new Error('原版未提供可重建的数据源，未替换原库');
  const store = new Store(dbPath);
  let timer;
  try {
    for (const source of sources) {
      const count = store.db.prepare('SELECT COUNT(*) n FROM events WHERE tool=?').get(source.tool).n;
      if (count && !source.roots.some(path => existsSync(path)))
        throw new Error(`${source.tool} 的原始日志目录不可用，未替换原库或云端数据`);
    }
    const names = [...new Set(sources.map(source => source.tool))], slots = names.map(() => '?').join(',');
    store.db.exec('BEGIN');
    try {
      for (const table of ['events','files','tool_calls','credit_usage'])
        store.db.prepare(`DELETE FROM ${table} WHERE tool IN (${slots})`).run(...names);
      store.db.exec('COMMIT');
    } catch (err) { store.db.exec('ROLLBACK'); throw err; }
    const scanner = new Scanner(store);
    const start = Date.now();
    timer = setInterval(() => {
      const files = Object.values(scanner.stats).reduce((n, s) => n + (s.files || 0), 0);
      console.log(`[tokenrank] 重建仍在进行：已处理 ${files} 个文件，用时 ${Math.round((Date.now()-start)/1000)} 秒…`);
    }, 15000);
    const result = await scanner.scanAll();
    const failed = describeScanErrors(scanner.stats);
    if (failed) throw new Error(`${failed.text}，未替换原库或云端数据；请检查原版采集状态`);
    // token-watcher 1.8 keeps a one-time Codex key migration archive keyed by row id. The Codex rows it
    // points at were deleted above and rescanned under new ids, so it can no longer restore anything,
    // yet it is most of the database and is copied into every daily snapshot. The pre-update database
    // stays in the update backup.
    if (names.includes('codex')) store.db.exec('DROP TABLE IF EXISTS codex_key_migration_backup');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log(`[tokenrank] 现存日志重建完成：${result.files} 个文件。`);
  } finally { clearInterval(timer); store.close(); }
} catch (err) { console.error(err.message); process.exitCode = 1; }
