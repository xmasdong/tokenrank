import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeTotalReport } from '../src/report.js';
import worker from '../src/worker.js';
import { sync } from '../../client/sync/report.js';
import { writeConfig, readConfig } from '../../client/sync/config.js';

const day = (date, tokens=10) => ({ day:date,tokens,input_tokens:tokens,output_tokens:0,cache_read:0,cache_write:0,requests:1,models:[],tools:[] });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>db.close()); const now=Date.now()-10000, f={db,now,failCommit:false,beforeBatch:null};
  for (const uid of [1,2]) {
    db.prepare('INSERT INTO users(id,openid,nickname,created_at,updated_at) VALUES(?,?,?,?,?)').run(uid,'user-'+uid,'name-'+uid,now,now);
    db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,?)').run(String(uid).repeat(32),uid,now);
    db.prepare(`INSERT INTO daily_totals VALUES(?,?,?,900,900,0,0,0,1,'[]','[]',?,?,NULL)`).run(uid,'same-device','2026-01-01',now-1000,now-1000);
    db.prepare('INSERT INTO usage_sync_state VALUES(?,?,?,?)').run(uid,'same-device',now-1000,now-1000);
  }
  function prepare(sql) {
    let args=[]; const params=()=>Object.fromEntries(args.map((v,i)=>[String(i+1),v]));
    return {sql,bind(...values){args=values;return this},async first(){return db.prepare(sql).get(params())??null},
      async all(){return {results:db.prepare(sql).all(params())}},_run(){const r=db.prepare(sql).run(params());return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}},async run(){return this._run()}};
  }
  f.env={DB:{prepare,async batch(stmts){
    const before=f.beforeBatch;f.beforeBatch=null;if(before)await before();
    db.exec('BEGIN');try {const results=stmts.map((s,i)=>{
      if(f.failCommit && stmts[0].sql.includes("status='committing'") && i===3)throw new Error('simulated commit failure');
      return s._run();});db.exec('COMMIT');return results;
    }catch(err){db.exec('ROLLBACK');throw err;}
  }}};
  f.body=(days,extra={})=>({v:2,device_id:'same-device',source_at:now,timezone:'Asia/Shanghai',token_basis:'upstream_total',
    client_version:'0.2.6',collector_version:'1.8.2',full:true,complete:true,days,...extra});
  f.part=(index,count,days,total,id='a'.repeat(32),extra={})=>f.body(days,{complete:index===count-1,replace:{id,batch_index:index,batch_count:count,total_days:total},...extra});
  f.send=(body,uid=1,time=now)=>storeTotalReport(f.env,{user_id:uid,token:String(uid).repeat(32)},body,time);
  f.rows=uid=>db.prepare('SELECT device_id,day,tokens FROM daily_totals WHERE user_id=? ORDER BY device_id,day').all(uid);
  return f;
}

test('regular and atomic replacement uploads retain costs; a later legacy upload invalidates stale costs', async t => {
  const f=fixture(t), d=day('2026-02-01',100);
  d.cost={basis:'token_watcher_api_estimate',currency:'USD',usd_micros:1234567,models:[['priced-model',1234567]],unpriced_models:[],unpriced_tokens:0};
  assert.equal((await f.send(f.body([d]))).status,200);
  const read=()=>JSON.parse(f.db.prepare('SELECT cost_json FROM daily_totals WHERE user_id=1 AND day=?').get(d.day).cost_json);
  assert.deepEqual(read(),d.cost);
  assert.equal((await f.send(f.part(0,1,[d],1,'c'.repeat(32),{source_at:f.now+1}))).status,200);
  assert.deepEqual(read(),d.cost);
  assert.equal((await f.send(f.body([day(d.day,101)],{source_at:f.now+2}))).status,200);
  assert.equal(read(),null);
});

test('replacement stays invisible until complete; commit removes old days, devices and legacy totals only for this account', async t=>{
  const f=fixture(t), before=f.rows(1), other=f.rows(2);
  f.db.exec(`INSERT INTO daily_totals SELECT user_id,'old-device',day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at,cost_json FROM daily_totals WHERE user_id=1;
    INSERT INTO daily_stats(user_id,day,tokens,updated_at) VALUES(1,'2025-01-01',999,1);
    INSERT INTO rank_groups(id,name,owner_user_id,created_at) VALUES('group','保留群',1,1);
    INSERT INTO rank_group_members(group_id,user_id,joined_at) VALUES('group',1,1);`);
  const retained=f.rows(1);
  const first=await f.send(f.part(0,2,[day('2026-02-01',20)],2));assert.equal(first.status,200);assert.equal((await first.json()).committed,false);
  assert.deepEqual(f.rows(1),retained);
  const last=await f.send(f.part(1,2,[day('2026-02-02',30)],2));assert.equal(last.status,200);assert.equal((await last.json()).committed,true);
  assert.deepEqual(f.rows(1).map(r=>[r.day,r.tokens]),[['2026-02-01',20],['2026-02-02',30]]);
  assert.deepEqual(f.rows(2),other);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_stats WHERE user_id=1').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_group_members WHERE user_id=1').get().n,1);
  assert.equal(f.db.prepare('SELECT nickname FROM users WHERE id=1').get().nickname,'name-1');
  assert.notDeepEqual(f.rows(1),before);
});

test('incomplete, mismatched, repeated and duplicate-date chunks never partially clear rankings',async t=>{
  const f=fixture(t), before=f.rows(1), first=f.part(0,3,[day('2026-02-01')],3);
  assert.equal((await f.send(first)).status,200);assert.equal((await f.send(first)).status,200);
  assert.equal((await f.send(f.part(0,3,[day('2026-02-01',30)],3))).status,409);
  assert.equal((await f.send(f.part(2,3,[day('2026-02-03')],3))).status,409);
  assert.deepEqual(f.rows(1),before);
  assert.equal((await f.send(f.part(1,3,[day('2026-02-01')],3))).status,200);
  assert.equal((await f.send(f.part(2,3,[day('2026-02-03')],3))).status,409);
  assert.deepEqual(f.rows(1),before);
});

