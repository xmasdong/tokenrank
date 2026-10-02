import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {writeConfig,readConfig} from '../sync/config.js';
import {sendHeartbeat,notifyStopped,readHealth,CLIENT_VERSION} from '../sync/health.js';
import {startWatch,startCheck} from '../sync/watch.js';
import {installAgent,windowsScript,plist} from '../sync/agent.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test) { const end=Date.now()+3000;while(!test()){if(Date.now()>end)throw new Error('condition timed out');await sleep(5);} }
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'rank-health-')),dir=join(root,'rank');
  const config={token:'a'.repeat(32),server:'https://rank.test',device_id:'device-1',db_path:join(root,'source.db')};
  writeConfig(config,dir);t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,dir,config};
}

test('心跳只发送状态白名单，单独保存，不覆盖并发同步检查点',async t=>{
  const f=fixture(t);let payload;
  const ok=await sendHeartbeat({dir:f.dir,status:{state:'idle',checked_at:Date.now(),raw_error:'/private/secret',token:'secret'},
    fetcher:async(url,options)=>{
      assert.equal(url,'https://rank.test/agent/heartbeat');payload=JSON.parse(options.body);
      assert.equal(options.headers.authorization,'Bearer '+f.config.token);
      writeConfig({...f.config,synced_days:{today:'hash'}},f.dir);
      return Response.json({ok:true,accepted:true,server_time:123});
    }});
  assert.equal(ok,true);assert.equal(payload.client_version,CLIENT_VERSION);
  assert.equal(JSON.stringify(payload).includes('secret'),false);assert.equal(JSON.stringify(payload).includes(f.root),false);
  assert.deepEqual(readConfig(f.dir).synced_days,{today:'hash'});assert.equal(readHealth(f.dir).state,'idle');
  writeConfig({...f.config,token:'b'.repeat(32)},f.dir);assert.equal(readHealth(f.dir),null);
  assert.equal(await sendHeartbeat({dir:f.dir,config:f.config,status:{state:'idle'},fetcher:()=>assert.fail('stale credential')}),false);
});

test('离线模式不发心跳；断开先在本机生效，关闭通知失败也不能恢复上传',async t=>{
  const f=fixture(t);const previous=process.env.TOKENRANK_OFFLINE;
  process.env.TOKENRANK_OFFLINE='1';
  try {assert.equal(await sendHeartbeat({dir:f.dir,status:{state:'idle'},fetcher:()=>assert.fail('offline network')}),false);}
  finally {if(previous===undefined)delete process.env.TOKENRANK_OFFLINE;else process.env.TOKENRANK_OFFLINE=previous;}
  writeConfig({...f.config,token:null},f.dir);let payload;
  assert.equal(await notifyStopped('USER_DISABLED',{dir:f.dir,config:f.config,fetcher:async(_,o)=>{payload=JSON.parse(o.body);throw new Error('offline');}}),false);
  assert.equal(payload.state,'stopped');assert.equal(payload.error_code,'USER_DISABLED');assert.equal(readConfig(f.dir).token,null);
  assert.equal(await sendHeartbeat({dir:f.dir,status:{state:'idle'},fetcher:()=>assert.fail('disabled network')}),false);
});

test('任务阻塞时心跳持续，检查不重叠；失败后下一周期重新检查',async t=>{
  const f=fixture(t),beats=[];let calls=0,resolve;
  const watcher=startWatch({dir:f.dir,intervalMs:20,heartbeat:async({status})=>{beats.push(status);return true;},
    check:()=>{calls++;return {done:new Promise(r=>resolve=r),cancel:()=>resolve({result:{skipped:'cancelled'}})};}});
  t.after(()=>watcher.stop());await until(()=>beats.length>=4);
  assert.equal(calls,1);assert.ok(beats.every(b=>b.state==='checking'));
  resolve({type:'failure',error_code:'CHECK_TIMEOUT'});await until(()=>beats.some(b=>b.error_code==='CHECK_TIMEOUT'));
  await until(()=>calls===2);assert.equal(calls,2);
  resolve({type:'result',result:{accepted:0},source_day:null});await until(()=>beats.some(b=>b.state==='idle'));
  await watcher.stop();const count=beats.length;await sleep(50);assert.equal(beats.length,count);
});

