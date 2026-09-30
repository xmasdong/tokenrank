import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { deleteAccount } from '../src/account.js';
import { storeTotalReport } from '../src/report.js';

const ownedTables = ['user_avatars','mp_sessions','connect_tokens','rank_group_members','daily_stats','usage_shares',
  'daily_totals','usage_sync_state','usage_replacements','usage_replacement_chunks','usage_rebuild_guard'];
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const f = { db, beforeBatch: null };
  function prepare(sql) {
    let args = [];
    const params = () => Object.fromEntries(args.map((v, i) => [String(i + 1), v]));
    return { sql, bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(params()) ?? null; },
      async all() { return { results: db.prepare(sql).all(params()) }; },
      _run() { const r = db.prepare(sql).run(params()); return { meta: { changes:r.changes,last_row_id:Number(r.lastInsertRowid) } }; },
      async run() { return this._run(); } };
  }
  f.env = { ALLOW_DEV_LOGIN: '1', DB: { prepare, async batch(stmts) {
    const before = f.beforeBatch; f.beforeBatch = null; if (before) await before();
    db.exec('BEGIN');
    try { const out = stmts.map(s => s._run()); db.exec('COMMIT'); return out; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  } } };
  for (const uid of [1,2,3]) {
    db.prepare('INSERT INTO users(id,openid,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(uid,`dev:user${uid}`,`用户${uid}`,`${String(uid).repeat(36)}.png`,1,1);
    db.prepare('INSERT INTO user_avatars VALUES(?,?,?,?)').run(uid,new Uint8Array([1,2,3]),'image/png',1);
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run(`session-${uid}`,uid,Date.now()+100000);
    db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,?)').run(`connect-${uid}`,uid,1);
    db.prepare('INSERT INTO daily_stats(user_id,day,tokens,updated_at) VALUES(?,?,?,?)').run(uid,'2026-01-01',99,1);
    db.prepare("INSERT INTO daily_totals VALUES(?,?,'2026-01-01',99,99,0,0,0,1,'[]','[]',1,1)").run(uid,'device-'+uid);
    db.prepare('INSERT INTO usage_sync_state VALUES(?,?,?,?)').run(uid,'device-'+uid,1,1);
    db.prepare("INSERT INTO usage_shares VALUES(?,?,?,'{}',1,?,NULL)").run(String(uid).repeat(24),uid,'fingerprint',Date.now()+100000);
    db.prepare("INSERT INTO usage_replacements VALUES(?,?,?,1,1,1,'0.2.8','1.8.2','collecting',?)").run(uid,String(uid).repeat(32),'device-'+uid,Date.now()+100000);
    db.prepare("INSERT INTO usage_replacement_chunks VALUES(?,?,0,'digest','[]')").run(uid,String(uid).repeat(32));
    db.prepare("INSERT INTO usage_rebuild_guard VALUES(?,'0.2.8','1.8.2',1)").run(uid);
  }
  for (const [id, owner, members] of [['shared',1,[1,3,2]], ['sole',1,[1]], ['other',2,[1,2]]]) {
    db.prepare('INSERT INTO rank_groups VALUES(?,?,?, ?,1)').run(id,id,owner,'wechat-'+id);
    for (const uid of members) db.prepare('INSERT INTO rank_group_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(id,uid,uid===1?1:2);
  }
  // Cover multiple devices, credentials and hidden membership too.
  db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('second-session',1,Date.now()+100000);
  db.prepare("INSERT INTO daily_totals SELECT user_id,'old-device',day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at FROM daily_totals WHERE user_id=1").run();
  db.prepare("UPDATE rank_group_members SET hidden=1 WHERE group_id='shared' AND user_id=2").run();
  f.request = (path, method='GET', data, token='session-1') => worker.fetch(new Request('https://rank.test'+path, {
    method, headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    ...(data?{body:JSON.stringify(data)}:{}) }),f.env);
  f.remove = (body={confirm:'DELETE_ACCOUNT'},token='session-1') => f.request('/api/account','DELETE',body,token);
  return f;
}
function assertGone(f) {
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users WHERE id=1').get().n,0);
  for (const table of ownedTables) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=1`).get().n,0,table);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups WHERE owner_user_id=1').get().n,0);
}

test('注销完整删除本人所有表和设备数据，转交多人群榜，保留其他成员全部数据',async t => {
  const f=fixture(t);
  const before = ownedTables.map(table => f.db.prepare(`SELECT * FROM ${table} WHERE user_id<>1`).all());
  const result=await f.remove({confirm:'DELETE_ACCOUNT',user_id:2}); // Body cannot target another account.
  assert.equal(result.status,200); assert.deepEqual(await result.json(),{deleted:true}); assertGone(f);
  ownedTables.forEach((table,i) => assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} WHERE user_id<>1`).all(),before[i],table));
  assert.equal(f.db.prepare("SELECT owner_user_id FROM rank_groups WHERE id='shared'").get().owner_user_id,2);
  assert.equal(f.db.prepare("SELECT group_openid_hash FROM rank_groups WHERE id='shared'").get().group_openid_hash,'wechat-shared');
  assert.equal(f.db.prepare("SELECT id FROM rank_groups WHERE id='sole'").get(),undefined);
  assert.equal((await f.request('/api/me')).status,401);
  assert.equal((await f.request('/api/me','GET',null,'second-session')).status,401);
  assert.equal((await f.request('/report','POST',{},'connect-1')).status,401);
  assert.equal((await f.request('/api/shares/'+ '1'.repeat(24))).status,404);
  assert.equal((await f.request('/avatars/'+ '1'.repeat(36)+'.png')).status,404);
  assert.equal((await f.request('/api/me','GET',null,'session-2')).status,200);
});

