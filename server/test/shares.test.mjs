import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestFixture} from './helpers/request-fixture.mjs';
import {saveShare,readShare} from '../src/shares.js';
const snapshot=n=>({user:{nickname:'真实字段测试'},usage:{summary:{tokens:n}}});
function seed(db,uid,count,at){
 const insert=db.prepare('INSERT INTO usage_shares(id,user_id,fingerprint,snapshot_json,created_at,expires_at) VALUES(?,?,?,?,?,?)');
 for(let n=0;n<count;n++)insert.run(`${uid}-${n}`,uid,`seed-${n}`,JSON.stringify(snapshot(n)),at,Date.now()+86400000);
}
test('过去24小时已创建50条仍可准备新卡，不删除或改写旧分享',async t=>{
 const f=requestFixture(t,null,{groups:0,users:1});seed(f.db,1,50,Date.now()-120000);
 const old=f.db.prepare('SELECT * FROM usage_shares ORDER BY id').all();
 const r=await saveShare(f.env,1,snapshot(1000));assert.equal(r.status,200);
 const record=await r.json();assert.equal(record.usage.summary.tokens,1000);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_shares').get().n,51);
 for(const row of old)assert.deepEqual(f.db.prepare('SELECT * FROM usage_shares WHERE id=?').get(row.id),row);
});
test('每分钟最多60条新摘要；相同内容复用不限流，其他账号独立，窗口过期自动恢复',async t=>{
 const f=requestFixture(t,null,{groups:0,users:2});seed(f.db,1,59,Date.now());
 const first=await(await saveShare(f.env,1,snapshot(1000))).json();
 const reuse=await saveShare(f.env,1,snapshot(1000));assert.equal(reuse.status,200);assert.equal((await reuse.json()).id,first.id);
 const limited=await saveShare(f.env,1,snapshot(1001));assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'60');assert.doesNotMatch((await limited.json()).error,/明天|今天/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_shares WHERE user_id=1').get().n,60);
 assert.equal((await saveShare(f.env,2,snapshot(1001))).status,200);
 f.db.prepare('UPDATE usage_shares SET created_at=? WHERE user_id=1').run(Date.now()-60001);
 assert.equal((await saveShare(f.env,1,snapshot(1001))).status,200);
});
test('并发创建也在写入时限流，不超额；重复新摘要共用同一记录',async t=>{
 const f=requestFixture(t,null,{groups:0,users:1});seed(f.db,1,59,Date.now());
 const responses=await Promise.all(Array.from({length:8},(_,n)=>saveShare(f.env,1,snapshot(1000+n))));
 assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.status===429).length,7);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_shares').get().n,60);
 const g=requestFixture(t,null,{groups:0,users:1});
 const duplicates=await Promise.all(Array.from({length:5},()=>saveShare(g.env,1,snapshot(1000))));
 const records=await Promise.all(duplicates.map(r=>r.json()));assert.equal(new Set(records.map(r=>r.id)).size,1);
 assert.equal(g.db.prepare('SELECT COUNT(*) n FROM usage_shares').get().n,1);
});
test('过期或撤销的摘要不能绕过短时限流恢复；恢复后仍遵守来源有效期',async t=>{
 const f=requestFixture(t,null,{groups:0,users:1});
 const record=await(await saveShare(f.env,1,snapshot(1000))).json();
 f.db.prepare('UPDATE usage_shares SET revoked_at=? WHERE id=?').run(Date.now(),record.id);assert.equal(await readShare(f.env,record.id),null);
 seed(f.db,1,59,Date.now());assert.equal((await saveShare(f.env,1,snapshot(1000))).status,429);assert.equal(await readShare(f.env,record.id),null);
 f.db.prepare('UPDATE usage_shares SET created_at=?').run(Date.now()-60001);
 const expiry=Date.now()+60000,renewed=await(await saveShare(f.env,1,snapshot(1000),{expires_at:expiry})).json();
 assert.notEqual(renewed.id,record.id);assert.equal(renewed.expires_at,expiry);
});