test('database failure rolls the entire replacement back; retry and a lost final receipt are idempotent',async t=>{
  const f=fixture(t), before=f.rows(1), body=f.part(0,1,[day('2026-02-01')],1);
  f.failCommit=true;await assert.rejects(f.send(body),/simulated/);assert.deepEqual(f.rows(1),before);
  f.failCommit=false;assert.equal((await f.send(body)).status,200);const after=f.rows(1);
  assert.equal((await (await f.send(body)).json()).committed,true);assert.deepEqual(f.rows(1),after);
});

test('an empty complete rebuild clears only this account and is still acknowledged',async t=>{
  const f=fixture(t), other=f.rows(2);const response=await f.send(f.part(0,1,[],0));
  assert.deepEqual(await response.json(),{ok:true,accepted:0,committed:true});assert.deepEqual(f.rows(1),[]);assert.deepEqual(f.rows(2),other);
});

test('old sync/core versions cannot overwrite corrected data; new daily sync remains available',async t=>{
  const f=fixture(t);
  await f.send(f.part(0,1,[day('2026-02-01')],1,'a'.repeat(32),{collector_version:'1.9.0'}));const corrected=f.rows(1);
  for(const metadata of [{client_version:undefined,collector_version:undefined},{collector_version:'1.8.2'},{client_version:'0.2.5',collector_version:'1.9.0'}])
    assert.equal((await f.send(f.body([day('2026-02-01',999)],{source_at:f.now+1,...metadata}))).status,426);
  assert.deepEqual(f.rows(1),corrected);
  assert.equal((await f.send(f.body([day('2026-02-01',11)],{source_at:f.now+2,collector_version:'1.9.0'}))).status,200);
  assert.equal(f.rows(1)[0].tokens,11);
});

test('a second device cannot interrupt an active repair; same-device retry supersedes its abandoned snapshot',async t=>{
  const f=fixture(t);await f.send(f.part(0,2,[day('2026-02-01')],2));
  assert.equal((await f.send(f.part(0,1,[day('2026-02-02')],1,'b'.repeat(32),{source_at:f.now+1,device_id:'other-device'}))).status,409);
  assert.equal((await f.send(f.body([day('2026-02-01',999)],{source_at:f.now+1}))).status,409);
  assert.equal((await f.send(f.part(0,1,[day('2026-02-02',20)],1,'c'.repeat(32),{source_at:f.now+2}))).status,200);
  assert.equal((await f.send(f.part(1,2,[day('2026-02-03')],2))).status,409);
  assert.deepEqual(f.rows(1).map(r=>[r.day,r.tokens]),[['2026-02-02',20]]);
});

test('an in-flight old report cannot sneak past a repair that committed after its preflight',async t=>{
  const f=fixture(t);
  f.beforeBatch=()=>f.send(f.part(0,1,[day('2026-02-01',20)],1));
  const old=await f.send(f.body([day('2026-02-01',999)],{client_version:undefined,collector_version:undefined,source_at:f.now+1}));
  assert.equal(old.status,409);assert.equal(f.rows(1)[0].tokens,20);
});

test('real client retries an interrupted 805-day rebuild through the Worker; obsolete days disappear and auth is required',async t=>{
  const f=fixture(t), home=mkdtempSync(join(tmpdir(),'rank-replace-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const dir=join(home,'rank'), source=join(home,'usage.db'), root=join(home,'original');mkdirSync(join(root,'bin'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'token-watcher',version:'1.8.2',repository:'https://github.com/luwill/token-watcher',bin:{'token-watcher':'bin/tokenwatcher.js'}}));
  writeFileSync(join(root,'bin/tokenwatcher.js'),'// official fixture');
  const db=new DatabaseSync(source);db.exec('CREATE TABLE events(ts INTEGER,tool TEXT,model TEXT,total_tokens INTEGER,input_tokens INTEGER,output_tokens INTEGER,cached_input INTEGER,cache_write INTEGER)');
  const insert=db.prepare("INSERT INTO events VALUES(?,'codex','test',10,10,0,0,0)");
  for(let i=0;i<805;i++)insert.run(Date.UTC(2023,0,1)+i*86400000);db.close();
  writeConfig({server:'https://rank.test',token:'1'.repeat(32),device_id:'same-device',db_path:source,upstream_entry:join(root,'bin/tokenwatcher.js')},dir);
  let calls=0,fail=true;const fetcher=async(url,options)=>{
    if(options.method==='POST'&&++calls===2&&fail)throw new Error('interrupted');
    return worker.fetch(new Request(url,options),f.env);
  };
  const before=f.rows(1);
  await assert.rejects(sync({dir,replace:true,now:f.now+1,fetcher}),/interrupted/);
  assert.deepEqual(f.rows(1),before);assert.equal(readConfig(dir).replace_pending,true);
  fail=false;const result=await sync({dir,now:f.now+2,fetcher});assert.equal(result.replaced,true);assert.equal(result.accepted,805);
  assert.equal(f.rows(1).length,805);assert.equal(f.rows(1).reduce((sum,r)=>sum+r.tokens,0),8050);
  assert.equal(readConfig(dir).replace_pending,false);assert.equal(Object.keys(readConfig(dir).synced_days).length,805);
  const unauth=await worker.fetch(new Request('https://rank.test/report',{method:'POST',body:JSON.stringify(f.part(0,1,[],0))}),f.env);
  assert.equal(unauth.status,401);
});
