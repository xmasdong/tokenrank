import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {heartbeat,syncHealth,STALE_AFTER_MS} from '../src/sync-health.js';
import worker from '../src/worker.js';
import {summarize} from '../../scripts/sync-status.mjs';

function fixture(t) {
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>db.close());const f={db,beforeWrite:null};
  function prepare(sql) {
    let args=[];const params=()=>Object.fromEntries(args.map((v,i)=>[String(i+1),v]));
    return {bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(params())??null;},async all(){return {results:db.prepare(sql).all(params())};},
      _run(){const r=db.prepare(sql).run(params());return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}};},
      async run(){if(f.beforeWrite){const hook=f.beforeWrite;f.beforeWrite=null;await hook();}return this._run();}};
  }
  f.env={DB:{prepare,async batch(stmts){db.exec('BEGIN');try{const results=stmts.map(s=>s._run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}}};
  for(const id of [1,2]) {
    db.prepare('INSERT INTO users(id,openid,created_at,updated_at) VALUES(?,?,1,1)').run(id,'user-'+id);
    db.prepare('INSERT INTO connect_tokens(token,user_id,created_at,last_report_at) VALUES(?,?,1,10)').run('connect-'+id,id);
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+id,id,Date.now()+100000);
  }
  f.now=Date.now();f.body={v:1,device_id:'device-a',client_version:'0.2.10',collector_version:'1.8.2',platform:'darwin',state:'idle',checked_at:f.now-10,event_at:f.now};
  f.request=(body=f.body,token='connect-1')=>new Request('https://rank.test/agent/heartbeat',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)});
  f.send=(body=f.body,token='connect-1',now=f.now)=>heartbeat(f.request(body,token),f.env,now);
  return f;
}

test('独立心跳不改变用量或上传时间；空闲与失联分开，账号隔离',async t=>{
  const f=fixture(t);
  assert.equal((await f.send()).status,200);
  const state=await syncHealth(f.env,1,f.now);
  assert.equal(state.state,'online');assert.equal(state.result,'idle');assert.equal(state.last_check_at,f.now-10);
  assert.equal((await syncHealth(f.env,2,f.now)).state,'unknown');
  assert.equal(f.db.prepare('SELECT last_report_at FROM connect_tokens WHERE user_id=1').get().last_report_at,10);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_totals').get().n,0);
  assert.equal((await syncHealth(f.env,1,f.now+STALE_AFTER_MS)).state,'online');
  assert.equal((await syncHealth(f.env,1,f.now+STALE_AFTER_MS+1)).state,'unreachable');
  await f.send({...f.body,event_at:f.now+STALE_AFTER_MS},'connect-1',f.now+STALE_AFTER_MS);
  assert.equal((await syncHealth(f.env,1,f.now+STALE_AFTER_MS)).state,'online');
});

test('认证、白名单、尺寸、状态与时间校验拒绝不合法或敏感字段',async t=>{
  const f=fixture(t);
  for(const token of ['','session-1','unknown']) assert.equal((await f.send(f.body,token)).status,401);
  for(const patch of [{path:'/Users/private'},{log:'secret'},{state:'error'},{state:'idle',error_code:'UPLOAD_FAILED'},
    {state:'stopped',error_code:'UPLOAD_FAILED'},{state:'error',error_code:'USER_DISABLED'},
    {platform:'custom'},{device_id:123},{client_version:true},{source_day:'2026-02-30'},
    {event_at:f.now+300001},{checked_at:-1},{device_id:'x'.repeat(5000)}]) assert.equal((await f.send({...f.body,...patch})).status,400,JSON.stringify(patch).slice(0,100));
  for(const body of [null,[],42,'secret']) assert.equal((await f.send(body)).status,400);
  f.db.exec('UPDATE users SET disabled_at=1 WHERE id=1');assert.equal((await f.send()).status,403);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_agents').get().n,0);
});

