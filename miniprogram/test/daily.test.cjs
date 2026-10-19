const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
const report=(day='2026-10-18')=>({day,from:day,to:day,snapshot:'a'.repeat(64),period:'day',has_history:true,token_basis:'upstream_total',timezone:'Asia/Shanghai',summary:{tokens:258000000,requests:1382,cache_read:200000000,cache_write:0,input_tokens:50000000,output_tokens:8000000},daily:[{day,tokens:258000000,requests:1382}],tools:[{name:'Claude Code',tokens:258000000,percent:100}],models:[{name:'Model',tokens:258000000,percent:100}],top_tool:{name:'Claude Code'},top_model:{name:'Model'},previous_day:'2026-10-17',next_day:null});
function fixture(){let def,epoch=0,state='',cached=null;const calls=[],shares=[],navigation=[];const api={accountEpoch:()=>epoch,accountState:()=>state,ensureSession:async()=>{},peekReminders:()=>({has_reported:true,kinds:[{key:'daily',available:false}]}),reminders:async()=>({has_reported:true,kinds:[{key:'daily',available:false}]}),peekDaily:()=>cached,createDailyShare:async body=>{shares.push(body);return {id:'a'.repeat(24),style:'daily',user:{nickname:'原作者'},usage:report(body.day)};},daily:async(day,o)=>{calls.push([day,o]);return report(day||'2026-10-18');}};const wx={hideShareMenu(){},showShareMenu(){},navigateTo:o=>navigation.push(o.url),stopPullDownRefresh(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/daily/daily.js'),'utf8'),{require:id=>id.endsWith('/api')?api:require('../utils/'+path.basename(id)),wx,Page:o=>def=o});const p={...def,data:structuredClone(def.data),setData(o){Object.assign(this.data,o);}};
 return {p,api,wx,calls,shares,navigation,cache:r=>cached=r,change:()=>{epoch++;state='';cached=null;},remove:()=>{epoch++;state='deleted';}};
}
test('通知链接按指定日期打开日报，含缓存总量、调用数和工具模型来自同一个真实报表',async()=>{const f=fixture();f.p.onLoad({day:'2026-10-18'});await f.p.onShow();assert.equal(f.calls[0][0],'2026-10-18');assert.equal(f.p.data.report.value,'2.58');assert.equal(f.p.data.report.unit,'亿');assert.equal(f.p.data.report.requestsText,'1,382');assert.equal(f.p.data.report.topTool,'Claude Code');assert.equal(f.p.data.report.topModel,'Model');});
test('缺记录不造0；缓存返回不清空报表、展开状态或重复调用接口，手动刷新才取新数据',async()=>{const f=fixture(),r=report();f.cache(r);await f.p.onShow();f.p.toggleDetails();f.p.onHide();await f.p.onShow();assert.equal(f.calls.length,0);assert.equal(f.p.data.expanded,true);await f.p.onPullDownRefresh();assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].force,true);
 f.api.daily=async()=>({...r,has_history:false,summary:{tokens:null,requests:null},tools:[],models:[],top_tool:null,top_model:null});await f.p.onPullDownRefresh();assert.equal(f.p.data.report.has_history,false);assert.equal(f.p.data.report.summary.tokens,null);});
test('切日、离页及注销后的迟到响应不覆盖当前用户或日期',async()=>{const f=fixture(),pending=[];f.api.daily=(day)=>new Promise(resolve=>pending.push({day,resolve}));const first=f.p.onShow();await flush();const next=f.p.switchDay({currentTarget:{dataset:{day:'2026-10-17'}}});await flush();pending[1].resolve(report('2026-10-17'));await next;pending[0].resolve(report());await first;assert.equal(f.p.data.report.day,'2026-10-17');
 const hidden=f.p.load({force:true});await flush();f.p.onHide();pending.at(-1).resolve(report());await hidden;assert.equal(f.p.data.report.day,'2026-10-17');
 f.remove();await f.p.onShow();assert.equal(f.p.data.report,null);assert.equal(f.navigation.at(-1),'/pages/account/account');});
