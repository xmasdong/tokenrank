import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDays, openSource, readLegacySettings } from '../sync/source.js';
import { readConfig, writeConfig, rejectSharedDirectory } from '../sync/config.js';
import { sync, batches } from '../sync/report.js';
import { MIN_REPORT_VERSION } from '../sync/upstream.js';
import { installAgent, uninstallAgent, migrateLegacyAgent, LABEL } from '../sync/agent.js';
import { acquireLock } from '../sync/lock.js';

function fixture(t, count=1) {
  const root=mkdtempSync(join(tmpdir(),'tokenrank-sync-test-')), dir=join(root,'rank'), source=join(root,'upstream');
  mkdirSync(source); const path=join(source,'tokenmeter.db');
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE events(ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input INTEGER, cache_write INTEGER, total_tokens INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('sentinel','"keep"');`);
  const add=(day,input=30,output=20)=>db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(Date.parse(day+'T12:00:00Z'),'codex','gpt-test',input,output,100,40,input+output+140);
  for(let i=0;i<count;i++)add(new Date(Date.UTC(2024,0,1)+i*86400000).toISOString().slice(0,10));
  const config={server:'https://rank.test',token:'a'.repeat(32),device_id:'device-test',db_path:path};
  writeConfig(config,dir);
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  return {root,dir,path,db,add,config};
}
const ack = options => Response.json({ok:true,accepted:JSON.parse(options.body).days.length});

test('read-only adapter uses upstream total, Beijing boundaries and committed WAL; source unchanged',t=>{
  const f=fixture(t);f.add('2024-01-02',0,0);
  f.db.exec("UPDATE events SET cached_input=0,cache_write=0,total_tokens=0 WHERE input_tokens=0");
  f.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(Date.parse('2024-01-01T16:01Z'),'claude','opus',2,3,4,5,99);
  const before=readFileSync(f.path), wal=readFileSync(f.path+'-wal');
  const days=readDays(f.path);
  assert.equal(days[0].tokens,190);assert.equal(days[0].cache_read,100);
  assert.equal(days[1].tokens,99);assert.equal(days[1].requests,2);
  assert.deepEqual(days[1].models,[['opus',99]]);
  const ro=openSource(f.path);assert.throws(()=>ro.exec("UPDATE settings SET value='bad'"),/readonly|read-only/i);ro.close();
  assert.deepEqual(readFileSync(f.path),before);assert.deepEqual(readFileSync(f.path+'-wal'),wal);
  assert.equal(f.db.prepare('SELECT value FROM settings').get().value,'"keep"');
});

test('missing/incompatible schema and oversized metrics fail without creating or migrating source',t=>{
  const f=fixture(t);const missing=join(f.root,'missing.db');
  assert.throws(()=>readDays(missing),/未找到/);assert.equal(existsSync(missing),false);
  f.db.exec('ALTER TABLE events RENAME COLUMN model TO future_model');
  assert.throws(()=>readDays(f.path),/结构不兼容/);
  assert.ok(f.db.prepare('PRAGMA table_info(events)').all().some(x=>x.name==='future_model'));
  f.db.exec('ALTER TABLE events RENAME COLUMN future_model TO model; UPDATE events SET total_tokens=10000000000001');
  assert.throws(()=>readDays(f.path),/不截断/);
});

test('more than 400 historical days all upload; old-day changes are detected; config independent',async t=>{
  const f=fixture(t,805);const sent=[];
  const fetcher=async(url,options)=>{sent.push(JSON.parse(options.body));assert.equal(url,'https://rank.test/report');return ack(options);};
  const r=await sync({dir:f.dir,fetcher});assert.equal(r.accepted,805);
  assert.deepEqual(sent.map(x=>x.days.length),[400,400,5]);assert.deepEqual(sent.map(x=>x.complete),[false,false,true]);assert.ok(sent.every(x=>x.v===2&&x.full&&x.timezone==='Asia/Shanghai'));
  assert.equal((await sync({dir:f.dir,fetcher})).accepted,0);assert.equal(sent.length,3);
  f.db.exec('UPDATE events SET input_tokens=31 WHERE ts=(SELECT MIN(ts) FROM events)');
  assert.equal((await sync({dir:f.dir,fetcher})).accepted,1);assert.equal(sent.at(-1).days[0].day,'2024-01-01');
  assert.equal(Object.keys(readConfig(f.dir).synced_days).length,805);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,1);
  if(process.platform!=='win32')assert.equal(statSync(join(f.dir,'config.json')).mode&0o777,0o600);
});

test('acknowledged batches checkpoint; partial failure retries only pending days',async t=>{
  const f=fixture(t,401);let calls=0;
  await assert.rejects(sync({dir:f.dir,fetcher:async(_,o)=>++calls===1?ack(o):new Response('',{status:503})}),/503/);
  assert.equal(Object.keys(readConfig(f.dir).synced_days).length,400);
  const r=await sync({dir:f.dir,fetcher:async(_,o)=>{assert.equal(JSON.parse(o.body).days.length,1);return ack(o);}});
  assert.equal(r.accepted,1);assert.equal(readConfig(f.dir).last_error,null);assert.equal(readConfig(f.dir).initial_sync_pending,false);
});

test('429 retries honor Retry-After; invalid or unauthorized acknowledgments never advance state',async t=>{
  const f=fixture(t);let calls=0;const waits=[];
  await sync({dir:f.dir,wait:async ms=>waits.push(ms),fetcher:async(_,o)=>++calls===1?new Response('',{status:429,headers:{'retry-after':'20'}}):ack(o)});
  assert.deepEqual(waits,[20100]);
  for(const response of [new Response('',{status:401}),Response.json({ok:true,accepted:0})]){
    writeConfig(f.config,f.dir);
    await assert.rejects(sync({dir:f.dir,fetcher:async()=>response}));
    assert.equal(readConfig(f.dir).synced_days,undefined);
  }
});

test('dry run does not upload or change configuration; disconnect during retry cancels upload',async t=>{
  const f=fixture(t);const before=readFileSync(join(f.dir,'config.json'));
  const r=await sync({dir:f.dir,dryRun:true,fetcher:()=>{throw new Error('unexpected network');}});
  assert.equal(r.reports[0].days.length,1);assert.deepEqual(readFileSync(join(f.dir,'config.json')),before);
  let calls=0;
  await assert.rejects(sync({dir:f.dir,fetcher:async()=>{calls++;return new Response('',{status:429});},
    wait:async()=>writeConfig({...f.config,token:null},f.dir)}),/已改变/);
  assert.equal(calls,1);assert.equal(readConfig(f.dir).token,null);
});

test('large Unicode detail payloads split below server body limit',()=>{
  const days=Array.from({length:400},(_,i)=>({day:String(i),tokens:100,models:Array.from({length:8},()=>['中'.repeat(60),100]),tools:Array.from({length:8},()=>['中'.repeat(60),100])}));
  const parts=batches(days,'d');assert.ok(parts.length>1);assert.equal(parts.flatMap(p=>p.days).length,400);
  for(const p of parts)assert.ok(Buffer.byteLength(JSON.stringify(p))<=450*1024);
});

test('legacy config import is read-only; shared directories rejected; lock is exclusive',t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO settings VALUES(?,?)').run('rank.token',JSON.stringify(f.config.token));
  assert.equal(readLegacySettings(f.path)['rank.token'],f.config.token);
  assert.throws(()=>rejectSharedDirectory(f.path,join(f.root,'upstream')),/目录/);
  const release=acquireLock(f.dir,'sync');assert.equal(acquireLock(f.dir,'sync'),null);release();
  const again=acquireLock(f.dir,'sync');assert.equal(typeof again,'function');again();
});

test('install and uninstall use isolated service names; dry run makes no changes',t=>{
  const f=fixture(t);const calls=[];const runner=(...a)=>calls.push(a);
  const home=join(f.root,'home');
  installAgent({platform:'darwin',home,dir:f.dir,dryRun:true,runner,log(){}});
  assert.equal(existsSync(home),false);assert.equal(calls.length,0);
  installAgent({platform:'darwin',home,dir:f.dir,runner,log(){}});
  assert.ok(readFileSync(join(home,'Library','LaunchAgents',LABEL+'.plist'),'utf8').includes('bin/tokenrank.js'));
  uninstallAgent({platform:'darwin',home,dir:f.dir,runner});
  assert.ok(calls.every(c=>!JSON.stringify(c).includes('com.tokenwatcher')));
  calls.length=0;
  installAgent({platform:'win32',home,dir:f.dir,runner,log(){}});
  uninstallAgent({platform:'win32',home,dir:f.dir,runner});
  assert.ok(calls.every(c=>JSON.stringify(c).includes('TokenRankSync')));
  assert.ok(calls.every(c=>!JSON.stringify(c).includes('.tokenmeter')));
});

test('migration preserves original service; only verified old TokenRank service is backed up and retired',t=>{
  const f=fixture(t),home=join(f.root,'home'),appRoot=join(f.root,'old-app');
  mkdirSync(join(appRoot,'bin'),{recursive:true});writeFileSync(join(appRoot,'package.json'),JSON.stringify({name:'tokenrank-client',version:'0.1.0'}));
  writeFileSync(join(appRoot,'bin','tokenwatcher.js'),'// old');
  const folder=join(home,'Library','LaunchAgents');mkdirSync(folder,{recursive:true});
  const file=join(folder,'com.tokenwatcher.server.plist');writeFileSync(file,'<string>/original/bin/tokenwatcher.js</string>');
  const calls=[];const args={appRoot,home,dir:f.dir,platform:'darwin',runner:(...a)=>calls.push(a),log(){}};
  assert.equal(migrateLegacyAgent(args),false);assert.equal(calls.length,0);assert.equal(existsSync(file),true);
  const content='<string>'+join(appRoot,'bin','tokenwatcher.js')+'</string>';writeFileSync(file,content);
  assert.equal(migrateLegacyAgent(args),true);assert.equal(existsSync(file),false);
  assert.equal(readFileSync(join(f.dir,'migrations',readdirSync(join(f.dir,'migrations'))[0]),'utf8'),content);
});

test('shell installer stages package, keeps original service/data, installs isolated adapter and command',async t=>{
  if(process.platform!=='darwin')return t.skip('macOS installer test');
  const {createServer}=await import('node:http');
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');const exec=promisify(execFile);
  const f=fixture(t);const home=join(f.root,'install-home'),fakeBin=join(f.root,'fake-bin');mkdirSync(home);mkdirSync(fakeBin);
  const own=join(home,'.tokenrank');writeConfig({...f.config,server:undefined,token:undefined},own);
  const upstream=join(home,'original');mkdirSync(join(upstream,'bin'),{recursive:true});
  writeFileSync(join(upstream,'package.json'),JSON.stringify({name:'token-watcher',version:'1.8.3',repository:{url:'https://github.com/luwill/token-watcher.git'},bin:{'token-watcher':'bin/tokenwatcher.js'}}));
  writeFileSync(join(upstream,'bin/tokenwatcher.js'),'// fixture');symlinkSync(join(upstream,'bin/tokenwatcher.js'),join(fakeBin,'token-watcher'));
  const originalDir=join(home,'Library','LaunchAgents');mkdirSync(originalDir,{recursive:true});
  const original=join(originalDir,'com.tokenwatcher.server.plist');const originalText=JSON.stringify({Label:'com.tokenwatcher.server',ProgramArguments:[process.execPath,join(upstream,'bin/tokenwatcher.js'),'serve']});writeFileSync(original,originalText);
  const oldApp=join(own,'app');mkdirSync(oldApp);writeFileSync(join(oldApp,'package.json'),JSON.stringify({name:'tokenrank-client',version:'0.1.0'}));
  writeFileSync(join(oldApp,'keep.txt'),'old-version-backup');
  writeFileSync(join(fakeBin,'curl'),'#!/bin/sh\nfor last do :; done\ncp "$TEST_PACKAGE" "$last"\n',{mode:0o755});
  writeFileSync(join(fakeBin,'launchctl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SERVICES"\n',{mode:0o755});
  let reports=0;const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('content-type','application/json');if(req.url==='/registry/token-watcher/latest')return res.end(JSON.stringify({name:'token-watcher',version:'1.8.3'}));reports++;res.end(JSON.stringify({ok:true,accepted:JSON.parse(body).days.length}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const project=new URL('../../',import.meta.url).pathname;
  const snapshot=readFileSync(f.path+'-wal');
  const env={...process.env,HOME:home,PATH:fakeBin+':'+process.env.PATH,TOKENRANK_REGISTRY:`http://127.0.0.1:${server.address().port}/registry/`,TEST_PACKAGE:join(project,'server/public/dl/tokenrank-client-0.2.11.tar.gz'),TEST_SERVICES:join(f.root,'services.log')};
  await exec('sh',[join(project,'server/public/install.sh'),`http://127.0.0.1:${server.address().port}`,f.config.token],{env});
  assert.equal(reports,1);assert.equal(readConfig(own).token,f.config.token);
  assert.equal(readFileSync(original,'utf8'),originalText);assert.deepEqual(readFileSync(f.path+'-wal'),snapshot);
  assert.ok(readdirSync(own).some(x=>x.startsWith('app-backup-')));
  assert.match(readFileSync(env.TEST_SERVICES,'utf8'),/com.tokenrank.sync/);assert.doesNotMatch(readFileSync(env.TEST_SERVICES,'utf8'),/(bootout|bootstrap).*com.tokenwatcher/);
  const result=await exec(join(home,'.local/bin/tokenrank'),['--version'],{env});assert.equal(result.stdout.trim(),'0.2.11');
  assert.equal(existsSync(join(own,'app/src')),false);assert.equal(existsSync(join(own,'app/web')),false);
});

