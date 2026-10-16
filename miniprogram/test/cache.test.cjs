const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let now = Date.parse('2026-10-16T01:00:00Z'); class Clock extends Date { static now() { return now; } }
  const calls=[],store=new Map([['session_token','session'],['account_known',true]]), module={exports:{}};
  const wx={getStorageSync:k=>store.get(k),setStorageSync:(k,v)=>store.set(k,v),removeStorageSync:k=>store.delete(k),clearStorageSync:()=>store.clear(),request:o=>calls.push(o)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/api.js'),'utf8'),{wx,module,Date:Clock,require:id=>require(path.join(__dirname,'../utils',path.basename(id)))});
  return {api:module.exports,calls,store,advance:ms=>now+=ms,now:()=>now};
}
function reply(f,data,status=200) { f.calls.at(-1).success({statusCode:status,data}); }
async function resolve(f,p,data) {reply(f,data);return p;}
test('普通数据在五分钟内复用；到期或下拉强制刷新才发送新请求，并发访问合并',async()=>{
  const f=fixture(),a=f.api.myUsage('day'),b=f.api.myUsage('day');assert.equal(f.calls.length,1);reply(f,{summary:{tokens:1}});await a;await b;
  f.advance(61_000);for(let i=0;i<20;i++)await f.api.myUsage('day');assert.equal(f.calls.length,1);
  f.advance(238_999);await f.api.myUsage('day');assert.equal(f.calls.length,1);
  f.advance(2);await resolve(f,f.api.myUsage('day'),{summary:{tokens:2}});assert.equal(f.calls.length,2);
  await resolve(f,f.api.myUsage('day',{force:true}),{summary:{tokens:3}});assert.equal(f.calls.length,3);assert.equal(f.api.peekUsage('day').summary.tokens,3);
});
test('日历和自然周的省略日期与显式日期使用同一缓存；北京时间换月换周后读新范围',async()=>{
  const f=fixture();await resolve(f,f.api.calendar(),{month:'2026-10'});await f.api.calendar('2026-10');assert.equal(f.calls.length,1);assert.ok(f.api.peekCalendar('2026-10'));
  await resolve(f,f.api.weekly(),{from:'2026-10-05'});await f.api.weekly('2026-10-05');assert.equal(f.calls.length,2);assert.ok(f.api.peekWeekly());
  f.advance(3*86400000);const week=f.api.weekly();assert.match(f.calls.at(-1).url,/week=2026-10-12/);await resolve(f,week,{from:'2026-10-12'});
  f.advance(16*86400000);const month=f.api.calendar();assert.match(f.calls.at(-1).url,/month=2026-11/);await resolve(f,month,{month:'2026-11'});
});
test('分享摘要按类型、周期和群合并并缓存；无关日历读取不会重复创建，刷新源数据会生成新摘要',async()=>{
  const f=fixture();await resolve(f,f.api.myUsage('day'),{summary:{tokens:1}});
  const first=f.api.createShare('day'),duplicate=f.api.createShare('day');assert.equal(f.calls.length,2);reply(f,{id:'a'.repeat(24)});assert.equal(await first,await duplicate);
  for(let i=0;i<10;i++)await f.api.createShare('day');assert.equal(f.calls.length,2);
  await resolve(f,f.api.calendar(),{month:'2026-10'});await f.api.createShare('day');assert.equal(f.calls.length,3);
  await resolve(f,f.api.createShare('day','tools'),{id:'b'.repeat(24)});assert.equal(f.calls.length,4);
  await resolve(f,f.api.createShare('day','usage','g1'),{id:'c'.repeat(24)});assert.equal(f.calls.length,5);
  await resolve(f,f.api.myUsage('day',{force:true}),{summary:{tokens:2}});await resolve(f,f.api.createShare('day'),{id:'d'.repeat(24)});assert.equal(f.calls.length,7);
  await resolve(f,f.api.createShare('day','usage','',{force:true}),{id:'e'.repeat(24)});assert.equal(f.calls.length,8);
});
test('周报按数据版本、群和账号资料缓存；版本改变与撤销链接立即作废旧缓存',async()=>{
  const f=fixture(),data={week:'2026-10-05',week_snapshot:'a'.repeat(64)};
  await resolve(f,f.api.createWeeklyShare(data),{id:'a'.repeat(24)});await f.api.createWeeklyShare(data);assert.equal(f.calls.length,1);
  await resolve(f,f.api.createWeeklyShare({...data,group_id:'g'}),{id:'b'.repeat(24)});assert.equal(f.calls.length,2);
  await resolve(f,f.api.createWeeklyShare({...data,week_snapshot:'b'.repeat(64)}),{id:'c'.repeat(24)});assert.equal(f.calls.length,3);
  await resolve(f,f.api.revokeShare('a'.repeat(24)),{revoked:true});await resolve(f,f.api.createWeeklyShare(data),{id:'d'.repeat(24)});assert.equal(f.calls.length,5);
  await resolve(f,f.api.setRanking(true),{rank_hidden:true});await resolve(f,f.api.createWeeklyShare(data),{id:'e'.repeat(24)});assert.equal(f.calls.length,7);
});
test('接口失败不写分享缓存，重试可重新请求；服务端记录提前过期也不能复用',async()=>{
  const f=fixture(),failure=f.api.createWeeklyShare({week_snapshot:'a'}),rejected=assert.rejects(failure,/changed/);reply(f,{error:'changed'},409);await rejected;
  await resolve(f,f.api.createWeeklyShare({week_snapshot:'a'}),{id:'a'.repeat(24),expires_at:f.now()+1000});assert.equal(f.calls.length,2);
  f.advance(1001);await resolve(f,f.api.createWeeklyShare({week_snapshot:'a'}),{id:'b'.repeat(24)});assert.equal(f.calls.length,3);
});
test('群内PK按所选快照缓存，换名次或快照重新查询；公开作者记录仍实时检查是否撤销',async()=>{
  const f=fixture(),data={period:'week',rank:2,snapshot:'a'.repeat(64)};
  await resolve(f,f.api.groupComparison('g',data),{transient:true});await f.api.groupComparison('g',data);assert.equal(f.calls.length,1);
  await resolve(f,f.api.groupComparison('g',{...data,rank:3}),{transient:true});assert.equal(f.calls.length,2);
  await resolve(f,f.api.groupComparison('g',{...data,snapshot:'b'.repeat(64)}),{transient:true});assert.equal(f.calls.length,3);
  await resolve(f,f.api.sharedRecord('a'.repeat(24)),{id:'a'.repeat(24)});
  const blocked=f.api.sharedRecord('a'.repeat(24)),rejected=assert.rejects(blocked,/撤销/);reply(f,{error:'已撤销'},404);await rejected;assert.equal(f.calls.length,5);
  assert.equal(f.calls.at(-1).header.authorization,undefined);
});
test('注销中的迟到分享不能恢复缓存，任何摘要都不写入持久化存储',async()=>{
  const f=fixture(),share=f.api.createShare('day'),shareRequest=f.calls[0],late=assert.rejects(share,/重新登录/);
  const deletion=f.api.deleteAccount();await flush();reply(f,{deleted:true});await deletion;
  shareRequest.success({statusCode:200,data:{id:'private-share',usage:{tokens:123}}});await late;
  assert.deepEqual([...f.store],[['account_state','deleted']]);await assert.rejects(f.api.createShare('day'),/重新登录/);
});
