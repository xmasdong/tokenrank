// Explicit maintenance only. The ordinary upload loop never imports writable upstream modules.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeScanErrors } from './scan-errors.js';
const [root, dbPath] = process.argv.slice(2);
try {
  const { Store } = await import(pathToFileURL(join(root, 'src/store.js')).href);
  const { Scanner } = await import(pathToFileURL(join(root, 'src/scanner.js')).href);
  const store = new Store(dbPath);
  try {
    const scanner = new Scanner(store); // Never log raw session paths or conversation content.
    const result = await scanner.scanAll(); // Upstream collector versions trigger historical migrations.
    const failed = describeScanErrors(scanner.stats);
    if (failed) throw new Error(`${failed.text}，尚未回传；请修复源文件访问或解析问题后重跑更新命令`);
    console.log(JSON.stringify({ ok: true, files: result.files }));
  } finally { store.close(); }
} catch (err) { console.error(err.message); process.exitCode = 1; }
