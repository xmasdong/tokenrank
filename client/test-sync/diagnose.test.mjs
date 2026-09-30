import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { diagnoseUpdate, formatReport } from '../../server/public/diagnose-update.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'rank-diagnose-')), dir = join(home, '.tokenrank');
  mkdirSync(dir); t.after(() => rmSync(home, { recursive: true, force: true }));
  const cutoff = Date.parse('2026-09-28T12:00:00Z'), live = join(home, 'live.db');
  const make = (file, rows) => {
    mkdirSync(join(file, '..'), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE events(ts INTEGER,tool TEXT,total_tokens INTEGER,input_tokens INTEGER,output_tokens INTEGER,cached_input INTEGER,cache_write INTEGER)');
    for (const [ts, tool, tokens] of rows) db.prepare('INSERT INTO events VALUES(?,?,?,0,0,?,0)').run(ts, tool, tokens, tokens);
    db.close(); return file;
  };
  const before = make(join(dir, 'backups', `update-${cutoff}-first`, 'tokenmeter.db'), [
    [cutoff - 1000, 'codex', 100], [cutoff - 2 * 86400000, 'dsh', 200],
  ]);
  make(join(dir, 'backups', `update-${cutoff + 10000}-second`, 'tokenmeter.db'), [[cutoff - 1000, 'codex', 150]]);
  make(live, [[cutoff - 1000, 'codex', 150], [cutoff - 2 * 86400000, 'dsh', 100],
    [cutoff + 5000, 'codex', 900000]]);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ db_path: live, token: 'private-token', device_id: 'private-device',
    last_update: { status: 'complete' } }));
  return { home, dir, cutoff, before, live, config };
}

test('read-only diagnostic chooses the earliest backup, freezes time, separates tools and never outputs credentials', t => {
  const f = fixture(t), files = [f.before, f.live, f.config], beforeBytes = files.map(file => readFileSync(file));
  const report = diagnoseUpdate({ home: f.home, now: f.cutoff + 20000 });
  assert.equal(report.backup_count, 2); assert.equal(report.periods.today.change.tokens, 50);
  assert.equal(report.periods.last_7_days.change.tokens, -50);
  assert.equal(report.periods.all.before.tokens, 300); assert.equal(report.periods.all.after.tokens, 250);
  assert.equal(report.tools.find(tool => tool.tool === 'dsh').change.tokens, -100);
  assert.equal(report.tools.find(tool => tool.tool === 'codex').change.tokens, 50);
  assert.equal(report.changed_days.length, 2);
  for (let i = 0; i < files.length; i++) assert.deepEqual(readFileSync(files[i]), beforeBytes[i]);
  const text = JSON.stringify(report);
  assert.ok(!text.includes('private-token') && !text.includes('private-device') && !text.includes(f.home));
  const rendered = formatReport(report);
  assert.match(rendered, /当日 \| 100 → 150 \| \+50/);
  assert.match(rendered, /累计 \| 300 → 250 \| -50/);
  assert.match(rendered, /共同统计截止：2026-09-28 20:00:00/);
  assert.ok(!rendered.includes('900,000') && !rendered.includes(f.home));
});

test('diagnostic refuses an active update and missing backups without changing configuration', t => {
  const f = fixture(t), config = readFileSync(f.config), lock = join(f.dir, 'update.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => diagnoseUpdate({ home: f.home, now: f.cutoff + 20000 }), /仍在运行/);
  rmSync(lock); rmSync(join(f.dir, 'backups'), { recursive: true });
  assert.throws(() => diagnoseUpdate({ home: f.home }), /没有找到更新前/);
  assert.deepEqual(readFileSync(f.config), config);
});
