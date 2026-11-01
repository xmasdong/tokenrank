import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {requestFixture} from './helpers/request-fixture.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const path of ['/api/my/overview','/api/my/groups-overview','/api/groups/g1/page']){
 test(`${path} 的统计不等待无关的资料查询；权限和响应内容保持有效`,async t=>{
  const f=requestFixture(t,worker),raw=f.env.DB.prepare.bind(f.env.DB),started=[];let release;
  const gate=new Promise(resolve=>release=resolve);
  f.env.DB.prepare=sql=>{
   const statement=raw(sql);
   for(const method of ['first','all','run']){const original=statement[method].bind(statement);statement[method]=async()=>{
    started.push(sql);if(sql.includes('c.user_id AS connected_user_id'))await gate;return original();
   };}
   return statement;
  };
  const pending=f.req(path);await flush();
  const overlapped=started.some(sql=>/FROM (?:public_usage|ranked_usage)/.test(sql));
  release();const response=await pending;
  assert.equal(overlapped,true);assert.equal(response.status,200);assert.equal(response.data.user.user_id,1);
  if(path.includes('/groups/g1'))assert.ok(response.data.insights && response.data.board);
 });
}
test('接口响应提供服务端耗时，认证失败仍保留原状态及错误正文',async t=>{
 const f=requestFixture(t,worker);
 for(const path of ['/healthz','/api/my/overview','/not-found']){
  const r=await worker.fetch(new Request('https://rank.test'+path),f.env);
  assert.match(r.headers.get('Server-Timing'),/^app;dur=\d+(?:\.\d+)?$/);
  assert.equal(r.status,path==='/healthz'?200:path==='/not-found'?404:401);
 }
});
