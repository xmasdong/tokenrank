import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { EMAIL_CONSENT_VERSION, normalizeEmail, saveEmailRegistration } from '../src/email-registration.js';
import { deleteAccount } from '../src/account.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(() => db.close());
  const f = { db, beforeRun: null };
  function prepare(sql) {
    let args=[];
    const params=()=>Object.fromEntries(args.map((value,i)=>[String(i+1),value]));
    return { bind(...values){args=values;return this;},
      async first(){return db.prepare(sql).get(params())??null;},
      async all(){return {results:db.prepare(sql).all(params())};},
      _run(){return {meta:{changes:db.prepare(sql).run(params()).changes}};},
      async run(){const before=f.beforeRun;f.beforeRun=null;if(before)await before();return this._run();} };
  }
  f.env={DB:{prepare,async batch(stmts){db.exec('BEGIN');try{const out=stmts.map(stmt=>stmt._run());db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}}};
  for(const id of [1,2]){
    db.prepare('INSERT INTO users(id,openid,created_at,updated_at) VALUES(?,?,1,1)').run(id,'private-'+id);
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
    db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,1)').run('connect-'+id,id);
  }
  f.request=(method='GET',body,token='session-1',path='/api/email-registration')=>worker.fetch(new Request('https://rank.test'+path,{method,
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),f.env);
  f.save=(email='User+daily@Example.COM',revision=null,extra={})=>f.request('POST',{email,consent:true,consent_version:EMAIL_CONSENT_VERSION,expected_revision:revision,...extra});
  return f;
}
test('邮箱格式拒绝换行和非法地址，保留邮箱本地部分并规范域名',()=>{
  assert.equal(normalizeEmail(' User+daily@Example.COM '),'User+daily@example.com');
  for(const value of [null,{},'abc','.a@test.com','a.@test.com','a..b@test.com','a@-bad.com','a@host','a@t.com\r\nBcc: x@t.com','a'.repeat(65)+'@x.com','a@'+'x'.repeat(64)+'.com','中文@x.com'])assert.equal(normalizeEmail(value),null,String(value));
});
test('仅本人小程序会话读取和修改登记；没有登记时不假装验证或开启推送',async t=>{
  const f=fixture(t);
  for(const token of ['', 'connect-1'])assert.equal((await f.request('GET',undefined,token)).status,401);
  const initial=await (await f.request()).json();
  assert.equal(initial.registered,false);assert.equal(initial.delivery_enabled,false);assert.equal(initial.verified,false);assert.equal(initial.revision,null);
  const saved=await (await f.save()).json();assert.equal(saved.email,'User+daily@example.com');assert.equal(saved.masked_email,'U***@example.com');assert.equal(saved.registered,true);
  assert.equal(saved.verified,false);assert.equal(saved.delivery_enabled,false);assert.match(saved.revision,/^[a-f0-9]{32}$/);
  assert.equal((await (await f.request('GET',undefined,'session-2')).json()).email,null);
  const publicUser=await (await f.request('GET',undefined,'session-1','/api/me')).json();
  assert.doesNotMatch(JSON.stringify(publicUser),/example\.com|email|consent_version/);
  f.db.exec('UPDATE users SET disabled_at=1 WHERE id=1');assert.equal((await f.request()).status,403);assert.equal((await f.save('x@x.com',saved.revision)).status,403);
});
test('未明确勾选同意不记录邮箱，不信任客户端目标账号或推送状态',async t=>{
  const f=fixture(t);
  for(const extra of [{consent:false},{consent:'true'},{consent_version:'stale'}])assert.equal((await f.save(undefined,null,extra)).status,400);
  assert.equal((await f.request('POST',{email:'x@x.com',consent:true,consent_version:EMAIL_CONSENT_VERSION})).status,400);
  assert.equal((await f.save('bad-email')).status,400);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM email_registrations').get().n,0);
  const response=await f.save(undefined,null,{user_id:2,delivery_enabled:true,verified:true});assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.delivery_enabled,false);assert.equal(data.verified,false);
  const row=f.db.prepare('SELECT * FROM email_registrations').get();assert.equal(row.user_id,1);assert.equal(row.consent_version,EMAIL_CONSENT_VERSION);assert.ok(row.consent_at>0);
});
test('修改和撤销检查版本；迟到登记不能恢复撤销的邮箱，其他用户不能跨账号修改',async t=>{
  const f=fixture(t), first=await (await f.save()).json();
  assert.equal((await f.save('other@x.com',null)).status,409);
  assert.equal((await f.request('DELETE',{expected_revision:first.revision},'session-2')).status,409);
  const changed=await (await f.save('next@x.com',first.revision)).json();assert.notEqual(changed.revision,first.revision);
  assert.equal((await f.request('DELETE',{expected_revision:first.revision})).status,409);
  const removed=await (await f.request('DELETE',{expected_revision:changed.revision})).json();
  assert.equal(removed.email,null);assert.equal(removed.registered,false);assert.notEqual(removed.revision,changed.revision);
  const row=f.db.prepare('SELECT * FROM email_registrations').get();assert.equal(row.email,null);assert.equal(row.consent_at,null);assert.equal(row.consent_version,null);
  assert.equal((await f.save('late@x.com',changed.revision)).status,409);assert.equal((await f.save('late@x.com',null)).status,409);
  assert.equal((await f.save('new@x.com',removed.revision)).status,200);
});
test('注销完整删除登记，认证后才注销的竞态也不能重新写入',async t=>{
  const f=fixture(t);await f.save();
  await deleteAccount(f.env,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM email_registrations').get().n,0);
  assert.equal((await f.request()).status,401);
  assert.equal((await saveEmailRegistration(f.env,1,{email:'late@x.com',consent:true,consent_version:EMAIL_CONSENT_VERSION,expected_revision:null})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM email_registrations').get().n,0);
  const g=fixture(t);g.beforeRun=()=>deleteAccount(g.env,1);assert.equal((await g.save()).status,409);
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM email_registrations').get().n,0);
});
test('迁移可重复且不修改用量、提醒；邮箱登记不会创建投递任务或发出网络请求',async t=>{
  const f=fixture(t);
  f.db.exec("INSERT INTO daily_stats(user_id,day,tokens,updated_at) VALUES(1,'2026-10-18',258000000,1);INSERT INTO reminder_jobs(user_id,kind,id,request_id,template_id,state,created_at,updated_at) VALUES(1,'daily','job','request','template','pending',1,1);");
  const before=['daily_stats','reminder_jobs'].map(table=>f.db.prepare(`SELECT * FROM ${table}`).all());
  for(let i=0;i<2;i++)f.db.exec(readFileSync(new URL('../migrations/0014_email_registrations.sql',import.meta.url),'utf8'));
  const originalFetch=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network++;throw Error('must not send');};
  try {await f.save();await f.request();}finally{globalThis.fetch=originalFetch;}
  assert.equal(network,0);
  ['daily_stats','reminder_jobs'].forEach((table,i)=>assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),before[i]));
});
test('接口拒绝非法正文、超长正文和不支持的方法',async t=>{
  const f=fixture(t);
  assert.equal((await f.request('POST','{bad')).status,400);assert.equal((await f.request('POST','x'.repeat(2049))).status,413);
  assert.equal((await f.request('PUT')).status,405);assert.equal((await f.request('DELETE',{})).status,400);
  assert.equal((await f.request('POST','null')).status,400);
  assert.equal((await f.save('u@example.com',['a'.repeat(32)])).status,400);
});