test('管理提醒入口只导航到设置，直接续订使用独立的点击操作',async()=>{const f=fixture();await f.p.onShow();f.p.goReminders();assert.equal(f.navigation[0],'/pages/reminders/reminders?kind=daily');assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../pages/daily/daily.js'),'utf8'),/requestSubscribeMessage/);});
test('通知详情直接点击续订，不随进入或切换历史日期自动授权；预约使用下次日期',async()=>{
 const f=fixture(),sdk=[],saves=[];let status={has_reported:true,kinds:[{key:'daily',available:true,template_id:'approved-template',report_day:'2026-10-19',scheduled_at:Date.now()+86400000,appointment:{id:'a'.repeat(24),state:'sent'}}]};
 f.api.peekReminders=()=>status;f.api.reserveReminder=async(kind,id)=>{saves.push([kind,id]);status={...status,kinds:[{...status.kinds[0],appointment:{id:'b'.repeat(24),state:'pending',report_day:'2026-10-19',scheduled_at:status.kinds[0].scheduled_at}}]};return status;};
 f.wx.requestSubscribeMessage=options=>sdk.push(options);f.p.onLoad({day:'2026-10-18',reminder_id:'a'.repeat(24)});await f.p.onShow();assert.equal(sdk.length,0);assert.equal(f.p.data.reminder.item.canBook,true);
 f.p.subscribeNextDaily();assert.equal(sdk.length,1);await sdk[0].success({'approved-template':'accept'});assert.equal(saves.length,1);assert.equal(f.p.data.reminder.item.booked,true);assert.equal(f.p.data.reminder.item.dayText,'2026-10-19');assert.equal(f.p.data.report.day,'2026-10-18');
 await f.p.switchDay({currentTarget:{dataset:{day:'2026-10-17'}}});f.p.subscribeNextDaily();assert.equal(sdk.length,1);assert.equal(f.p.data.reminder.item.booked,true);
});
test('日报提前准备指定日期的公开分享，图片未生成也能一键转发，返回不重复生成',async()=>{
 const f=fixture();f.p.onLoad({day:'2026-10-18'});await f.p.onShow();assert.equal(f.shares[0].day,'2026-10-18');assert.equal(f.shares[0].day_snapshot,'a'.repeat(64));
 const card=f.p.onShareAppMessage();assert.equal(card.path,'/pages/record/record?id='+'a'.repeat(24));assert.match(card.title,/10.18.*2.58亿.*1,382/);assert.doesNotMatch(card.path,/pages\/daily|reminder_id/);
 f.p.onHide();await f.p.onShow();assert.equal(f.shares.length,1);assert.equal(f.p.data.socialPosterPath,'');
 await f.p.switchDay({currentTarget:{dataset:{day:'2026-10-17'}}});assert.equal(f.shares.at(-1).day,'2026-10-17');assert.match(f.p.onShareAppMessage().title,/10.17/);
});
test('切日期和注销后迟到的分享不能覆盖新卡片，数据版本冲突只刷新重试一次',async()=>{
 const f=fixture(),waiting=[];f.api.createDailyShare=body=>new Promise(resolve=>waiting.push({body,resolve}));f.p.onLoad({day:'2026-10-18'});const first=f.p.onShow();await flush();
 const next=f.p.switchDay({currentTarget:{dataset:{day:'2026-10-17'}}});assert.equal(f.p.onShareAppMessage().path,'/pages/index/index');await flush();
 waiting[1].resolve({id:'b'.repeat(24),style:'daily',user:{nickname:'甲'},usage:report('2026-10-17')});await next;waiting[0].resolve({id:'a'.repeat(24),style:'daily',user:{nickname:'甲'},usage:report()});await first;assert.equal(f.p.data.record.id,'b'.repeat(24));
 f.remove();await f.p.onShow();assert.equal(f.p.data.record,null);assert.equal(f.p.onShareAppMessage().path,'/pages/index/index');
 const g=fixture();let tries=0;g.api.createDailyShare=async()=>{tries++;const error=new Error('changed');error.code='DAY_CHANGED';throw error;};await g.p.onShow();assert.equal(tries,2);assert.equal(g.p.data.record,null);assert.equal(g.p.data.shareError,'changed');
});
test('分享图片使用微信原生菜单并指定作者公开页，不把自己的私有日报发出去',async()=>{
 const f=fixture(),menus=[],previews=[];await f.p.onShow();f.wx.showShareImageMenu=options=>menus.push(options);f.wx.previewImage=options=>previews.push(options);f.p.setData({socialPosterPath:'/tmp/daily-poster.png'});
 f.p.shareDailyImage();assert.equal(menus[0].path,'/tmp/daily-poster.png');assert.equal(menus[0].needShowEntrance,true);assert.equal(menus[0].entrancePath,'/pages/record/record?id='+'a'.repeat(24));
 menus[0].fail({errMsg:'cancel'});assert.equal(previews.length,0);menus[0].fail({errMsg:'unsupported'});assert.equal(previews.length,1);
});
