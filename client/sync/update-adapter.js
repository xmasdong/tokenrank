import { readFileSync, existsSync, mkdtempSync, cpSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function stageAdapter(dir, source = resolve(import.meta.dirname,'..')) {
  const pkg = JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  const app = join(dir,'app');
  if (pkg.name !== 'tokenrank-client' || !existsSync(join(source,'sync/rebuild-worker.js')))
    throw new Error('更新包不完整，未更改现有程序');
  if (lstatSync(app).isSymbolicLink() || JSON.parse(readFileSync(join(app,'package.json'),'utf8')).name !== 'tokenrank-client')
    throw new Error('无法确认现有同步器目录，未替换');
  const installed = JSON.parse(readFileSync(join(app,'package.json'),'utf8')).version;
  if (/^\d+\.\d+\.\d+$/.test(installed || '')) {
    const old = installed.split('.').map(Number), next = pkg.version.split('.').map(Number);
    for (let i=0;i<3;i++) { if (old[i]>next[i]) throw new Error('本机同步脚本较新，请使用最新更新命令；未降级'); if(old[i]<next[i])break; }
  }
  const stage = mkdtempSync(join(dir,'app-update-'));
  try {
    for (const path of ['bin','sync','package.json','README.md','LICENSE']) cpSync(join(source,path),join(stage,path),{recursive:true});
  } catch (err) { rmSync(stage,{recursive:true,force:true}); throw err; }
  return { version: pkg.version, stage,
    install() {
      const backup = join(dir,`app-backup-${Date.now()}-${crypto.randomUUID().slice(0,8)}`);
      renameSync(app,backup);
      try { renameSync(stage,app); } catch (err) { renameSync(backup,app); throw err; }
      return backup;
    },
    cleanup() { rmSync(stage,{recursive:true,force:true}); },
  };
}

export function activateRebuild(rebuilt, dbPath, backupDir) {
  const db = new DatabaseSync(dbPath);
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw new Error('仍有进程占用统计库，未替换数据库');
  } finally { db.close(); }
  const original = join(backupDir,'original-database.db'), moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath+suffix)) {
      renameSync(dbPath+suffix,original+suffix); moved.push(suffix);
    }
    renameSync(rebuilt,dbPath);
  } catch (err) {
    for (const suffix of moved.reverse()) renameSync(original+suffix,dbPath+suffix);
    throw err;
  }
}
