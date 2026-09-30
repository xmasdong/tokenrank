import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
export function acquireLock(dir, name) {
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('同步器目录不能是符号链接');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}.lock`), nonce = crypto.randomUUID();
  const own = JSON.stringify({ pid: process.pid, nonce });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, own, { flag: 'wx', mode: 0o600 });
      return () => { try { if (readFileSync(file, 'utf8') === own) rmSync(file); } catch {} };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let old;
      try { old = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('同步锁正在初始化或异常，请稍后重试'); }
      if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error('同步锁无效，请检查 ~/.tokenrank');
      try { process.kill(old.pid, 0); return null; }
      catch (check) { if (check.code !== 'ESRCH') return null; }
      if (readFileSync(file, 'utf8') === JSON.stringify(old)) rmSync(file);
    }
  }
  return null;
}