test('fresh shell install bootstraps missing original before sync; a second install does not reinstall or rescan',async t=>{
  if(process.platform!=='darwin')return t.skip('macOS installer test');
  const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
  const f=fixture(t),home=join(f.root,'fresh-home'),bin=join(f.root,'bootstrap-bin'),template=join(f.root,'template');mkdirSync(home);mkdirSync(bin);mkdirSync(join(template,'bin'),{recursive:true});
  writeFileSync(join(template,'package.json'),JSON.stringify({name:'token-watcher',version:'1.8.3',type:'module',repository:{url:'https://github.com/luwill/token-watcher.git'},bin:{'token-watcher':'bin/tokenwatcher.js'}}));
  writeFileSync(join(template,'bin/tokenwatcher.js'),`import {mkdirSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {homedir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
const cmd=process.argv[2];appendFileSync(process.env.TEST_ORIGINAL_ACTIONS,cmd+'\\n');
if(cmd==='scan'){const folder=join(homedir(),'.tokenmeter');mkdirSync(folder,{recursive:true});const db=new DatabaseSync(join(folder,'tokenmeter.db'));db.exec('CREATE TABLE events(ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input INTEGER, cache_write INTEGER, total_tokens INTEGER); INSERT INTO events VALUES(1,"tool","model",1,1,0,0,2)'.replaceAll('"',"'"));db.close();}else if(cmd!=='install-agent')throw new Error('Unexpected original command');`);
  const npm=join(f.root,'fake-npm/bin/npm-cli.js');mkdirSync(join(npm,'..'),{recursive:true});
  writeFileSync(npm,`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);if(a[0]==='root'){console.log(path.join(process.env.HOME,'no-global'));}else if(a[0]==='install'){fs.appendFileSync(process.env.TEST_ORIGINAL_ACTIONS,'npm install\\n');fs.cpSync(process.env.TEST_TEMPLATE,path.join(a[a.indexOf('--prefix')+1],'node_modules/token-watcher'),{recursive:true});}else throw new Error('unexpected npm call');`);
  symlinkSync(npm,join(bin,'npm'));symlinkSync(process.execPath,join(bin,'node'));
  writeFileSync(join(bin,'curl'),'#!/bin/sh\nfor last do :; done\ncp "$TEST_PACKAGE" "$last"\n',{mode:0o755});
  writeFileSync(join(bin,'launchctl'),'#!/bin/sh\n[ "$1" = print ] && exit 113\nexit 0\n',{mode:0o755});
  let reports=0;const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('content-type','application/json');
    if(req.url==='/registry/token-watcher/latest')return res.end(JSON.stringify({name:'token-watcher',version:'1.8.3'}));
    if(req.url==='/agent/heartbeat')return res.end(JSON.stringify({ok:true,accepted:true,server_time:Date.now()}));
    reports++;res.end(JSON.stringify({ok:true,accepted:JSON.parse(body).days.length}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const project=new URL('../../',import.meta.url).pathname;
  const env={...process.env,HOME:home,PATH:bin+':/usr/bin:/bin',TOKENRANK_REGISTRY:`http://127.0.0.1:${server.address().port}/registry/`,TEST_PACKAGE:join(project,'server/public/dl/tokenrank-client-0.2.11.tar.gz'),TEST_TEMPLATE:template,TEST_ORIGINAL_ACTIONS:join(f.root,'actions.log')};
  const args=[join(project,'server/public/install.sh'),`http://127.0.0.1:${server.address().port}`,f.config.token];
  await exec('sh',args,{env});const db=join(home,'.tokenmeter/tokenmeter.db'),snapshot=readFileSync(db);
  await exec('sh',args,{env});
  assert.equal(readFileSync(env.TEST_ORIGINAL_ACTIONS,'utf8'),'npm install\nscan\ninstall-agent\n');
  assert.equal(reports,1);assert.deepEqual(readFileSync(db),snapshot);
  assert.ok(readConfig(join(home,'.tokenrank')).upstream_entry.includes('/.local/share/token-watcher/'));
});

test('pre-fix collector never publishes usage; dry run still previews',async t=>{
  const f=fixture(t);const root=join(f.root,'old-original');mkdirSync(join(root,'bin'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'token-watcher',version:'1.8.0',repository:{url:'https://github.com/luwill/token-watcher.git'},bin:{'token-watcher':'bin/tokenwatcher.js'}}));
  writeFileSync(join(root,'bin/tokenwatcher.js'),'// fixture');writeConfig({...f.config,upstream_entry:join(root,'bin/tokenwatcher.js')},f.dir);
  const r=await sync({dir:f.dir,fetcher:()=>{throw new Error('unexpected network');}});
  assert.equal(r.skipped,'collector-outdated');assert.match(readConfig(f.dir).last_error,new RegExp(`低于 ${MIN_REPORT_VERSION.replaceAll('.','\\.')}`));
  assert.equal(readConfig(f.dir).synced_days,undefined);
  const preview=await sync({dir:f.dir,dryRun:true,fetcher:()=>{throw new Error('unexpected network');}});assert.equal(preview.reports[0].collector_version,'1.8.0');
});

test('shell install over a pre-fix original uploads nothing and points to the update command',async t=>{
  if(process.platform!=='darwin')return t.skip('macOS installer test');
  const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
  const f=fixture(t);const home=join(f.root,'old-home'),fakeBin=join(f.root,'old-bin');mkdirSync(home);mkdirSync(fakeBin);
  writeConfig({...f.config,server:undefined,token:undefined},join(home,'.tokenrank'));
  const upstream=join(home,'original');mkdirSync(join(upstream,'bin'),{recursive:true});
  writeFileSync(join(upstream,'package.json'),JSON.stringify({name:'token-watcher',version:'1.8.0',repository:{url:'https://github.com/luwill/token-watcher.git'},bin:{'token-watcher':'bin/tokenwatcher.js'}}));
  writeFileSync(join(upstream,'bin/tokenwatcher.js'),'// fixture');symlinkSync(join(upstream,'bin/tokenwatcher.js'),join(fakeBin,'token-watcher'));
  writeFileSync(join(fakeBin,'curl'),'#!/bin/sh\nfor last do :; done\ncp "$TEST_PACKAGE" "$last"\n',{mode:0o755});
  writeFileSync(join(fakeBin,'launchctl'),'#!/bin/sh\n[ "$1" = print ] && exit 113\nexit 0\n',{mode:0o755});
  let reports=0;const server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/registry/token-watcher/latest')return res.end(JSON.stringify({name:'token-watcher',version:'1.8.3'}));reports++;res.end('{}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const project=new URL('../../',import.meta.url).pathname;
  const env={...process.env,HOME:home,PATH:fakeBin+':'+process.env.PATH,TOKENRANK_REGISTRY:`http://127.0.0.1:${server.address().port}/registry/`,TEST_PACKAGE:join(project,'server/public/dl/tokenrank-client-0.2.11.tar.gz')};
  let out;await assert.rejects(exec('sh',[join(project,'server/public/install.sh'),`http://127.0.0.1:${server.address().port}`,f.config.token],{env}),error=>{out=error;return error.code===1;});
  assert.equal(reports,0);assert.match(out.stdout,/低于修复重复统计的 1\.8\.2/);assert.match(out.stdout,/update\.sh \| sh/);
  assert.match(readConfig(join(home,'.tokenrank')).last_error,/低于 1\.8\.2/);
});

test('reconnect after account deletion uploads retained history in full, resumes interrupted batches, and keeps same-account checkpoints', async t => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile), f = fixture(t, 401), home = join(f.root, 'reconnect-home');
  mkdirSync(home);
  const dir = join(home, '.tokenrank'), newToken = 'b'.repeat(32), sent = [];
  let failLast = true;
  const server = createServer((req, res) => {
    let text = ''; req.on('data', chunk => text += chunk);
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/report') { res.writeHead(409); res.end('{}'); return; }
      const body = JSON.parse(text); sent.push(body);
      if (!body.full || req.headers.authorization !== 'Bearer ' + newToken || body.replace) {
        res.writeHead(409); res.end('{}'); return;
      }
      if (body.complete && failLast) { res.writeHead(503); res.end('{}'); return; }
      res.end(JSON.stringify({ ok: true, accepted: body.days.length }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeConfig({ ...f.config, server: origin, protocol_version: 2, initial_sync_pending: false,
    synced_days: { '2024-01-01': 'old-account-hash' }, replace_pending: true, last_ok_at: 123 }, dir);
  const cli = new URL('../bin/tokenrank.js', import.meta.url).pathname;
  const args = [cli, 'connect', origin, newToken], env = { ...process.env, HOME: home, USERPROFILE: home };
  const wal = readFileSync(f.path + '-wal');
  await assert.rejects(exec(process.execPath, args, { env }), /HTTP 503/);
  const pending = readConfig(dir);
  assert.equal(pending.initial_sync_pending, true); assert.equal(pending.replace_pending, false);
  assert.equal(pending.last_ok_at, null); assert.equal(Object.keys(pending.synced_days).length, 400);
  failLast = false;
  await exec(process.execPath, args, { env });
  assert.deepEqual(sent.map(body => body.days.length), [400, 1, 1]);
  assert.ok(sent.every(body => body.full));
  assert.equal(readConfig(dir).initial_sync_pending, false);
  assert.equal(Object.keys(readConfig(dir).synced_days).length, 401);
  await exec(process.execPath, args, { env });
  assert.equal(sent.length, 3); // Same account does not re-upload unchanged days.
  assert.deepEqual(readFileSync(f.path + '-wal'), wal);
});
