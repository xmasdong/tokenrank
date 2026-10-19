const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const prompt=require('../utils/reminder-prompt'),queue=require('../utils/modal-queue');
const flush=()=>new Promise(r=>setImmediate(r));
function setup(){queue._reset();prompt._reset();const store=new Map(),modals=[],navigation=[],acks=[];let epoch=0,state='',visible=true;
 const api={accountEpoch:()=>epoch,accountState:()=>state,ackReminderPrompt:()=>{acks.push(1);return Promise.resolve();}};
 const wx={getStorageSync:k=>store.get(k),setStorageSync:(k,v)=>store.set(k,v),showModal:o=>modals.push(o),navigateTo:o=>navigation.push(o.url)};
 const user={user_id:1,reminder_prompt_eligible:true,reminder_kinds:['weekly','sync_error']};
 return {wx,api,user,store,modals,navigation,acks,show:()=>prompt.maybePrompt(api,wx,user,()=>visible),hide:()=>visible=false,delete:()=>{epoch++;state='deleted';},answer:confirm=>{modals.at(-1).success({confirm,cancel:!confirm});modals.at(-1).complete({});}};
}
test('首次真实接入询问一次；去设置后仍需用户在页面点原生授权按钮',()=>{const f=setup();assert.equal(f.show(),true);assert.match(f.modals[0].content,/每项提醒一次/);assert.equal(f.show(),false);f.answer(true);assert.deepEqual(f.navigation,['/pages/reminders/reminders?from=first']);assert.equal(f.acks.length,1);assert.equal(f.show(),false);prompt._reset();assert.equal(f.show(),false);});
test('拒绝只关闭询问，不阻断查看；本地按账号去重，确认失败也不每次轮询重弹',async()=>{const f=setup();f.api.ackReminderPrompt=async()=>{throw Error('network');};f.show();f.answer(false);await flush();assert.equal(f.show(),false);assert.equal(f.navigation.length,0);f.user.user_id=2;assert.equal(f.show(),true);});
test('未上报、旧用户、模板未配和公开只读页面不会凭空询问',()=>{const f=setup();for(const user of [{user_id:1},{...f.user,reminder_prompt_eligible:false},{...f.user,reminder_kinds:[]}])assert.equal(prompt.maybePrompt(f.api,f.wx,user),false);f.hide();assert.equal(f.show(),false);assert.equal(f.modals.length,0);});
test('和说明弹窗排队；页面已隐藏或账号注销则跳过，不提前记为已询问',()=>{const f=setup();queue.hold();f.show();assert.equal(f.modals.length,0);f.hide();queue.release();assert.equal(f.modals.length,0);assert.equal(f.store.size,0);assert.equal(f.acks.length,0);
 const g=setup();queue.hold();g.show();g.delete();queue.release();assert.equal(g.modals.length,0);assert.equal(g.store.size,0);});
