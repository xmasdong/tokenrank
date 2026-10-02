import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareUpstream, startPreparedUpstream, inspectUpstream, findUpstream, upstreamPrefix, UPSTREAM_VERSION, FIXED_SOURCE, collectorOutdated } from '../sync/upstream.js';
import { readConfig, writeConfig } from '../sync/config.js';

function pkg(root, name='token-watcher', version='1.8.0') {
  mkdirSync(join(root,'bin'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name,version,repository:{url:'git+https://github.com/luwill/token-watcher.git'},bin:{'token-watcher':'bin/tokenwatcher.js'}}));
  const entry=join(root,'bin/tokenwatcher.js');writeFileSync(entry,'// fixture only; never execute');return entry;
}
function source(path, compatible=true) {
  mkdirSync(join(path,'..'),{recursive:true});const db=new DatabaseSync(path);
  db.exec(compatible?'CREATE TABLE events(ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input INTEGER, cache_write INTEGER, total_tokens INTEGER)':'CREATE TABLE incompatible(id INTEGER)');db.close();
}
function fixture(t, platform='linux') {
  const home=mkdtempSync(join(tmpdir(),'tokenrank-bootstrap-test-')),dir=join(home,'.tokenrank'),bin=join(home,'bin');
  mkdirSync(bin);const npm=join(home,'npm/bin/npm-cli.js');mkdirSync(join(npm,'..'),{recursive:true});writeFileSync(npm,'// npm fixture');
  symlinkSync(npm,join(bin,'npm'));const prefix=upstreamPrefix(home,platform),db=join(home,'.tokenmeter/tokenmeter.db');
  const calls=[];let failInstall=false,failScan=false,failService=false,latest='1.8.3';const fetches=[];
  const runner=(command,args)=>{
    calls.push({command,args});
    if(args.includes('root'))return join(home,'global/node_modules');
    if(args.includes('install')) {if(failInstall)throw new Error('npm failed');pkg(join(prefix,'node_modules/token-watcher'),'token-watcher',args.at(-1).startsWith('https://codeload')?'1.8.3':latest);return '';}
    if(args.includes('scan')){if(failScan)throw new Error('scan failed');if(!existsSync(db))source(db);return '';}
    if(command==='launchctl'&&args[0]==='print')throw new Error('not loaded');
    if(failService)throw new Error('service unavailable');
    return '';
  };
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const fetcher=async url=>{fetches.push(url);return Response.json({name:'token-watcher',version:latest});};
  const options={home,dir,platform,path:bin,runner,fetcher,log(){}};
  return {home,dir,bin,prefix,db,calls,fetches,options,setLatest:v=>{latest=v;},setFail:(kind,value)=>{if(kind==='install')failInstall=value;if(kind==='scan')failScan=value;if(kind==='service')failService=value;}};
}

test('existing original is reused without npm install, scan, version change or service mutations',async t=>{
  const f=fixture(t);const entry=pkg(join(f.home,'original'),'token-watcher','1.9.0');symlinkSync(entry,join(f.bin,'token-watcher'));source(f.db);
  const before=readFileSync(f.db),manifest=readFileSync(join(f.home,'original/package.json'));
  const result=await prepareUpstream(f.options);assert.equal(result.version,'1.9.0');assert.equal(result.managed,false);
  assert.deepEqual(startPreparedUpstream(f.options),{reused:true});assert.equal(f.calls.length,0);
  assert.deepEqual(readFileSync(f.db),before);assert.deepEqual(readFileSync(join(f.home,'original/package.json')),manifest);
});

test('official legacy tokenwatcher/tokenmeter bin names retain repository identity checks', async t => {
  const f = fixture(t), root = join(f.home, 'token-stats'), entry = pkg(root);
  for (const alias of ['tokenwatcher', 'tokenmeter']) {
    const manifest = { name: 'token-watcher', version: '1.3.0', repository: 'https://github.com/luwill/token-watcher', bin: { [alias]: 'bin/tokenwatcher.js' } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    assert.equal(inspectUpstream(entry).version, '1.3.0');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, repository: 'https://github.com/unrelated/token-watcher' }));
    assert.equal(inspectUpstream(entry), null);
  }
});

