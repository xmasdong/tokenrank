const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),flush=()=>new Promise(r=>setImmediate(r));
const user={user_id:1,nickname:'本人',avatar_url:'https://rank.test/avatars/me.png',last_report_at:1};
const usage={period:'day',has_history:true,from:'2026-11-01',to:'2026-11-01',timezone:'Asia/Shanghai',token_basis:'upstream_total',summary:{tokens:100,requests:1,active_days:1},daily:[],models:[],tools:[]};
const board={period:'day',entries:[],total:0,me:null,updated_at:1,snapshot:'x'};
function apiFixture(){
 let now=Date.parse('2026-11-01T01:00:00Z');class Clock extends Date{static now(){return now;}}
 const calls=[],store=new Map([['session_token','session'],['account_known',true]]),module={exports:{}};
 const wx={getStorageSync:k=>store.get(k),setStorageSync:(k,v)=>store.set(k,v),removeStorageSync:k=>store.delete(k),clearStorageSync:()=>store.clear(),request:o=>calls.push(o)};
 vm.runInNewContext(fs.readFileSync(path.join(root,'utils/api.js'),'utf8'),{module,wx,Date:Clock,require:id=>require(path.join(root,'utils',path.basename(id)))});
 return{api:module.exports,calls,advance:n=>now+=n,reply:(data,index=calls.length-1,statusCode=200)=>calls[index].success({statusCode,data})};
}
const groupResponse=()=>({user,group:{id:'g1',name:'群',joined:true,members:2},board,insights:{period:'day',summary:{tokens:100}}});

test('群合并请求一次回填四个读取缓存，返回页面与切回已看周期均不发请求，TTL不被点击续期',async()=>{
 const f=apiFixture(),r=groupResponse(),a=f.api.groupPage('g1'),b=f.api.groupPage('g1');assert.equal(f.calls.length,1);f.reply(r);await a;await b;
 await Promise.all([f.api.ensureLogin(),f.api.groupInfo('g1'),f.api.fetchLeaderboard({scope:'group',id:'g1'}),f.api.groupInsights('g1')]);assert.equal(f.calls.length,1);
 const other=f.api.groupPage('g1','last_month');f.reply({...r,board:{...board,period:'last_month'}});await other;await f.api.groupPage('g1');assert.equal(f.calls.length,2);
 f.advance(240000);await f.api.groupPage('g1');f.advance(60001);const refresh=f.api.groupPage('g1');assert.equal(f.calls.length,3);f.reply(r);await refresh;
});

test('工具与模型并发请求合并，两维度切换无需新请求；主动刷新同时更新两个维度',async()=>{
 const f=apiFixture(),q={scope:'public',period:'last_month'};
 const tools=f.api.analysis({...q,dimension:'tools'}),models=f.api.analysis({...q,dimension:'models'});assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/bundle=1/);
 f.reply({tools:{dimension:'tools',value:1},models:{dimension:'models',value:2}});assert.equal((await tools).value,1);assert.equal((await models).value,2);
 for(let i=0;i<12;i++)await f.api.analysis({...q,dimension:i%2?'tools':'models'});assert.equal(f.calls.length,1);
 const fresh=f.api.analysis({...q,dimension:'models'},{force:true});f.reply({tools:{dimension:'tools',value:3},models:{dimension:'models',value:4}});await fresh;assert.equal((await f.api.analysis({...q,dimension:'tools'})).value,3);assert.equal(f.calls.length,2);
});

test('个人与群列表概览复用用户缓存；分享先准备一次，再次点击和无关概览读取不重复生成',async()=>{
 const f=apiFixture();let p=f.api.myOverview();await flush();assert.equal(f.calls.length,1);f.reply({user,usage});await p;await f.api.ensureLogin();await f.api.myUsage();assert.equal(f.calls.length,1);
 p=f.api.createShare('day');f.reply({id:'a'.repeat(24)});await p;
 p=f.api.groupsOverview();await flush();assert.match(f.calls.at(-1).url,/my\/rankings/);f.reply({groups:[]});await p;
 await f.api.myOverview();await f.api.createShare('day');assert.equal(f.calls.length,3);
 p=f.api.createShare('day','ranking');assert.equal(f.calls.at(-1).data.style,'usage');assert.equal(f.calls.at(-1).data.include_ranking,true);f.reply({id:'b'.repeat(24)});await p;
});

test('强制刷新不复用旧的在途请求，迟到旧响应不能回填个人资料与群榜；旧聚合也不能覆盖较新的单项读取',async()=>{
 const f=apiFixture(),old=f.api.groupPage('g1'),fresh=f.api.groupPage('g1','day',{force:true});assert.equal(f.calls.length,2);
 f.reply({...groupResponse(),user:{...user,nickname:'新昵称'}},1);await fresh;f.reply({...groupResponse(),user:{...user,nickname:'旧昵称'}},0);await old;assert.equal(f.api.peekMe().nickname,'新昵称');
 const g=apiFixture(),aggregate=g.api.groupPage('g1'),single=g.api.myUsage();g.reply({...usage,summary:{tokens:200}},1);await single;
 g.reply({...groupResponse(),user},0);await aggregate;assert.equal(g.api.peekUsage('day').summary.tokens,200);
});

