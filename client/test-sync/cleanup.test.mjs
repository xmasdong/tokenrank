import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneBackups, pruneDaily, BACKUP_KEEP_MS } from '../sync/cleanup.js';
import { writeConfig, readConfig } from '../sync/config.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenrank-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (rel, ageMs, now) => { const p = join(dir, rel); mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x'); const s = (now - ageMs) / 1000; utimesSync(p, s, s); return p; };
  return { dir, make };
}
const now = Date.parse('2026-10-10T00:00:00Z');

test('更新完成后只保留最新一份更新备份，超过 7 天全部清理；旧迁移库和旧程序备份一并清理', t => {
  const { dir, make } = fixture(t);
  writeConfig({ last_update: { status: 'complete' } }, dir);
  const oldUpdate = make('backups/update-1/tokenmeter.db', 3 * 86400000, now);
  const newUpdate = make('backups/update-2/tokenmeter.db', 1 * 86400000, now);
  const oldMigration = make('migrations/before-totals-1.db', BACKUP_KEEP_MS + 1000, now);
  const plist = make('migrations/legacy-agent-1.plist', BACKUP_KEEP_MS + 1000, now);
  const app1 = make('app-backup-1/keep', 30 * 86400000, now), app2 = make('app-backup-2/keep', 20 * 86400000, now);
  // directory mtimes follow their newest file
  for (const [d, a] of [['backups/update-1', 3], ['backups/update-2', 1], ['app-backup-1', 30], ['app-backup-2', 20]]) { const s = (now - a * 86400000) / 1000; utimesSync(join(dir, d), s, s); }
  const r = pruneBackups({ dir, now });
  assert.equal(existsSync(join(dir, 'backups/update-1')), false); assert.equal(existsSync(newUpdate), true);
  assert.equal(existsSync(oldMigration), false); assert.equal(existsSync(plist), true);
  assert.equal(existsSync(join(dir, 'app-backup-1')), false); assert.equal(existsSync(app2), true);
  assert.equal(r.removed.length, 3);
  const later = now + 8 * 86400000; pruneBackups({ dir, now: later });
  assert.equal(existsSync(join(dir, 'backups/update-2')), false);
});

test('上次更新未完成时不删除任何备份；后台清理每天最多一次', t => {
  const { dir, make } = fixture(t);
  writeConfig({ last_update: { status: 'rescanning' } }, dir);
  make('backups/update-1/tokenmeter.db', 30 * 86400000, now);
  const old = (now - 30 * 86400000) / 1000; utimesSync(join(dir, 'backups/update-1'), old, old);
  assert.equal(pruneBackups({ dir, now }).skipped, 'update-incomplete'); assert.equal(existsSync(join(dir, 'backups/update-1')), true);
  writeConfig({ ...readConfig(dir), last_update: { status: 'complete' } }, dir);
  assert.equal(pruneDaily({ dir, now }).removed.length, 1);
  assert.equal(pruneDaily({ dir, now: now + 3600000 }).skipped, 'recent');
});