test('主动关闭仅凭明确事件；迟到心跳不能覆盖关闭，重新连接可恢复',async t=>{
  const f=fixture(t);await f.send();
  await f.send({...f.body,state:'stopped',error_code:'USER_DISABLED',event_at:f.now+1},'connect-1',f.now+1);
  const rejected=await f.send(f.body,'connect-1',f.now+2);assert.equal((await rejected.json()).accepted,false);
  await f.send({...f.body,event_at:f.now+1},'connect-1',f.now+2);
  assert.equal((await syncHealth(f.env,1,f.now+86400000)).state,'stopped');
  await f.send({...f.body,event_at:f.now+3},'connect-1',f.now+3);
  assert.equal((await syncHealth(f.env,1,f.now+3)).state,'online');
});

test('在途心跳遇到注销或凭证轮换不能写回；轮换清理设备状态',async t=>{
  for(const rotate of [true,false]) {
    const f=fixture(t);await f.send();
    f.beforeWrite=()=>f.db.exec(rotate?"DELETE FROM sync_agents WHERE user_id=1; UPDATE connect_tokens SET token='new' WHERE user_id=1;":"DELETE FROM sync_agents WHERE user_id=1; DELETE FROM connect_tokens WHERE user_id=1; DELETE FROM users WHERE id=1;");
    const response=await f.send({...f.body,event_at:f.now+1},'connect-1',f.now+1);
    assert.equal((await response.json()).accepted,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_agents').get().n,0);
  }
  const f=fixture(t);await f.send();
  const res=await worker.fetch(new Request('https://rank.test/api/connect/token',{method:'POST',headers:{authorization:'Bearer session-1'}}),f.env);
  assert.equal(res.status,200);assert.equal((await syncHealth(f.env,1)).supported,false);
  assert.equal((await f.send()).status,401);
});

test('私有状态接口优先榜单来源设备，不泄漏到其他账号；运营报表一致',async t=>{
  const f=fixture(t);await f.send();
  f.db.prepare('INSERT INTO usage_sync_state VALUES(1,?,?,?)').run('device-a',f.now,f.now);
  await f.send({...f.body,device_id:'device-b',event_at:f.now+1,state:'error',error_code:'UPLOAD_FAILED'},'connect-1',f.now+1);
  for(const path of ['/api/me','/api/connect/token']) {
    const res=await worker.fetch(new Request('https://rank.test'+path,{headers:{authorization:'Bearer session-1'}}),f.env);
    const body=await res.json();assert.equal(body.sync_health.device_id,'device-a');assert.equal(body.sync_health.agents.length,2);
    const other=await worker.fetch(new Request('https://rank.test'+path,{headers:{authorization:'Bearer session-2'}}),f.env);
    assert.equal((await other.json()).sync_health.supported,false);
  }
  const rows=f.db.prepare("SELECT *, 'device-a' AS ranked_device_id, '测试' AS nickname, 10 AS last_report_at FROM sync_agents").all();
  const report=summarize([...rows,{user_id:2,nickname:null,last_report_at:5}],f.now+10);
  assert.equal(report.users,2);assert.equal(report.states.online,1);assert.equal(report.states.unknown,1);
  assert.equal(report.accounts[0].current.device_id,'device-a');
  f.db.exec("UPDATE usage_sync_state SET device_id='legacy-device' WHERE user_id=1");
  const legacy=await syncHealth(f.env,1,f.now+10);
  assert.equal(legacy.supported,false);assert.equal(legacy.state,'unknown');assert.equal(legacy.agents.length,2);
  const legacyReport=summarize(rows.map(row=>({...row,ranked_device_id:'legacy-device'})),f.now+10);
  assert.equal(legacyReport.states.unknown,1);assert.equal(legacyReport.accounts[0].current,undefined);
  f.db.exec(readFileSync(new URL('../migrations/0010_sync_agents.sql',import.meta.url),'utf8'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_agents').get().n,2);
});
