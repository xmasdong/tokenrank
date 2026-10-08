import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { updateAndResync, resolveUpdate, FIXED_SOURCE, backupSource } from '../sync/update.js';
import { readConfig, writeConfig } from '../sync/config.js';
import { acquireLock } from '../sync/lock.js';
import { sync } from '../sync/report.js';
import { updateServices } from '../sync/update-services.js';

function pkg(root, version = '1.8.0') {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'token-watcher', version,
    repository: 'https://github.com/luwill/token-watcher', bin: { 'token-watcher': 'bin/tokenwatcher.js' } }));
  const entry = join(root, 'bin/tokenwatcher.js'); writeFileSync(entry, '// fixture'); return entry;
}
function fixture(t, version = '1.8.0') {
  const home = mkdtempSync(join(tmpdir(), 'rank-update-test-')), dir = join(home, '.tokenrank');
  const dbPath = join(home, '.tokenmeter/tokenmeter.db'); mkdirSync(join(home, '.tokenmeter'));
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE events(ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input INTEGER, cache_write INTEGER, total_tokens INTEGER);
    INSERT INTO events VALUES(1704110400000,'dsh','test',100,0,0,0,200);`); db.close();
  const root = join(home, 'original/node_modules/token-watcher'), entry = pkg(root, version);
  writeConfig({ server: 'https://rank.test', token: 'a'.repeat(32), device_id: 'same-device', db_path: dbPath, upstream_entry: entry }, dir);
  mkdirSync(join(dir,'app/bin'),{recursive:true});
  writeFileSync(join(dir,'app/package.json'),JSON.stringify({name:'tokenrank-client',version:'0.2.3'}));
  writeFileSync(join(dir,'app/bin/tokenrank.js'),'// previous sync');
  const bin = join(home, 'bin'), npm = join(home, 'npm/npm-cli.js'); mkdirSync(bin); mkdirSync(join(home, 'npm'));
  writeFileSync(npm, '// npm'); symlinkSync(npm, join(bin, 'npm'));
  const actions = [], bodies = [], logs = [];
  const flags = { download: false, scan: false, upload: false, restart: false };
  const collector = { name: 'collector', stop() { actions.push('stop-core'); }, start() { actions.push('start-core'); }, check() { return !flags.restart; } };
  const syncService = { name: 'sync', stop() { actions.push('stop-sync'); }, start() { actions.push('start-sync'); } };
  const options = { home, dir, path: bin, platform: 'linux', log: s => logs.push(s), sleep: async () => {},
    services: () => ({ collector: [collector], sync: [syncService] }), stopped: () => actions.push('assert-stopped'),
    fetcher: async () => Response.json({ name: 'token-watcher', version: '1.8.1' }),
    runner(command, args) {
      if (args.includes('install')) {
        actions.push('download'); if (flags.download) throw new Error('download failed');
        assert.equal(args.at(-1), FIXED_SOURCE); assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--install-strategy=nested'));
        pkg(join(args[args.indexOf('--prefix') + 1], 'node_modules/token-watcher'), '1.8.3'); return '';
      }
      if (args.some(arg => arg.endsWith('/rebuild-worker.js'))) {
        actions.push('scan'); assert.equal(acquireLock(dir, 'sync'), null);
        if (flags.scan) throw new Error('scan failed');
        assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, version === '1.9.0' ? '1.9.0' : '1.8.3');
        const source = new DatabaseSync(args.at(-1)); source.exec('UPDATE events SET total_tokens=100'); source.close(); return '';
      }
      return '';
    },
    async upload(args) {
      actions.push('upload'); assert.equal(args.full, true); assert.equal(acquireLock(dir, 'sync'), null);
      return sync({ ...args, fetcher: async (url, opts) => {
        if (url.endsWith('/report/capabilities')) return Response.json({atomic_replace:1});
        assert.equal(url, 'https://rank.test/report');
        if (flags.upload) return new Response('', { status: 503 });
        const body = JSON.parse(opts.body); bodies.push(body); return Response.json({ ok: true, accepted: body.days.length, committed: body.complete });
      } });
    },
  };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, dir, dbPath, root, entry, options, actions, bodies, flags, logs };
}

test('latest resolver uses released fixes; older npm latest uses immutable merged official commit; failures do not silently downgrade', async () => {
  for (const version of ['1.8.1', '1.8.2'])
    assert.equal((await resolveUpdate(async () => Response.json({ name: 'token-watcher', version }))).spec, FIXED_SOURCE);
  for (const version of ['1.8.3', '1.10.0', '2.0.0'])
    assert.equal((await resolveUpdate(async () => Response.json({ name: 'token-watcher', version }))).spec, `token-watcher@${version}`);
  await assert.rejects(resolveUpdate(async () => new Response('', { status: 503 })), /503/);
  await assert.rejects(resolveUpdate(async () => Response.json({ name: 'other', version: '1.8.3' })), /无效/);
});

test('explicit update backs up old totals, upgrades and restarts, uploads reduced historical totals with same account/device', async t => {
  const f = fixture(t);
  const menuBar = join(f.root, 'bin/token-watcher.app/Contents'); mkdirSync(menuBar, { recursive: true });
  writeFileSync(join(menuBar, 'original-binary'), 'preserve-existing-menu-bar');
  const result = await updateAndResync(f.options);
  assert.equal(result.version, '1.8.3'); assert.equal(result.accepted, 1);
  assert.deepEqual(f.actions, ['download', 'stop-sync', 'stop-core', 'assert-stopped', 'scan', 'start-core', 'upload', 'start-sync']);
  assert.equal(f.bodies[0].full, true); assert.equal(f.bodies[0].complete, true);
  assert.equal(f.bodies[0].days[0].tokens, 100); assert.equal(f.bodies[0].device_id, 'same-device');
  const c = readConfig(f.dir); assert.equal(c.token, 'a'.repeat(32)); assert.equal(c.last_update.status, 'complete');
  assert.equal(JSON.parse(readFileSync(join(f.dir,'app/package.json'))).version,'0.2.12');
  assert.equal(readFileSync(join(c.last_update.adapter_backup,'bin/tokenrank.js'),'utf8'),'// previous sync');
  const backup = new DatabaseSync(c.last_update.backup, { readOnly: true });
  assert.equal(backup.prepare('SELECT SUM(total_tokens) t FROM events').get().t, 200); backup.close();
  assert.equal(JSON.parse(readFileSync(join(c.last_update.package_backup, 'package.json'))).version, '1.8.0');
  assert.equal(readFileSync(join(menuBar, 'original-binary'), 'utf8'), 'preserve-existing-menu-bar');
  assert.ok(f.logs.every(line => !line.includes(c.token)));
  f.actions.length = 0;
  await updateAndResync(f.options); assert.equal(f.actions.includes('download'), false); assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[1].days[0].tokens, 100);
});

test('install checks upgrade a statistically valid 1.8.2 collector to the reliability release', async t => {
  const f = fixture(t, '1.8.2');
  const result = await updateAndResync({ ...f.options, onlyIfOutdated: true });
  assert.equal(result.version, '1.8.3');
  assert.equal(f.actions.includes('download'), true);
  assert.equal(f.bodies.length, 1);
  assert.equal(readConfig(f.dir).last_update.status, 'complete');
});

test('install checks query latest every time, skip current/newer versions, and notice future releases', async t => {
  const f = fixture(t, '1.8.3');
  let queries = 0, latest = '1.8.3';
  const options = { ...f.options, onlyIfOutdated: true,
    fetcher: async () => { queries++; return Response.json({ name: 'token-watcher', version: latest }); } };
  assert.equal((await updateAndResync(options)).skipped, 'up-to-date');
  pkg(f.root, '1.9.0');
  assert.equal((await updateAndResync(options)).version, '1.9.0');
  assert.deepEqual(f.actions, []);
  // Prove a later stable release reaches the download step without modifying the fixture package.
  latest = '1.10.0'; f.flags.download = true;
  await assert.rejects(updateAndResync(options), /download failed/);
  assert.equal(queries, 3);
  assert.deepEqual(f.actions, ['download']);
});

test('latest lookup failure never claims current or changes services/data', async t => {
  const f = fixture(t, '1.8.3'), before = readFileSync(f.dbPath);
  await assert.rejects(updateAndResync({ ...f.options, onlyIfOutdated: true,
    fetcher: async () => new Response('', { status: 503 }) }), /503/);
  assert.deepEqual(f.actions, []); assert.deepEqual(readFileSync(f.dbPath), before);
  assert.ok(f.logs.every(line => !line.includes('无需重复')));
});

test('rerunning install retries an interrupted rebuild even after the collector package was upgraded', async t => {
  const f = fixture(t); f.flags.scan = true;
  await assert.rejects(updateAndResync({ ...f.options, onlyIfOutdated: true }), /scan failed/);
  f.flags.scan = false; f.actions.length = 0;
  const result = await updateAndResync({ ...f.options, onlyIfOutdated: true });
  assert.equal(result.version, '1.8.3'); assert.equal(f.actions.includes('download'), false);
  assert.equal(f.actions.includes('scan'), true); assert.equal(f.bodies.length, 1);
});

test('download failure leaves services, source and package untouched', async t => {
  const f = fixture(t); f.flags.download = true;
  const before = readFileSync(f.dbPath);
  await assert.rejects(updateAndResync(f.options), /download failed/);
  assert.deepEqual(f.actions, ['download']); assert.deepEqual(readFileSync(f.dbPath), before);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '1.8.0');
  const release = acquireLock(f.dir, 'update'); assert.equal(typeof release, 'function'); release();
});

test('scan failure never uploads or restarts background sync; repeated command repairs and resumes', async t => {
  const f = fixture(t); f.flags.scan = true;
  const before = readFileSync(f.dbPath);
  await assert.rejects(updateAndResync(f.options), /scan failed/);
  assert.deepEqual(readFileSync(f.dbPath),before);
  assert.equal(f.actions.includes('upload'), false); assert.equal(f.actions.includes('start-sync'), false);
  assert.equal(f.actions.at(-1), 'start-core'); assert.ok(existsSync(readConfig(f.dir).last_update.backup));
  f.flags.scan = false; await updateAndResync(f.options);
  assert.equal(f.actions.at(-1), 'start-sync'); assert.equal(f.bodies.length, 1);
});

test('server failure never claims success; corrected collector/sync resume and full upload retries', async t => {
  const f = fixture(t); f.flags.upload = true;
  await assert.rejects(updateAndResync(f.options), /503/);
  assert.equal(readConfig(f.dir).replace_pending,true);
  assert.equal(f.actions.at(-1), 'start-sync'); assert.ok(f.logs.every(line => !line.includes('更新与回传完成')));
  f.flags.upload = false; await updateAndResync(f.options); assert.equal(f.bodies.length, 1);
  assert.equal(readConfig(f.dir).replace_pending,false);
});

test('background sync restart failure surfaces an error instead of the success message', async t => {
  const f = fixture(t), plans = f.options.services();
  plans.sync[0].start = () => { throw new Error('service unavailable'); };
  f.options.services = () => plans;
  await assert.rejects(updateAndResync(f.options), /恢复同步服务/);
  assert.equal(f.bodies.length, 1); assert.ok(f.logs.every(line => !line.includes('更新与回传完成')));
});

test('failed collector restart does not report a successful update or make the full upload', async t => {
  const f = fixture(t); f.flags.restart = true;
  await assert.rejects(updateAndResync(f.options), /尚未启动成功/);
  assert.equal(f.actions.includes('upload'), false);
});

test('newer installed stable collector is not downgraded; existing sync lock prevents all service mutations', async t => {
  const f = fixture(t, '1.9.0'); await updateAndResync(f.options);
  assert.equal(f.actions.includes('download'), false); assert.equal(readConfig(f.dir).upstream_version, '1.9.0');
  f.actions.length = 0; const release = acquireLock(f.dir, 'sync');
  await assert.rejects(updateAndResync(f.options), /同步仍在运行/); release();
  assert.deepEqual(f.actions, []);
});

test('an unaccounted manual watcher prevents rescan and all stopped services are restored', async t => {
  const f = fixture(t, '1.9.0');
  writeFileSync(join(f.dir, 'watch.lock'), JSON.stringify({ pid: process.pid, nonce: 'manual-watcher' }));
  await assert.rejects(updateAndResync(f.options), /手动启动的同步器/);
  assert.equal(f.actions.includes('scan'), false); assert.equal(f.actions.includes('upload'), false);
  assert.deepEqual(f.actions.slice(-2), ['start-core', 'start-sync']);
});

test('SQLite backup includes committed WAL and does not alter original records', t => {
  const f = fixture(t), db = new DatabaseSync(f.dbPath);
  db.exec('PRAGMA journal_mode=WAL; INSERT INTO events SELECT * FROM events');
  const file = join(f.home, 'backup.db'); backupSource(f.dbPath, file);
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT SUM(total_tokens) t FROM events').get().t, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 2); copy.close(); db.close();
});

test('macOS service validation preserves original plist and refuses unrelated executable before stopping', t => {
  const f = fixture(t), launch = join(f.home, 'Library/LaunchAgents'); mkdirSync(launch, { recursive: true });
  const syncEntry = join(f.dir, 'app/bin/tokenrank.js'); mkdirSync(join(f.dir, 'app/bin'), { recursive: true });
  writeFileSync(syncEntry, '// sync'); writeFileSync(join(f.dir, 'app/package.json'), '{"name":"tokenrank-client"}');
  for (const label of ['com.tokenwatcher.server', 'com.tokenrank.sync']) writeFileSync(join(launch, label + '.plist'), label);
  const calls = []; let unrelated = false;
  const runner = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'plutil') { const label = readFileSync(args.at(-1), 'utf8'); return JSON.stringify({ Label: label,
      ProgramArguments: ['node', label.endsWith('.sync') ? syncEntry : unrelated ? '/unknown/program' : f.entry, label.endsWith('.sync') ? 'watch' : 'serve'] }); }
    return 'pid = 123';
  };
  const options = { home: f.home, dir: f.dir, platform: 'darwin', found: { entry: f.entry }, runner };
  const result = updateServices(options); assert.equal(result.collector.length, 1); assert.equal(result.sync.length, 1);
  result.collector[0].stop(); assert.ok(calls.some(([cmd, args]) => cmd === 'launchctl' && args[0] === 'bootout'));
  assert.equal(readFileSync(join(launch, 'com.tokenwatcher.server.plist'), 'utf8'), 'com.tokenwatcher.server');
  unrelated = true; assert.throws(() => updateServices(options), /无法确认/);
});

function macServicesFixture(f, configs, activeLabels) {
  const launch = join(f.home, 'Library/LaunchAgents'); mkdirSync(launch, { recursive: true });
  const syncEntry = join(f.dir, 'app/bin/tokenrank.js'); mkdirSync(join(f.dir, 'app/bin'), { recursive: true });
  writeFileSync(syncEntry, '// sync'); writeFileSync(join(f.dir, 'app/package.json'), '{"name":"tokenrank-client"}');
  configs['com.tokenrank.sync'] = { ProgramArguments: ['node', syncEntry, 'watch'] };
  const active = new Set([...activeLabels, 'com.tokenrank.sync']), calls = [], logs = [];
  for (const [label, config] of Object.entries(configs)) writeFileSync(join(launch, label + '.plist'), JSON.stringify({ Label: label, ...config }));
  const runner = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'plutil') return readFileSync(args.at(-1), 'utf8');
    const label = args.at(-1).split('/').at(-1).replace(/\.plist$/, '');
    if (args[0] === 'print') {
      if (!active.has(label)) { const error = new Error('not loaded'); error.status = 113; throw error; }
      return 'pid = 123';
    }
    if (args[0] === 'bootout') active.delete(label);
    if (args[0] === 'bootstrap') active.add(label);
    return '';
  };
  return { runner, calls, logs, options: { home: f.home, dir: f.dir, platform: 'darwin', found: { entry: f.entry }, runner, log: line => logs.push(line) } };
}

test('reported token-stats source launch is chosen over a cached npm install; legacy label and default serve work', t => {
  const f = fixture(t), root = join(f.home, 'Vibing/token-stats'), entry = pkg(root, '1.8.3');
  mkdirSync(join(root, '.git'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
  manifest.bin = { tokenwatcher: 'bin/tokenwatcher.js', tokenmeter: 'bin/tokenwatcher.js' };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  for (const suffix of [['serve'], [], ['--port', '9001', '--no-open']]) {
    const m = macServicesFixture(f, { 'com.tokenmeter.server': { ProgramArguments: ['/usr/local/bin/node', '--no-warnings', entry, ...suffix] } }, ['com.tokenmeter.server']);
    const plan = updateServices(m.options);
    assert.equal(plan.found.version, '1.8.3'); assert.equal(plan.collector[0].name, 'com.tokenmeter.server');
    const before = readFileSync(join(f.home, 'Library/LaunchAgents/com.tokenmeter.server.plist'));
    plan.collector[0].stop(); plan.collector[0].start(); assert.equal(plan.collector[0].check(), true);
    assert.deepEqual(readFileSync(join(f.home, 'Library/LaunchAgents/com.tokenmeter.server.plist')), before);
  }
});

test('a stale inactive plist cannot block or be resurrected by updating the verified active collector', t => {
  const f = fixture(t), m = macServicesFixture(f, {
    'com.tokenwatcher.server': { ProgramArguments: ['node', f.entry, 'serve'] },
    'com.tokenmeter.server': { ProgramArguments: ['node', '/removed/token-stats/bin/tokenwatcher.js', 'serve'] },
  }, ['com.tokenwatcher.server']);
  const plan = updateServices(m.options); assert.equal(plan.collector.length, 1);
  plan.collector[0].stop(); plan.collector[0].start();
  assert.ok(m.calls.filter(([cmd, args]) => cmd === 'launchctl' && args[0] !== 'print').every(([, args]) => !args.at(-1).includes('com.tokenmeter.server')));
  const activeUnknown = macServicesFixture(f, {
    'com.tokenwatcher.server': { ProgramArguments: ['node', f.entry, 'serve'] },
    'com.tokenmeter.server': { ProgramArguments: ['node', '/unknown/server.js', 'serve'] },
  }, ['com.tokenwatcher.server', 'com.tokenmeter.server']);
  assert.throws(() => updateServices(activeUnknown.options), /无法确认/);
});

test('macOS permission failures are not mistaken for an unloaded legacy service; non-server CLI is rejected', t => {
  const f = fixture(t), configs = { 'com.tokenmeter.server': { ProgramArguments: ['node', f.entry, 'scan'] } };
  const m = macServicesFixture(f, configs, ['com.tokenmeter.server']);
  assert.throws(() => updateServices(m.options), /无法确认/);
  const runner = (cmd, args) => { if (cmd === 'launchctl') { const e = new Error('permission'); e.status = 1; throw e; } return m.runner(cmd, args); };
  assert.throws(() => updateServices({ ...m.options, runner }), /运行状态/);
});

test('already fixed source checkout rescans without replacing source; outdated source remains untouched', async t => {
  const f = fixture(t, '1.8.3'); mkdirSync(join(f.root, '.git'));
  await updateAndResync(f.options); assert.equal(f.actions.includes('download'), false); assert.equal(f.bodies.length, 1);
  f.actions.length = 0; pkg(f.root, '1.8.0');
  await assert.rejects(updateAndResync(f.options), /按原方式升级/);
  assert.deepEqual(f.actions, []);
});

test('maintenance rescans and remembers the active source checkout, leaving an older cached install untouched', async t => {
  const f = fixture(t), root = join(f.home, 'Vibing/token-stats'), entry = pkg(root, '1.8.3');
  mkdirSync(join(root, '.git'));
  const m = macServicesFixture(f, { 'com.tokenmeter.server': {
    ProgramArguments: ['/usr/local/bin/node', '--no-warnings', entry, 'serve'],
  } }, ['com.tokenmeter.server']);
  const result = await updateAndResync({ ...f.options, platform: 'darwin', services: updateServices,
    runner(command, args) {
      if (['plutil', 'launchctl'].includes(command)) return m.runner(command, args);
      if (args.some(arg => arg.endsWith('/rebuild-worker.js'))) {
        assert.equal(args.at(-2), realpathSync(root)); assert.notEqual(args.at(-1), realpathSync(f.dbPath));
        f.actions.push('scan');
        const db = new DatabaseSync(args.at(-1)); db.exec('UPDATE events SET total_tokens=100'); db.close(); return '';
      }
      return f.options.runner(command, args);
    },
  });
  assert.equal(result.version, '1.8.3'); assert.equal(f.bodies[0].days[0].tokens, 100);
  const config = readConfig(f.dir);
  assert.equal(config.upstream_entry, realpathSync(entry)); assert.equal(config.last_update.package_backup, null);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '1.8.0');
  assert.equal(existsSync(join(root, '.git')), true); assert.equal(f.actions.includes('download'), false);
});

test('two loaded collectors are refused before any service or database mutation', t => {
  const f = fixture(t), other = pkg(join(f.home, 'other-original'), '1.8.3');
  const m = macServicesFixture(f, {
    'com.tokenwatcher.server': { ProgramArguments: ['node', f.entry, 'serve'] },
    'com.tokenmeter.server': { ProgramArguments: ['node', other, 'serve'] },
  }, ['com.tokenwatcher.server', 'com.tokenmeter.server']);
  assert.throws(() => updateServices(m.options), /两套同时加载/);
  assert.ok(m.calls.every(([cmd, args]) => cmd === 'plutil' || args[0] === 'print'));
});

test('Windows update verifies the exact scheduled task and script before stopping collector or sync', t => {
  const f = fixture(t), syncEntry = join(f.dir, 'app/bin/tokenrank.js');
  mkdirSync(join(f.dir, 'app/bin'), { recursive: true }); writeFileSync(syncEntry, '// sync');
  writeFileSync(join(f.dir, 'app/package.json'), '{"name":"tokenrank-client"}');
  const vbs = join(f.home, 'AppData/Local/TokenWatcher/collector.vbs'); mkdirSync(join(vbs, '..'), { recursive: true });
  writeFileSync(vbs, '\uFEFF' + f.entry, 'utf16le'); writeFileSync(join(f.dir, 'sync.vbs'), syncEntry);
  const calls = []; let unrelated = false;
  const runner = (cmd, args) => {
    assert.equal(cmd, 'powershell.exe'); const script = args.at(-1); calls.push(script);
    if (script.includes('ConvertTo-Json')) return JSON.stringify({ Execute: 'wscript.exe',
      Arguments: `"${unrelated ? 'unrelated.vbs' : script.includes('TokenWatcherForTokenRank') ? vbs : join(f.dir, 'sync.vbs')}"` });
    if (script.endsWith('.Count')) return '1'; return '';
  };
  const options = { home: f.home, dir: f.dir, platform: 'win32', found: { entry: f.entry }, runner };
  const plans = updateServices(options); plans.collector[0].stop(); plans.collector[0].start();
  assert.equal(plans.collector[0].check(), true); plans.sync[0].stop(); plans.sync[0].start();
  assert.ok(calls.some(c => c.includes('Stop-ScheduledTask') && c.includes(f.entry)));
  assert.ok(calls.some(c => c.includes("Start-ScheduledTask -TaskName 'TokenRankSync'")));
  assert.ok(calls.every(c => !/Unregister-ScheduledTask|Register-ScheduledTask|ExecutionPolicy/.test(c)));
  unrelated = true; assert.throws(() => updateServices(options), /归属/);
});

test('Linux update checks the effective unit executable and preserves both unit files', t => {
  const f = fixture(t), syncEntry = join(f.dir, 'app/bin/tokenrank.js'), unitDir = join(f.home, '.config/systemd/user');
  mkdirSync(join(f.dir, 'app/bin'), { recursive: true }); writeFileSync(syncEntry, '// sync');
  writeFileSync(join(f.dir, 'app/package.json'), '{"name":"tokenrank-client"}'); mkdirSync(unitDir, { recursive: true });
  const entries = { 'token-watcher-for-tokenrank.service': f.entry, 'tokenrank-sync.service': syncEntry };
  for (const [name, entry] of Object.entries(entries)) writeFileSync(join(unitDir, name), `[Service]\nExecStart="node" "${entry}"\n`);
  const calls = []; let unrelated = false;
  const runner = (cmd, args) => { calls.push([cmd, args]); return args.includes('show') ? unrelated ? '/unrelated' : entries[args[2]] : ''; };
  const options = { home: f.home, dir: f.dir, platform: 'linux', found: { entry: f.entry }, runner };
  const plans = updateServices(options); plans.collector[0].stop(); plans.collector[0].start();
  assert.equal(plans.collector[0].check(), true); plans.sync[0].stop(); plans.sync[0].start();
  assert.ok(calls.every(([cmd]) => cmd === 'systemctl'));
  assert.match(readFileSync(join(unitDir, 'tokenrank-sync.service'), 'utf8'), /ExecStart/);
  unrelated = true; assert.throws(() => updateServices(options), /实际配置/);
});

test('rescan helper treats upstream swallowed parse errors as failure, without logging raw session paths', t => {
  const f = fixture(t), root = join(f.home, 'scan-fixture'); mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'src/store.js'), 'export class Store {close(){}}');
  writeFileSync(join(root, 'src/scanner.js'), 'export class Scanner {stats={dsh:{parse_errors:1,last_error:"private-session-path"}};async scanAll(){return {files:1}}}');
  const result = spawnSync(process.execPath, ['--no-warnings', new URL('../sync/rescan-worker.js', import.meta.url).pathname, root, f.dbPath], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /1 个文件扫描失败/); assert.doesNotMatch(result.stderr, /private-session-path/);
});