function page(){let definition,epoch=0,state='';const calls=[],sdk=[],toasts=[],navigation=[];let saveError=null;
 const status={has_reported:true,kinds:[{key:'weekly',label:'下期周报',available:true,template_id:'real-loaded-template',scheduled_at:Date.now()+86400000,appointment:null},{key:'sync_error',label:'同步异常',available:false,template_id:null,appointment:null}]};
 const api={accountEpoch:()=>epoch,accountState:()=>state,peekReminders:()=>null,ensureSession:async()=>{},reminders:async()=>status,
 reserveReminder:async(kind,requestId)=>{calls.push(['save',kind,requestId]);if(saveError)throw Error(saveError);return {...status,kinds:status.kinds.map(k=>k.key===kind?{...k,appointment:{id:'a'.repeat(24),state:'pending',scheduled_at:status.kinds[0].scheduled_at}}:k)};},
 cancelReminder:async(kind,id)=>{calls.push(['cancel',kind,id]);return status;}};
 const wx={requestSubscribeMessage:o=>{calls.push(['sdk']);sdk.push(o);},showToast:o=>toasts.push(o.title),navigateTo:o=>navigation.push(o.url),stopPullDownRefresh(){},openSetting:o=>calls.push(['settings',o])};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/reminders/reminders.js'),'utf8'),{require:()=>api,wx,Page:o=>definition=o,Date,Math});
 const p={...definition,data:JSON.parse(JSON.stringify(definition.data)),setData(value){Object.assign(this.data,value);}};
 const tap=kind=>p.subscribe({currentTarget:{dataset:{kind}}});
 return {p,api,wx,status,calls,sdk,toasts,navigation,tap,failSave:value=>saveError=value,delete:()=>{epoch++;state='deleted';}};
}
test('原生授权在用户点击时同步调用；不先登录或请求，未配置项绝不调用SDK',async()=>{const f=page();await f.p.onShow();f.tap('sync_error');assert.equal(f.sdk.length,0);f.tap('weekly');assert.equal(f.calls[0][0],'sdk');assert.equal(f.sdk.length,1);assert.deepEqual([...f.sdk[0].tmplIds],['real-loaded-template']);assert.equal(f.calls.length,1);});
test('success回调不等于授权成功，必须对应模板accept；拒绝不生成预约',async()=>{const f=page();await f.p.onShow();f.tap('weekly');f.sdk[0].success({'real-loaded-template':'reject'});assert.equal(f.calls.length,1);assert.match(f.p.data.notice,/未授权/);assert.equal(f.p.data.busy,'');f.tap('weekly');f.sdk[1].success({errMsg:'ok'});assert.equal(f.calls.length,2);});
test('微信accept后才保存服务端预约，服务端确认前不能显示成功',async()=>{const f=page();await f.p.onShow();f.tap('weekly');const result=f.sdk[0].success({'real-loaded-template':'accept'});assert.equal(f.calls[1][0],'save');assert.ok(f.calls[1][2].length>=16);assert.doesNotMatch(f.p.data.notice,/已预约/);await result;assert.equal(f.p.data.items[0].statusText,'已预约本次');assert.equal(f.p.data.busy,'');});
test('保存失败保留同一个幂等请求，重试不重新请求微信授权',async()=>{const f=page();await f.p.onShow();f.failSave('offline');f.tap('weekly');await f.sdk[0].success({'real-loaded-template':'accept'});assert.equal(f.p.data.savePending,'weekly');assert.match(f.p.data.notice,/尚未确认/);const id=f.calls[1][2];f.failSave(null);await f.p.saveAppointment();assert.equal(f.sdk.length,1);assert.equal(f.calls[2][2],id);assert.equal(f.p.data.savePending,'');});
test('授权后离页仍保存已确认意图，回到页面不会卡住；注销后迟到回调不写预约',async()=>{const f=page();await f.p.onShow();f.tap('weekly');f.p.onHide();await f.sdk[0].success({'real-loaded-template':'accept'});assert.equal(f.calls[1][0],'save');assert.equal(f.p.data.busy,'');
 const g=page();await g.p.onShow();g.tap('weekly');g.delete();await g.sdk[0].success({'real-loaded-template':'accept'});assert.equal(g.calls.length,1);assert.equal(g.p.data.items[0].appointment,null);});
test('预约取消走本人预约ID；微信总开关关闭如实显示，普通刷新不触发授权',async()=>{const f=page();await f.p.onShow();f.tap('weekly');f.sdk[0].fail({errCode:20004});assert.match(f.p.data.notice,/未允许/);assert.equal(f.calls.length,1);
 f.p.data.items[0].appointment={id:'b'.repeat(24),state:'pending'};await f.p.cancel({currentTarget:{dataset:{kind:'weekly'}}});assert.deepEqual(f.calls[1],['cancel','weekly','b'.repeat(24)]);await f.p.onPullDownRefresh();assert.equal(f.sdk.length,1);});
test('没有首次同步不能预约，失败显示错误而不是伪造设置',async()=>{const f=page();f.status.has_reported=false;await f.p.onShow();f.tap('weekly');assert.equal(f.sdk.length,0);f.api.reminders=async()=>{throw Error('正式接口失败');};await f.p.onPullDownRefresh();assert.equal(f.p.data.error,'正式接口失败');});
test('我的、周报、接入页都有设置入口，首次提示只导航不越过点击直接调授权',()=>{for(const name of ['profile','weekly','connect']){assert.match(fs.readFileSync(path.join(__dirname,`../pages/${name}/${name}.wxml`),'utf8'),/bindtap="goReminders"/);}assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../utils/reminder-prompt.js'),'utf8'),/wx\.requestSubscribeMessage/);});
