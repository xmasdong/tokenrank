const {test}=require('node:test'),assert=require('node:assert/strict');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const file=require.resolve('../utils/daily-reminder');delete require.cache[file];
  const {createDailyReminder}=require(file);
  let epoch=0,state='',cache=null,readResult=null,saveError='';
  const calls=[],sdk=[],frames=[];
  const status={has_reported:true,kinds:[{key:'daily',available:true,template_id:'approved-daily-template',scheduled_at:Date.now()+86400000,report_day:'2026-10-19',appointment:{id:'a'.repeat(24),state:'sent',report_day:'2026-10-18'}}]};
  readResult=status;
  const api={accountEpoch:()=>epoch,accountState:()=>state,peekReminders:()=>cache,ensureSession:async()=>{},
    reminders:async options=>{calls.push(['get',options]);cache=readResult;return readResult;},
    reserveReminder:async(kind,requestId)=>{calls.push(['save',kind,requestId]);if(saveError)throw Error(saveError);
      cache={...status,kinds:status.kinds.map(item=>({...item,appointment:{id:'b'.repeat(24),state:'pending',scheduled_at:item.scheduled_at,report_day:item.report_day}}))};return cache;}};
  const wx={requestSubscribeMessage:options=>{calls.push(['sdk']);sdk.push(options);}};
  const c=createDailyReminder(api,wx,value=>frames.push(value));
  return {c,api,wx,status,calls,sdk,frames,last:()=>frames.at(-1),cache:value=>cache=value,read:value=>readResult=value,fail:value=>saveError=value,
    delete:()=>{epoch++;state='deleted';},remount:()=>createDailyReminder(api,wx,value=>frames.push(value)),
    accept:()=>sdk.at(-1).success({'approved-daily-template':'accept'})};
}
test('读完日报只展示预约入口，用户真实点击才同步调用微信授权，授权前不保存',async()=>{
  const f=fixture();await f.c.show();assert.equal(f.sdk.length,0);assert.equal(f.last().item.canBook,true);
  f.calls.length=0;f.c.subscribe();assert.deepEqual(f.calls,[['sdk']]);assert.equal(f.last().busy,true);f.c.subscribe();assert.equal(f.sdk.length,1);
  await f.accept();assert.equal(f.calls[1][0],'save');assert.equal(f.calls[1][1],'daily');assert.ok(f.calls[1][2].length>=16);
  assert.equal(f.last().item.booked,true);assert.equal(f.last().item.dayText,'2026-10-19');assert.equal(f.last().busy,false);assert.equal(f.last().savePending,false);
});
test('拒绝、记住选择和SDK失败不冒充成功，未配置模板不调授权',async()=>{
  const f=fixture();await f.c.show();f.c.subscribe();f.sdk[0].success({errMsg:'ok'});assert.equal(f.calls.filter(call=>call[0]==='save').length,0);assert.match(f.last().notice,/未授权/);
  f.c.subscribe();f.sdk[1].success({'approved-daily-template':'reject'});assert.equal(f.last().item.booked,false);
  f.c.subscribe();f.sdk[2].fail({errCode:20004});assert.match(f.last().notice,/未允许/);assert.equal(f.last().busy,false);
  const g=fixture();g.read({...g.status,kinds:[{key:'daily',available:false}]});await g.c.show();g.c.subscribe();assert.equal(g.sdk.length,0);
});
test('保存失败显示待保存，用同一个请求重试，不重复消耗原生授权；离页后仍能恢复',async()=>{
  const f=fixture();await f.c.show();f.fail('离线');f.c.subscribe();await f.accept();const requestId=f.calls.at(-1)[2];
  assert.equal(f.last().savePending,true);assert.equal(f.last().item.booked,false);assert.match(f.last().notice,/尚未确认/);
  f.c.hide();const next=f.remount();await next.show();assert.equal(f.last().savePending,true);
  f.fail('');await next.save();assert.equal(f.sdk.length,1);assert.equal(f.calls.at(-1)[2],requestId);assert.equal(f.last().item.booked,true);
});
test('通知标识命中旧预约或缓存的预约已到期时，只刷新提醒状态，不读取任何用量',async()=>{
  const f=fixture(),old={...f.status,kinds:[{...f.status.kinds[0],appointment:{id:'a'.repeat(24),state:'pending',scheduled_at:Date.now()+86400000,report_day:'2026-10-19'}}]};
  f.cache(old);await f.c.show({sourceId:'a'.repeat(24)});assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].force,true);assert.equal(f.last().item.canBook,true);
  f.c.hide();await f.c.show({sourceId:'a'.repeat(24)});assert.equal(f.calls.length,1);
  const g=fixture();g.cache({...g.status,kinds:[{...g.status.kinds[0],appointment:{id:'x',state:'pending',scheduled_at:Date.now()-60000}}]});await g.c.show();assert.equal(g.calls[0][1].force,true);
});
test('已预约时展示预约时间，不再弹原生授权；普通返回复用缓存，手动刷新才读取',async()=>{
  const f=fixture();f.cache({...f.status,kinds:[{...f.status.kinds[0],appointment:{state:'pending',scheduled_at:f.status.kinds[0].scheduled_at,report_day:'2026-10-19'}}]});
  await f.c.show();f.c.subscribe();assert.equal(f.sdk.length,0);assert.equal(f.calls.length,0);assert.equal(f.last().item.booked,true);assert.ok(f.last().item.timeText);
  f.c.hide();await f.c.show();assert.equal(f.calls.length,0);await f.c.load({force:true});assert.equal(f.calls.length,1);
});
test('授权后离页仍保存用户同意；注销后的迟到授权不保存，新账号不会继承重试任务',async()=>{
  const f=fixture();await f.c.show();f.c.subscribe();f.c.hide();await f.accept();assert.equal(f.calls.at(-1)[0],'save');
  const g=fixture();await g.c.show();g.c.subscribe();g.delete();await g.accept();assert.equal(g.calls.filter(call=>call[0]==='save').length,0);
  const h=fixture();await h.c.show();h.fail('offline');h.c.subscribe();await h.accept();h.delete();const next=h.remount();await next.show();await next.save();assert.equal(h.calls.filter(call=>call[0]==='save').length,1);
});
test('慢到达的读取不覆盖刚完成的预约，读取失败不阻塞日报也不索取无效授权',async()=>{
  const f=fixture();f.cache(f.status);await f.c.show();let finish;f.api.reminders=()=>new Promise(resolve=>finish=resolve);
  const read=f.c.load({force:true});await flush();f.c.subscribe();await f.accept();finish(f.status);await read;assert.equal(f.last().item.booked,true);
  const g=fixture();g.api.reminders=async()=>{throw Error('网络失败');};await g.c.show();assert.match(g.last().error,/网络失败/);g.c.subscribe();assert.equal(g.sdk.length,0);
});
test('跨过发送时间时更新下一次日期，不能因五分钟缓存把预约时间留在过去',async()=>{
  const f=fixture();await f.c.show();assert.equal(f.calls.length,1);f.c.hide();
  f.status.kinds[0].scheduled_at=Date.now()-1;
  f.read({...f.status,kinds:[{...f.status.kinds[0],scheduled_at:Date.now()+86400000,report_day:'2026-10-20'}]});
  await f.c.show();assert.equal(f.calls.length,2);assert.equal(f.calls[1][1].force,true);assert.equal(f.last().item.dayText,'2026-10-20');
});