test('missing original installs pinned official package in user scope, scans then starts; rerun is idempotent',async t=>{
  const f=fixture(t);const result=await prepareUpstream(f.options);
  assert.equal(result.managed,true);assert.equal(result.version,UPSTREAM_VERSION);
  const install=f.calls.find(x=>x.args.includes('install'));assert.ok(install);assert.ok(install.args.includes('--prefix'));assert.ok(install.args.includes('token-watcher@1.8.3'));assert.ok(install.args.includes('https://registry.npmjs.org/'));assert.equal(install.args.includes('-g'),false);
  assert.equal(f.calls.filter(x=>x.args.includes('scan')).length,1);
  assert.deepEqual(startPreparedUpstream(f.options),{started:true});
  assert.ok(existsSync(join(f.home,'.config/systemd/user/token-watcher-for-tokenrank.service')));
  const count=f.calls.length;await prepareUpstream(f.options);startPreparedUpstream(f.options);assert.equal(f.calls.length,count);
  assert.ok(readConfig(f.dir).upstream_entry.endsWith('bin/tokenwatcher.js'));
});

test('database alone or legacy fork alias is not mistaken for an original package',async t=>{
  const f=fixture(t);source(f.db);const old=pkg(join(f.home,'old'),'tokenrank-client','0.1.0');symlinkSync(old,join(f.bin,'token-watcher'));
  assert.equal(inspectUpstream(old),null);
  const result=await prepareUpstream(f.options);assert.equal(result.managed,true);assert.ok(f.calls.some(x=>x.args.includes('install')));
  assert.equal(readFileSync(old,'utf8'),'// fixture only; never execute');
});

test('global npm package is found even without its command on PATH',async t=>{
  const f=fixture(t);pkg(join(f.home,'global/node_modules/token-watcher'));source(f.db);
  const result=await prepareUpstream(f.options);assert.equal(result.managed,false);
  assert.equal(f.calls.filter(x=>x.args.includes('install')).length,0);assert.equal(f.calls.filter(x=>x.args.includes('root')).length,1);
});

test('incompatible source stops before invoking install or native data migrations',async t=>{
  const f=fixture(t);source(f.db,false);const before=readFileSync(f.db);
  await assert.rejects(()=>prepareUpstream(f.options),/不兼容/);assert.equal(f.calls.length,0);assert.deepEqual(readFileSync(f.db),before);
});

test('download and first scan failures can be retried without clobbering other installations',async t=>{
  const f=fixture(t);f.setFail('install',true);await assert.rejects(()=>prepareUpstream(f.options),/npm failed/);
  assert.equal(readConfig(f.dir).upstream_entry,undefined);
  f.setFail('install',false);f.setFail('scan',true);await assert.rejects(()=>prepareUpstream(f.options),/scan failed/);
  const installs=f.calls.filter(x=>x.args.includes('install')).length;
  f.setFail('scan',false);await prepareUpstream(f.options);assert.equal(f.calls.filter(x=>x.args.includes('install')).length,installs);
});

test('unowned installation directory is never overwritten',async t=>{
  const f=fixture(t);mkdirSync(f.prefix,{recursive:true});writeFileSync(join(f.prefix,'keep'),'untouched');
  await assert.rejects(()=>prepareUpstream(f.options),/占用/);assert.equal(readFileSync(join(f.prefix,'keep'),'utf8'),'untouched');
  assert.equal(f.calls.filter(x=>x.args.includes('install')).length,0);
});

test('macOS original service is discovered without running its command or overwriting its plist',async t=>{
  const f=fixture(t,'darwin');source(f.db);const entry=pkg(join(f.home,'brew/original'));
  const path=join(f.home,'Library/LaunchAgents/com.tokenwatcher.server.plist');mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,`<string>${entry}</string>`);
  const found=findUpstream(f.options);assert.ok(found);await prepareUpstream(f.options);startPreparedUpstream(f.options);
  assert.equal(f.calls.length,0);assert.equal(readFileSync(path,'utf8'),`<string>${entry}</string>`);
});

test('new macOS collector refuses to overwrite an unrelated service',async t=>{
  const f=fixture(t,'darwin');await prepareUpstream(f.options);
  const file=join(f.home,'Library/LaunchAgents/com.tokenwatcher.server.plist');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'unrelated-service');
  assert.throws(()=>startPreparedUpstream(f.options),/未覆盖/);assert.equal(readFileSync(file,'utf8'),'unrelated-service');
  assert.equal(f.calls.filter(x=>x.args.includes('install-agent')).length,0);
});