test('注销必须通过本人有效会话及明确确认；任何失败都不能部分删除',async t => {
  const f=fixture(t);
  assert.equal((await f.remove({},'session-1')).status,400);
  assert.equal((await f.remove({confirm:true},'session-1')).status,400);
  assert.equal((await f.remove(undefined,'')).status,401);
  assert.equal((await f.remove(undefined,'connect-1')).status,401);
  f.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.equal((await f.remove()).status,500);
  for (const table of ownedTables) assert.ok(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=1`).get().n>0,table);
  assert.equal(f.db.prepare("SELECT owner_user_id FROM rank_groups WHERE id='shared'").get().owner_user_id,1);
  assert.ok(f.db.prepare("SELECT id FROM rank_groups WHERE id='sole'").get());
});

test('数据库保护拦截注销后迟到的写入与改绑，迁移可重复应用',async t => {
  const f=fixture(t);
  const tables=[...ownedTables,'rank_groups'];
  const rows=tables.map(table=>f.db.prepare(`SELECT * FROM ${table} WHERE ${table==='rank_groups'?'owner_user_id':'user_id'}=1`).get());
  await deleteAccount(f.env,1); assertGone(f);
  f.db.exec(readFileSync(new URL('../migrations/0009_account_deletion_guards.sql',import.meta.url),'utf8'));
  tables.forEach((table,i)=>{
    const row=rows[i];
    assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row)),/ACCOUNT_NOT_FOUND|GROUP_NOT_FOUND/,table);
    const col=table==='rank_groups'?'owner_user_id':'user_id';
    assert.throws(()=>f.db.prepare(`UPDATE ${table} SET ${col}=1 WHERE ${col}=2`).run(),/ACCOUNT_NOT_FOUND/,table);
  });
  assertGone(f);
});

test('注销与普通回传、重建首批及提交竞态均不能复活已删除用量',async t=>{
  for (const replace of [false,true]) {
    const f=fixture(t);
    f.db.exec('DELETE FROM usage_replacements WHERE user_id=1; DELETE FROM usage_replacement_chunks WHERE user_id=1;');
    const now=Date.now();
    const body={v:2,device_id:'device-1',source_at:now,timezone:'Asia/Shanghai',token_basis:'upstream_total',client_version:'0.2.8',collector_version:'1.8.2',full:true,complete:true,
      days:[{day:'2026-01-01',tokens:10,input_tokens:10,output_tokens:0,cache_read:0,cache_write:0,requests:1,models:[],tools:[]}],
      ...(replace?{replace:{id:'a'.repeat(32),batch_index:0,batch_count:1,total_days:1}}:{})};
    f.beforeBatch=()=>deleteAccount(f.env,1);
    try { await storeTotalReport(f.env,{user_id:1,token:'connect-1'},body,now); } catch(err) { assert.match(err.message,/ACCOUNT_NOT_FOUND/); }
    assertGone(f);
    await assert.rejects(storeTotalReport(f.env,{user_id:1,token:'connect-1'}, {...body,replace:{id:'b'.repeat(32),batch_index:0,batch_count:1,total_days:1}},now),/ACCOUNT_NOT_FOUND/);
    assertGone(f);
  }
});

test('旧手机静默重登不会重建已注销账号；明确重新登录可使用全新账号',async t=>{
  const f=fixture(t); await f.remove();
  const refresh=await f.request('/api/wx/session','POST',{code:'user1',existing_only:true},'');
  assert.equal(refresh.status,410); assert.equal((await refresh.json()).code,'ACCOUNT_DELETED'); assertGone(f);
  const fresh=await f.request('/api/wx/session','POST',{code:'user1'},'');
  assert.equal(fresh.status,200); const data=await fresh.json();
  assert.notEqual(data.user.user_id,1); assert.equal(data.user.nickname,null); assert.equal(data.user.last_report_at,null);
  assert.equal((await f.request('/report','POST',{},'connect-1')).status,401);
});
