import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, writeConfig, SYNC_DIR } from './config.js';

export const BACKUP_KEEP_MS = 7 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

// Full database copies are only for recovering a failed update. Once the last update completed,
// keep the newest backup for a week and remove everything older; never touch anything while an
// update is incomplete.
export function pruneBackups({ dir = SYNC_DIR, now = Date.now(), log = () => {} } = {}) {
  const config = readConfig(dir);
  if (config.last_update && config.last_update.status !== 'complete') return { skipped: 'update-incomplete', removed: [] };
  const removed = [];
  const remove = path => { rmSync(path, { recursive: true, force: true }); removed.push(path); };
  const age = path => now - statSync(path).mtimeMs;

  const backups = join(dir, 'backups');
  if (existsSync(backups)) {
    const updates = readdirSync(backups).filter(n => n.startsWith('update-')).map(n => join(backups, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    updates.forEach((path, i) => { if (i > 0 || age(path) > BACKUP_KEEP_MS) remove(path); });
  }
  const migrations = join(dir, 'migrations');
  if (existsSync(migrations)) {
    for (const n of readdirSync(migrations)) if (n.endsWith('.db') || n.includes('.db-')) {
      const path = join(migrations, n);
      if (age(path) > BACKUP_KEEP_MS) remove(path);
    }
  }
  const apps = readdirSync(dir).filter(n => n.startsWith('app-backup-')).map(n => join(dir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  apps.forEach((path, i) => { if (i > 0 && age(path) > BACKUP_KEEP_MS) remove(path); });

  if (removed.length) log(`已清理 ${removed.length} 个过期备份`);
  return { removed };
}

/** Called from the background loop; runs at most once a day. */
export function pruneDaily({ dir = SYNC_DIR, now = Date.now(), log } = {}) {
  const config = readConfig(dir);
  if (config.last_prune_at && now - config.last_prune_at < DAY_MS) return { skipped: 'recent', removed: [] };
  const result = pruneBackups({ dir, now, log });
  writeConfig({ ...readConfig(dir), last_prune_at: now }, dir);
  return result;
}