test('new macOS collector invokes upstream native startup only once',async t=>{
  const f=fixture(t,'darwin');await prepareUpstream(f.options);startPreparedUpstream(f.options);startPreparedUpstream(f.options);
  assert.equal(f.calls.filter(x=>x.args.includes('install-agent')).length,1);
});

test('Linux startup failure retries its own unchanged unit, without replacing unrelated services',async t=>{
  const f=fixture(t);await prepareUpstream(f.options);f.setFail('service',true);
  assert.throws(()=>startPreparedUpstream(f.options),/service unavailable/);f.setFail('service',false);
  assert.deepEqual(startPreparedUpstream(f.options),{started:true});
});

test('Windows wrapper launches original serve separately from sync and can restart its own existing task',async t=>{
  const f=fixture(t);await prepareUpstream(f.options);
  const winPrefix=upstreamPrefix(f.home,'win32');mkdirSync(winPrefix,{recursive:true});
  const entry=pkg(join(winPrefix,'node_modules/token-watcher'));
  writeFileSync(join(winPrefix,'tokenrank-bootstrap.json'),JSON.stringify({owner:'tokenrank-upstream-bootstrap-v1',scanned:true}));
  writeConfig({...readConfig(f.dir),upstream_entry:entry},f.dir);
  startPreparedUpstream({...f.options,platform:'win32'});
  const command=f.calls.find(x=>x.command==='powershell.exe').args.at(-1);
  assert.match(command,/TokenWatcherForTokenRank/);assert.doesNotMatch(command,/TokenRankSync|Unregister|Stop-Process|-Force/);
  assert.match(readFileSync(join(winPrefix,'collector.vbs'),'utf16le'),/serve --no-open/);
});

test('retiring the verified legacy collector starts the existing original once without reinstalling it',async t=>{
  const f=fixture(t,'darwin');source(f.db);const entry=pkg(join(f.home,'original'));symlinkSync(entry,join(f.bin,'token-watcher'));
  await prepareUpstream(f.options);writeConfig({...readConfig(f.dir),legacy_collector_retired:true},f.dir);
  assert.deepEqual(startPreparedUpstream(f.options),{started:true});
  assert.equal(f.calls.filter(x=>x.args.includes('install-agent')).length,1);
  assert.equal(f.calls.filter(x=>x.args.includes('install')).length,0);
  assert.equal(readConfig(f.dir).legacy_collector_retired,false);
  assert.deepEqual(startPreparedUpstream(f.options),{reused:true});
  assert.equal(f.calls.filter(x=>x.args.includes('install-agent')).length,1);
});

test('fresh install takes the newest official release, never one without the duplicate fixes',async t=>{
  const f=fixture(t);f.setLatest('1.9.0');const result=await prepareUpstream(f.options);
  assert.equal(result.version,'1.9.0');assert.ok(f.calls.find(x=>x.args.includes('install')).args.includes('token-watcher@1.9.0'));
  const g=fixture(t);g.setLatest('1.8.1');const fixed=await prepareUpstream(g.options);
  assert.equal(fixed.version,'1.8.3');assert.equal(g.calls.find(x=>x.args.includes('install')).args.at(-1),FIXED_SOURCE);
});

test('existing pre-fix original is kept for the explicit upgrade and reported as outdated',async t=>{
  const f=fixture(t);const entry=pkg(join(f.home,'original'),'token-watcher','1.8.0');symlinkSync(entry,join(f.bin,'token-watcher'));source(f.db);
  const logs=[];const result=await prepareUpstream({...f.options,log:m=>logs.push(m)});
  assert.equal(result.version,'1.8.0');assert.equal(f.calls.length,0);assert.equal(f.fetches.length,0);
  assert.match(logs.join('\n'),/低于修复重复统计的 1\.8\.2/);assert.equal(readConfig(f.dir).upstream_version,'1.8.0');
  assert.equal(collectorOutdated('1.8.0'),true);assert.equal(collectorOutdated('1.8.2'),false);assert.equal(collectorOutdated(null),false);
});