test('隐私修改使聚合缓存失效，迟到响应不恢复旧权限；空的群榜也会清理旧子缓存',async()=>{
 const f=apiFixture(),pending=f.api.groupPage('g1'),write=f.api.setRanking(true);f.reply({...user,rank_hidden:true},1);await write;f.reply(groupResponse(),0);await pending;assert.equal(f.api.peekMe(),null);assert.equal(f.api.peekLeaderboard({scope:'group',id:'g1'}),null);
 let p=f.api.groupPage('g1');f.reply(groupResponse());await p;
 p=f.api.groupPage('g1','day',{force:true});f.reply({...groupResponse(),group:{id:'g1',joined:false},board:null,insights:null});await p;assert.equal(f.api.peekLeaderboard({scope:'group',id:'g1'}),null);assert.equal(f.api.peekGroupInsights('g1'),null);
});

function page(name,overrides={}){
 let def;const nav=[],api={accountEpoch:()=>0,accountState:()=>'',ensureSession:async()=>{},peekMe:()=>null,peekUsage:()=>null,peekRankings:()=>null,peekGroup:()=>null,peekLeaderboard:()=>null,
  fmtRelTime:()=>'',fmtTokens:String,initialOf:s=>String(s||'')[0],...overrides},wx={getStorageSync:()=>'',showShareMenu(){},hideShareMenu(){},stopPullDownRefresh(){},navigateTo:o=>nav.push(o.url)};
 const flow={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'utils/flow.js'),'utf8'),{module:flow,require:()=>api});
 vm.runInNewContext(fs.readFileSync(path.join(root,`pages/${name}/${name}.js`),'utf8'),{Page:x=>def=x,wx,require:id=>id.endsWith('/api')?api:id.endsWith('/flow')?flow.exports:id.endsWith('/quick-share')?{quickShare:()=>({clearQuickShare(){},prepareQuickShare(){},buildQuickCover(){}})}:id.endsWith('/profile-editor')?{profileEditor:()=>({})}:id.endsWith('/share-avatar')?{loadAvatarImage:async()=>null}:require(path.join(root,'utils',path.basename(id)))});
 const p={...def,data:structuredClone(def.data),setData(v){Object.assign(this.data,v);}};return{p,api,nav};
}

test('群首页与个人页实际使用合并入口，群详情复用合并结果而不重复拉群信息和分析',async()=>{
 let calls=0;const fail=()=>{throw Error('不应调用拆分接口');};
 const home=page('index',{groupsOverview:async()=>{calls++;return{user,rankings:{groups:[]}};},ensureLogin:fail,myRankings:fail});await home.p.load();assert.equal(calls,1);
 const mine=page('profile',{myOverview:async()=>{calls++;return{user,usage};},ensureLogin:fail,myUsage:fail});await mine.p.load();assert.equal(mine.p.data.usage.summary.tokens,100);assert.equal(calls,2);
 const group=page('group',{groupPage:async()=>{calls++;return{user,group:{name:'群',joined:true},board,insights:null,insights_error:'暂无明细'};},ensureLogin:fail,groupInfo:fail,fetchLeaderboard:fail,groupInsights:fail});group.p.onLoad({g:'g1',from:'mine'});group.p._visible=true;await group.p.init();assert.equal(calls,3);assert.equal(group.p.data.insightsError,'暂无明细');assert.equal(group.p.data.error,'');
});

test('分享直接使用创建结果，排行随同返回；账号切换和迟到结果不能恢复前一账号图片',async()=>{
 let calls=0,epoch=0;const fail=()=>{throw Error('不应预读');};
 const f=page('share',{accountEpoch:()=>epoch,ensureLogin:fail,myUsage:fail,fetchLeaderboard:fail,createShare:async()=>{calls++;return{id:'a'.repeat(24),user,usage,ranking:board};}});f.p.onLoad({style:'ranking'});await f.p.onShow();assert.equal(calls,1);assert.equal(f.p.data.shareId,'a'.repeat(24));
 epoch++;f.api.createShare=async()=>{const e=Error('无历史');e.code='NO_USAGE';throw e;};await f.p.onShow();assert.equal(f.p.data.shareId,'');assert.equal(f.p._snapshot,null);
 let finish;f.api.createShare=()=>new Promise(r=>finish=r);const old=f.p.load();await flush();epoch++;finish({id:'b'.repeat(24),user,usage});await old;assert.equal(f.p.data.shareId,'');assert.equal(f.p._snapshot,null);
});

test('已有个人资料时用量读取失败保留资料；正常私有读取不将失败写入缓存',async()=>{
 const f=apiFixture();let pending=f.api.ensureLogin();await flush();f.reply(user);await pending;
 pending=f.api.myOverview('last_month');await flush();f.reply({error:'统计暂不可用'},f.calls.length-1,503);const result=await pending;assert.equal(result.user.nickname,'本人');assert.equal(result.usage,null);assert.equal(result.usage_error.statusCode,503);assert.equal(f.api.peekUsage('last_month'),null);
});
