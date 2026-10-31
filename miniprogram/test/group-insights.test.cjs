const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {presentGroupInsights}=require('../utils/group-insights');
const {drawGroupInsightsPoster,GROUP_POSTER_HEIGHT}=require('../utils/group-insights-poster');
const {drawRankingPoster,rankingAvatarUrls}=require('../utils/ranking-poster');
const {drawGroupPoster}=require('../utils/group-poster');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function raw(period='day',tokens=258000000){
 const a={scope:'group',period,dimension:'models',summary:{tokens,breakdown_tokens:tokens,users:2,detail_users:2},items:[{key:'named:M',name:'M',tokens,users:2,preferred_users:2,percent:100,preferred_percent:100}],daily:[{day:'2026-10-30',reported:false,tokens:null,parts:[],reported_users:0},{day:'2026-10-31',reported:true,tokens,parts:[{name:'M',tokens}],reported_users:2}],trend_days:7};
 return{group:{name:'真实群名',members:8},period,from:'2026-10-31',to:'2026-10-31',summary:{tokens,active_users:2,reported_users:2,cache_read:tokens,input_tokens:0,output_tokens:0,cache_write:0},tools:{...a,dimension:'tools'},models:a,cost:{status:'unavailable',usd_micros:null,models:[],missing_days:1,missing_user_days:2},snapshot:'s-'+period};
}
function page(overrides={}){
 let definition,epoch=0,logins=0,reads=0,shares=0,shows=0;const nav=[];
 const api={accountEpoch:()=>epoch,ensureSession:async()=>{logins++;},groupInsights:async(g,p)=>{reads++;return raw(p);},createGroupInsightsShare:async(g,p)=>{shares++;return{id:'a'.repeat(24),style:'group-insights',report:raw(p),expires_at:Date.now()+10000};},sharedRecord:async()=>{reads++;return{id:'b'.repeat(24),style:'group-insights',report:raw(),expires_at:Date.now()+10000};},...overrides};
 const wx={hideShareMenu(){},showShareMenu(){shows++;},stopPullDownRefresh(){},switchTab:o=>nav.push(o.url),navigateBack(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/group-report/group-report.js'),'utf8'),{Page:x=>definition=x,wx,require:id=>id.endsWith('/api')?api:require(path.join(__dirname,'../utils',path.basename(id)))});
 const p={...definition,data:structuredClone(definition.data),setData(patch){Object.assign(this.data,patch);}};
 return{p,api,wx,nav,epoch:()=>epoch++,counts:()=>({logins,reads,shares,shows})};
}
function context(){const texts=[],images=[];return{ctx:new Proxy({measureText:t=>({width:[...String(t)].length*18}),fillText:(t,x,y)=>texts.push({t,x,y}),drawImage:(...args)=>images.push(args)},{get:(target,key)=>key in target?target[key]:()=>{}}),texts,images};}
test('群用量展示亿单位、真实人数；缺金额不补零，缺价用成员日记录说明',()=>{
 const r=presentGroupInsights(raw());assert.equal(r.amount.value,'2.58');assert.equal(r.amount.unit,'亿');assert.equal(r.topModel,'M');assert.equal(r.costText,'—');assert.match(r.costNote,/2 条成员日记录/);assert.equal(r.models.daily[0].value,null);
 const priced=raw();priced.cost={...priced.cost,status:'partial',usd_micros:0,models:[{name:'M',usd_micros:0}]};assert.equal(presentGroupInsights(priced).costText,'$0.0000');
});
test('公开群数据免登录，转发固定来源记录，去看我的用量才跳个人页',async()=>{
 const f=page();f.p.onLoad({id:'b'.repeat(24),dimension:'tools'});await f.p.onShow();assert.equal(f.counts().logins,0);assert.equal(f.counts().shares,0);assert.equal(f.p.data.dimension,'tools');assert.equal(f.p.data.report.group.name,'真实群名');assert.equal(f.p.onShareAppMessage().path,'/pages/group-report/group-report?id='+ 'b'.repeat(24)+'&dimension=tools');
 f.p.switchPeriod({currentTarget:{dataset:{key:'month'}}});assert.equal(f.counts().reads,1);f.p.goMine();assert.equal(f.nav[0],'/pages/profile/profile');
});
test('切换工具模型、展开明细和点趋势都是本地操作，不重新请求群数据',async()=>{
 const f=page();f.p.onLoad({g:'g1'});await f.p.onShow();const before=f.counts();f.p.switchDimension({currentTarget:{dataset:{key:'tools'}}});f.p.toggleRows();f.p.selectDay({detail:{index:1}});f.p.selectCategory({detail:{key:'named:M'}});assert.deepEqual(f.counts(),before);assert.equal(f.p.data.selectedDay.tokens,258000000);assert.equal(f.p.data.selectedCategory.name,'M');assert.match(f.p.onShareAppMessage().title,/2.58亿.*2 人/);
});
test('切周期、离页或账号变化后，迟到的群数据和分享不覆盖当前页面',async()=>{
 let release;const f=page({groupInsights:(g,p)=>p==='day'?new Promise(resolve=>release=resolve):Promise.resolve(raw(p,1))});f.p.onLoad({g:'g1'});const first=f.p.onShow();await flush();await f.p.switchPeriod({currentTarget:{dataset:{key:'week'}}});release(raw('day',999));await first;assert.equal(f.p.data.report.period,'week');assert.equal(f.p.data.report.summary.tokens,1);
 let end;const next=page({groupInsights:()=>new Promise(resolve=>end=resolve)});next.p.onLoad({g:'g1'});const pending=next.p.onShow();await flush();next.p.onHide();end(raw());await pending;assert.equal(next.p.data.report,null);assert.equal(next.p.data.record,null);
});
test('分享快照冲突不阻塞内容，也不允许转发错数据；匿名失效卡显示错误',async()=>{
 const f=page({createGroupInsightsShare:async()=>{const e=Error('changed');e.statusCode=409;throw e;}});f.p.onLoad({g:'g1'});await f.p.onShow();assert.equal(f.p.data.report.summary.tokens,258000000);assert.equal(f.p.data.record,null);assert.match(f.p.data.shareError,/下拉刷新/);assert.equal(f.p.onShareAppMessage().path,'/pages/index/index');
 const bad=page({sharedRecord:async()=>{throw Error('分享已撤销');}});bad.p.onLoad({id:'b'.repeat(24)});await bad.p.onShow();assert.match(bad.p.data.error,/撤销/);assert.equal(bad.p.data.record,null);
});
test('群数据图片及转发封面使用同一真实数字、人数、范围和完整小程序码',()=>{
 const report=presentGroupInsights(raw()),code={official:true};assert.throws(()=>drawGroupInsightsPoster({}, {report}),/小程序码/);
 for(const cover of [true,false]){const {ctx,texts,images}=context();drawGroupInsightsPoster(ctx,{report,cover,codeImage:code});assert.ok(texts.some(x=>x.t==='2.58'));assert.ok(texts.some(x=>x.t==='2 人活跃 / 8 人加入'));assert.ok(texts.some(x=>x.t==='M'));assert.ok(texts.some(x=>x.t==='2026-10-31'));assert.equal(images.length,1);const[,x,y,w,h]=images[0];assert.equal(images[0][0],code);assert.ok(x+w<1000&&y+h<(cover?800:GROUP_POSTER_HEIGHT));assert.ok(!texts.some(x=>/次调用/.test(x.t)));}
});
test('两种排行榜样式都真正绘制成员头像；本人行可使用me中的头像，缺头像不丢成员',()=>{
 const one={member:true},self={self:true},code={code:true};const data={scope:'group',name:'群榜',members:2,total:2,period:'day',entries:[{rank:1,nickname:'甲',tokens:258000000,tokens_fmt:'2.58 亿',avatar_url:'member'},{rank:2,nickname:'乙',tokens:1,tokens_fmt:'1'}],me:{rank:2,nickname:'本人',tokens:1,avatar_url:'self'}};
 assert.deepEqual(rankingAvatarUrls(data),['member','self']);
 for(const draw of [drawRankingPoster,drawGroupPoster])for(const cover of [true,false]){const {ctx,images,texts}=context();draw(ctx,{data,cover,codeImage:code,avatarImages:{member:one,self}});assert.ok(images.some(x=>x[0]===one));assert.ok(texts.some(x=>x.t==='乙'));if(draw===drawRankingPoster)assert.ok(images.some(x=>x[0]===self));}
});
test('群读取按群与周期缓存五分钟，合并并发；分享快照同版本复用且公开访问实时校验',async()=>{
 let now=Date.now();class Clock extends Date{static now(){return now;}}
 const calls=[],module={exports:{}},wx={getStorageSync:key=>key==='session_token'?'session':'',request:o=>calls.push(o)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/api.js'),'utf8'),{wx,module,Date:Clock,require:id=>require(path.join(__dirname,'../utils',path.basename(id)))});
 const api=module.exports,reply=data=>calls.at(-1).success({statusCode:200,data});
 const a=api.groupInsights('g1','day'),b=api.groupInsights('g1','day');assert.equal(calls.length,1);reply(raw());await a;await b;await api.groupInsights('g1','day');assert.equal(calls.length,1);
 const c=api.groupInsights('g1','week');reply(raw('week'));await c;assert.equal(calls.length,2);
 const share=api.createGroupInsightsShare('g1','day','v1');assert.equal(calls.at(-1).method,'POST');reply({id:'a'.repeat(24),expires_at:now+600000});await share;await api.createGroupInsightsShare('g1','day','v1');assert.equal(calls.length,3);
 now+=300001;const next=api.groupInsights('g1','day');reply(raw());await next;assert.equal(calls.length,4);
 for(let i=0;i<2;i++){const read=api.sharedRecord('a'.repeat(24));reply({id:'a'.repeat(24)});await read;}assert.equal(calls.length,6);assert.equal(calls.at(-1).header.authorization,undefined);
});

test('群榜刚刷新时，不用比榜单更旧的群汇总缓存；普通重复进入仍不请求',async()=>{
 let definition,calls=0,forced=false;
 const api={accountEpoch:()=>0,accountState:()=>'',peekGroupInsights:()=>({...raw(),updated_at:1}),groupInsights:async(id,period,options)=>{calls++;forced=options.force;return{...raw(),updated_at:2};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/group/group.js'),'utf8'),{Page:x=>definition=x,wx:{},require:id=>id.endsWith('/api')?api:id.endsWith('/flow')?{PERIODS:[]}:id.endsWith('/share-avatar')?{loadAvatarImage:async()=>null}:id.endsWith('/quick-share')?{quickShare:()=>({})}:id.endsWith('/profile-editor')?{profileEditor:()=>({})}:require(path.join(__dirname,'../utils',path.basename(id)))});
 const p={...definition,data:{id:'g1',period:'day'},_visible:true,_requestId:1,_boardSnapshot:{updated_at:2},setData(patch){Object.assign(this.data,patch);}};
 await p.loadInsights();assert.equal(calls,1);assert.equal(forced,true);p._boardSnapshot.updated_at=1;await p.loadInsights();assert.equal(calls,1);
});
