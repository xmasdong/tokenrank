const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const prompt=require('../utils/achievement-prompt'),queue=require('../utils/modal-queue');
const {badgeView,catalogueView}=require('../utils/milestones');
const flush=()=>new Promise(r=>setImmediate(r));
const milestone=(family='total',threshold=1e8)=>({id:family+':'+threshold,family,label:family==='total'?'累计用量':'单日用量',art:family==='total'?'usage-orbit':'milestone-peaks',threshold,current:258000000,unit:'Tokens',metric_label:family==='total'?'累计含缓存总量':'历史单日最高',earned:true,achieved_day:'2026-10-01',tier:1});
function setup(){queue._reset();prompt._reset();let epoch=0,active=true,state='',readCalls=0,claims=0,presented=0,done;
 const user={user_id:1,last_report_at:1},data={pending:['total:100000000']};
 const api={accountEpoch:()=>epoch,accountState:()=>state,achievements:async()=>{readCalls++;return data;},claimAchievements:async()=>{claims++;return{badge:milestone(),count:2};}};
 const wx={showModal:o=>o.complete?.({confirm:true})};
 return {api,wx,user,data,show:()=>prompt.maybePrompt(api,wx,user,()=>active,(_r,finish)=>{presented++;done=finish;}),get reads(){return readCalls;},get claims(){return claims;},get presented(){return presented;},close:()=>done?.(),hide:()=>active=false,showPage:()=>active=true,remove:()=>{epoch++;state='deleted';}};
}
test('首次解锁等待隐私弹窗，跳原生卡片页前不会消费资格，同一前台周期不重复跳转',async()=>{
 const f=setup();queue.hold();assert.equal(f.show(),true);await flush();assert.equal(f.presented,0);queue.release();await flush();assert.equal(f.claims,0);assert.equal(f.presented,1);
 f.show();assert.equal(f.reads,1);f.close();f.show();assert.equal(f.reads,1);
});
test('离页、注销与过期前台请求不触发展示；未接入不查询',async()=>{
 const f=setup();queue.hold();f.show();await flush();f.hide();queue.release();await flush();assert.equal(f.presented,0);f.showPage();f.show();await flush();assert.equal(f.presented,1);f.close();
 const g=setup();let resolve;g.api.achievements=()=>new Promise(r=>resolve=r);g.show();g.remove();resolve(g.data);await flush();assert.equal(g.presented,0);
 const h=setup();h.user.last_report_at=null;assert.equal(h.show(),false);assert.equal(h.reads,0);
});
test('后台恢复使旧读取失效；读取失败不会阻塞后续原生弹窗',async()=>{
 const f=setup();let resolve;f.api.achievements=()=>new Promise(r=>resolve=r);f.show();prompt.arm();resolve(f.data);await flush();assert.equal(f.presented,0);
 const g=setup();g.api.achievements=async()=>{throw Error('offline');};g.show();await flush();let modal=0;queue.show({showModal:o=>{modal++;o.complete();}},{title:'native'});assert.equal(modal,1);
});
test('展示页面的本地交接仅当前账号有效，结束幂等，不调用旧的领取接口',async()=>{
 const f=setup();let ticket;
 prompt.maybePrompt(f.api,f.wx,f.user,()=>true,(result)=>ticket=result.ticket);await flush();assert.equal(prompt.validTicket(ticket,f.api),true);assert.equal(f.claims,0);
 let modal=0;queue.show({showModal:o=>{modal++;o.complete();}},{title:'native'});assert.equal(modal,0);
 f.remove();assert.equal(prompt.validTicket(ticket,f.api),false);prompt.finish(ticket);prompt.finish(ticket);assert.equal(modal,1);
});
test('成就数字上亿统一两位小数；图片路径白名单，后续设计不伪造达成',()=>{
 const b=badgeView(milestone());assert.equal(b.metricText,'2.58 亿');assert.equal(b.targetText,'1.00 亿');assert.equal(b.artPath,'/assets/badges/tiers/usage-orbit-1.png');assert.equal(badgeView({...milestone(),art:'../secret'}),null);
 const view=catalogueView({families:[{id:'total',enabled:true,art:'usage-orbit',badges:[milestone()]},{id:'build',enabled:false,art:'build-modules',badges:[]}]});assert.equal(view.rows[1].future,true);assert.equal(view.families[1].statusText,'暂未开放');assert.equal(view.families[1].hasEarned,false);
});
function page(apiOverrides={},wxOverrides={}){
 let def;const data={snapshot:'snapshot',earned_count:2,has_source:true,families:[{id:'total',label:'累计用量',enabled:true,art:'usage-orbit',badges:[milestone()]},{id:'peak',label:'单日用量',enabled:true,art:'milestone-peaks',badges:[milestone('peak')]}]};
 const api={accountEpoch:()=>0,accountState:()=>'',ensureLogin:async()=>({user_id:1}),achievements:async()=>data,createAchievementShare:async({badge_id})=>({id:badge_id.startsWith('total')?'a'.repeat(24):'b'.repeat(24),user:{nickname:'本人'},usage:{milestone:milestone(badge_id.split(':')[0])}}),...apiOverrides};
 const wx={getStorageSync:()=>false,setStorageSync(){},stopPullDownRefresh(){},...wxOverrides};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/achievements/achievements.js'),'utf8'),{wx,Page:v=>def=v,require:id=>id.endsWith('/api')?api:require(path.join(__dirname,'../utils',path.basename(id)))});
 const p={...def,data:structuredClone(def.data),setData(v){Object.assign(this.data,v);}};p.buildSocialImages=async()=>{};p.onLoad({});return{p,api,data,wx};
}
test('收藏点奖章打开独立成就卡；分享摘要就绪不必等待图片，切未达成档位撤掉旧分享',async()=>{
 const nav=[],calls=[];const f=page({}, {navigateTo:o=>nav.push(o.url)});await f.p.onShow();f.p.selectFamily({currentTarget:{dataset:{id:'total'}}});assert.deepEqual(nav,['/pages/achievements/achievements?family=total']);
 f.p.onLoad({family:'total'});let imageDone;f.p.buildSocialImages=()=>new Promise(r=>imageDone=r);await f.p.onShow();await flush();
 assert.equal(f.p.data.isDetail,true);assert.equal(f.p.data.selected.badge.family,'total');assert.equal(f.p.data.shareReady,true);assert.equal(f.p.data.socialPosterPath,'');assert.match(f.p.onShareAppMessage().path,/record\/record\?id=/);
 imageDone();await flush();f.p.data.catalogue.families[0].badges.push(badgeView({...milestone('total',1e10),earned:false,achieved_day:null}));
 f.p.selectTier({currentTarget:{dataset:{id:'total:10000000000'}}});assert.equal(f.p.data.selected.badge.earned,false);assert.equal(f.p.data.shareReady,false);assert.equal(f.p.data.socialPosterPath,'');assert.equal(f.p.onShareAppMessage().path,'/pages/index/index');
});
test('失效的卡片链接不替换成别的奖章，账号版本改变后不转发旧成就',async()=>{
 const f=page();f.p.onLoad({badge:'not-a-real-badge'});await f.p.onShow();assert.equal(f.p.data.selected,null);assert.match(f.p.data.error,/奖章不存在/);
 let epoch=0;const g=page({accountEpoch:()=>epoch});await g.p.onShow();await g.p.select('total');epoch++;assert.equal(g.p.onShareAppMessage().path,'/pages/index/index');
});
test('收藏页重播导航失败会提示用户，不再无声失败',async()=>{
 const notices=[];const f=page({}, {navigateTo:o=>o.fail({errMsg:'page limit'}),showToast:o=>notices.push(o.title)});await f.p.onShow();f.p.replayEarned();assert.deepEqual(notices,['页面未打开，请返回后重试']);
});
test('解锁弹层传入编码后的徽章编号仍打开原档位，分享记录保持对应徽章',async()=>{
 const f=page();f.p.onLoad({badge:encodeURIComponent('total:100000000'),share:'1'});await f.p.onShow();await flush();
 assert.equal(f.p.data.error,'');assert.equal(f.p.data.isDetail,true);assert.equal(f.p.data.selected.badge.id,'total:100000000');assert.equal(f.p.data.shareReady,true);
 assert.match(f.p.onShareAppMessage().title,/累计 1.00 亿/);assert.match(f.p.onShareAppMessage().path,/record\/record\?id=/);
});
test('保存成就只在点击时申请原生保存，取消不报成功，拒绝权限给设置入口，过期回调不干扰新卡',()=>{
 const {milestoneSaving}=require('../utils/milestone-save');let save,setting,modal,opened=0;const toasts=[];let epoch=0;
 const wx={saveImageToPhotosAlbum:o=>save=o,showToast:o=>toasts.push(o.title),getSetting:o=>setting=o,showModal:o=>modal=o,openSetting:()=>opened++};
 const p={...milestoneSaving(wx,{accountEpoch:()=>epoch}),_socialVisible:true,_socialVersion:1,data:{socialPosterPath:'current.png'},setData(v){Object.assign(this.data,v);}};
 assert.equal(save,undefined);p.saveMilestoneImage();assert.equal(save.filePath,'current.png');save.fail({errMsg:'cancel'});save.complete();assert.equal(toasts.length,0);assert.equal(setting,undefined);
 p.saveMilestoneImage();save.fail({errMsg:'auth deny'});setting.success({authSetting:{'scope.writePhotosAlbum':false}});assert.equal(opened,0);modal.success({confirm:true});assert.equal(opened,1);save.complete();
 p.saveMilestoneImage();p._socialVersion++;save.success();save.fail({errMsg:'auth deny'});save.complete();assert.equal(toasts.length,0);
 p.saveMilestoneImage();save.success();save.complete();assert.deepEqual(toasts,['已保存到相册']);
 p.saveMilestoneImage();epoch++;save.success();save.complete();assert.equal(toasts.length,1);
});
test('接口失败如实显示错误；缓存数据不被假数或默认奖章替代',async()=>{
 const f=page({achievements:async()=>{throw Error('正式接口失败');}});await f.p.onShow();assert.equal(f.p.data.error,'正式接口失败');assert.equal(f.p.data.catalogue,null);
});
test('快速切换奖章、离页和返回时，旧分享响应不能覆盖当前奖章',async()=>{
 const pending=[];const f=page({createAchievementShare:payload=>new Promise(resolve=>pending.push({payload,resolve}))});await f.p.onShow();
 f.p.select('total');f.p.select('peak');pending[1].resolve({id:'b'.repeat(24),user:{nickname:'作者'},usage:{milestone:milestone('peak')}});await flush();pending[0].resolve({id:'a'.repeat(24),user:{nickname:'作者'},usage:{milestone:milestone()}});await flush();
 assert.equal(f.p.onShareAppMessage().path,'/pages/record/record?id='+'b'.repeat(24));assert.equal(f.p.data.selected.family.id,'peak');assert.equal(f.p.data.shareReady,true);
 f.p.select('total');f.p.onHide();pending[2].resolve({id:'c'.repeat(24)});await flush();assert.equal(f.p.data.shareReady,false);
});
test('公开成就页先展示作者且不静默登录，继续转发保留原分享ID',async()=>{
 let def,logins=0;const record={id:'a'.repeat(24),style:'milestone',user:{nickname:'原作者'},usage:{period:'all',from:'2026-10-01',to:'2026-10-30',summary:{tokens:258000000},tools:[],milestone:milestone(),timezone:'Asia/Shanghai',token_basis:'upstream_total'}};
 const api={sharedRecord:async()=>record,accountEpoch:()=>0,ensureLogin:async()=>logins++};
 const wx={hideShareMenu(){},showShareMenu(){},setNavigationBarTitle(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/record/record.js'),'utf8'),{Page:v=>def=v,wx,require:id=>id.endsWith('/api')?api:id.endsWith('/flow')?{enteredFromGroup:()=>false}:require(path.join(__dirname,'../utils',path.basename(id)))});
 const p={...def,data:structuredClone(def.data),setData(v){Object.assign(this.data,v);}};p.onLoad({id:record.id});await p.onShow();assert.equal(logins,0);assert.equal(p.data.milestone.metricText,'2.58 亿');assert.match(p.onShareAppMessage().title,/原作者.*累计/);assert.equal(p.onShareAppMessage().path,'/pages/record/record?id='+record.id);
 const template=fs.readFileSync(path.join(__dirname,'../pages/record/record.wxml'),'utf8');assert.doesNotMatch(template,/achievement-unlock/);
});
test('首页交接到原生卡片页时不提前释放提示队列，页面结束才释放',async()=>{
 const f=setup();let def,nav,modals=0;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/achievement-unlock/index.js'),'utf8'),{Component:v=>def=v,wx:{navigateTo:o=>nav=o},require:id=>id.endsWith('/api')?f.api:prompt});
 const c={...def.methods,properties:{user:f.user},_active:true};c.maybeShow();await flush();assert.match(nav.url,/achievements.*unlock=1/);
 c._active=false;c.close();queue.show({showModal:o=>{modals++;o.complete();}},{});assert.equal(modals,0);
 const ticket=new URL('https://local.test'+nav.url).searchParams.get('ticket');prompt.finish(ticket);assert.equal(modals,1);assert.equal(f.claims,0);
});
test('自动解锁页准备后等待图片播放，不提前确认；离页释放，迟到的准备响应也释放',async()=>{
 const start=setup();let ticket;prompt.maybePrompt(start.api,start.wx,start.user,()=>true,result=>ticket=result.ticket);await flush();
 let confirms=0;const released=[];
 const f=page({prepareAchievements:async()=>({claim_id:'c'.repeat(32),expires_at:Date.now()+60000,badge:milestone(),count:2,catalogue:f.data}),confirmAchievements:async()=>{confirms++;return{confirmed:true};},releaseAchievements:async id=>released.push(id)});
 f.p.onLoad({unlock:'1',ticket});await f.p.onShow();assert.equal(f.p.data.unlocking,true);assert.equal(f.p.data.newBadgeCount,2);assert.equal(f.p.data.selected.badge.id,'total:100000000');assert.equal(confirms,0);f.p.onHide();assert.deepEqual(released,['c'.repeat(32)]);
 const next=setup();let nextTicket;prompt.maybePrompt(next.api,next.wx,next.user,()=>true,result=>nextTicket=result.ticket);await flush();let resolve;
 const g=page({prepareAchievements:()=>new Promise(r=>resolve=r),releaseAchievements:async id=>released.push(id)});g.p.onLoad({unlock:'1',ticket:nextTicket});const loading=g.p.onShow();await flush();g.p.onHide();resolve({claim_id:'d'.repeat(32),badge:milestone(),catalogue:g.data,count:2});await loading;assert.equal(g.p.data.selected,null);assert.deepEqual(released,['c'.repeat(32),'d'.repeat(32)]);
});
test('已达成收藏可一键进入重播，手动路径不准备或确认首次展示资格',async()=>{
 const nav=[];let writes=0;
 const f=page({prepareAchievements:async()=>writes++,confirmAchievements:async()=>writes++,releaseAchievements:async()=>writes++},{navigateTo:o=>nav.push(o.url)});
 await f.p.onShow();f.p.replayEarned();assert.match(nav[0],/replay=1/);
 f.p.onLoad({badge:encodeURIComponent('total:100000000'),replay:'1'});await f.p.onShow();assert.equal(f.p._playRequested,true);assert.equal(f.p._achievementClaim,undefined);f.p.onHide();assert.equal(writes,0);
});