test('超时只终止自己启动的检查子进程，并将超时与异常退出分开',async()=>{
  const child=new EventEmitter();let killed=[];
  child.send=()=>{};child.kill=signal=>{killed.push(signal);queueMicrotask(()=>child.emit('exit',null,signal));};
  const run=startCheck({timeoutMs:20,spawn:(_file,args,options)=>{assert.deepEqual(args,[]);assert.deepEqual(options.stdio,['ignore','ignore','ignore','ipc']);return child;}});
  assert.deepEqual(await run.done,{type:'failure',error_code:'CHECK_TIMEOUT'});assert.deepEqual(killed,['SIGTERM']);
  const failed=new EventEmitter();failed.send=()=>queueMicrotask(()=>failed.emit('exit',1));failed.kill=()=>assert.fail('already exited');
  assert.deepEqual(await startCheck({spawn:()=>failed}).done,{type:'failure',error_code:'PROCESS_EXIT'});
});

test('真实子进程只读同步：首次上传、无新增心跳、读取失败均可观测',async t=>{
  const f=fixture(t),beats=[],reports=[];
  const db=new DatabaseSync(f.config.db_path);
  db.exec('CREATE TABLE events(ts INTEGER,tool TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input INTEGER,cache_write INTEGER,total_tokens INTEGER);');
  db.prepare("INSERT INTO events VALUES(?,'codex','test',10,20,30,40,100)").run(Date.now()-1000);db.close();
  const before=readFileSync(f.config.db_path);
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type','application/json');
    if(req.url==='/report'){reports.push(body);res.end(JSON.stringify({ok:true,accepted:body.days.length}));}
    else {assert.equal(req.url,'/agent/heartbeat');beats.push(body);res.end(JSON.stringify({ok:true,accepted:true,server_time:Date.now()}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  writeConfig({...f.config,server:'http://127.0.0.1:'+server.address().port},f.dir);
  const watcher=startWatch({dir:f.dir,intervalMs:60000});t.after(()=>watcher.stop());await watcher.first;
  assert.equal(reports.length,1);assert.equal(beats.at(-1).state,'uploaded');assert.equal(beats.at(-1).source_day.length,10);
  await watcher.tick();assert.equal(reports.length,1);assert.equal(beats.at(-1).state,'idle');
  assert.deepEqual(readFileSync(f.config.db_path),before);assert.equal(Object.keys(readConfig(f.dir).synced_days).length,1);
  rmSync(f.config.db_path);await watcher.tick();assert.equal(beats.at(-1).state,'error');assert.equal(beats.at(-1).error_code,'SOURCE_READ_FAILED');
  assert.equal(JSON.stringify(beats).includes(f.root),false);
  await watcher.stop();
});

test('系统托管同步器：重启设置仅属于本项目，Windows 保留子进程退出码',t=>{
  const f=fixture(t),commands=[];const home=join(f.root,'home');mkdirSync(home);
  installAgent({platform:'win32',home,dir:f.dir,runner:(_,args)=>commands.push(args.at(-1)),log(){}});
  const script=commands[0];assert.match(script,/-MultipleInstances IgnoreNew/);assert.match(script,/-AllowStartIfOnBatteries/);
  assert.match(script,/-DontStopIfGoingOnBatteries/);assert.match(script,/-RepetitionInterval/);assert.doesNotMatch(script,/-WakeToRun/);
  assert.match(windowsScript(),/WScript.Quit result/);assert.match(plist(),/<key>KeepAlive<\/key><true\/>/);
  installAgent({platform:'linux',home,dir:f.dir,runner(){},log(){}});
  const unit=readFileSync(join(home,'.config/systemd/user/tokenrank-sync.service'),'utf8');
  assert.match(unit,/Restart=always/);assert.match(unit,/RestartSec=15/);
});
