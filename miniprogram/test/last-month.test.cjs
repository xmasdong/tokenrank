const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const usage=require('../utils/usage');
const {drawAchievementPoster}=require('../utils/achievement-poster');
const {drawReceiptPoster}=require('../utils/receipt-poster');
const {drawRankingPoster}=require('../utils/ranking-poster');
const {drawGroupPoster}=require('../utils/group-poster');
const {shareTitle}=require('../utils/share-story');
function page(name){
 let def;const nav=[],api={accountEpoch:()=>0},wx={hideShareMenu(){},showShareMenu(){},getStorageSync:()=>'',navigateTo:o=>nav.push(o.url)};
 const flow={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'utils/flow.js'),'utf8'),{module:flow,require:()=>api});
 vm.runInNewContext(fs.readFileSync(path.join(root,`pages/${name}/${name}.js`),'utf8'),{Page:x=>def=x,wx,require:id=>id.endsWith('/api')?api:id.endsWith('/flow')?flow.exports:id.endsWith('/quick-share')?{quickShare:()=>({clearQuickShare(){}})}:id.endsWith('/profile-editor')?{profileEditor:()=>({})}:id.endsWith('/insight-poster')?{insightImages:()=>({})}:id.endsWith('/share-avatar')?{loadAvatarImage:async()=>null}:require(path.join(root,'utils',path.basename(id)))});
 const p={...def,data:structuredClone(def.data),setData(v){Object.assign(this.data,v);}};return{p,nav};
}
const event=key=>({currentTarget:{dataset:{key}}});
test('个人、群榜、广场和分析独立提供上个月；分享导航携带自然月周期',async()=>{
 assert.equal(usage.PERIODS.find(x=>x.key==='month').label,'近30天');assert.equal(usage.PERIODS.find(x=>x.key==='last_month').label,'上个月');
 for(const name of ['profile','index','square','analysis','group-report']){
  const {p,nav}=page(name);let loaded;p.load=async()=>loaded=p.data.period;
  if(name==='group-report')p.onLoad({g:'g1'});if(name==='analysis')p.onLoad({});
  await p.switchPeriod(event('last_month'));assert.equal(p.data.period,'last_month',name);assert.equal(loaded,'last_month',name);
  if(name==='profile'){p.goShare();assert.equal(nav.at(-1),'/pages/share/share?period=last_month');p.goAnalysis();assert.match(nav.at(-1),/period=last_month/);}
  if(name==='square'){p.goTrends();assert.match(nav.at(-1),/period=last_month/);}
 }
 const share=page('share').p;share.onLoad({period:'last_month'});assert.equal(share.data.period,'last_month');assert.equal(share.data.periodLabel,'上个月');
 const group=page('group-report').p;group.onLoad({g:'g1',period:'last_month'});assert.equal(group.data.period,'last_month');
 const trends=page('trends').p;trends.onLoad({period:'last_month',end:'2026-10-31'});assert.equal(trends.data.period,'last_month');trends.load=async()=>{};await trends.switchOption({currentTarget:{dataset:{field:'period',value:'week'}}});assert.equal(trends.data.end,'');
});

test('上个月海报及封面显示月份口径和完整日期，近30天保留原标签',()=>{
 const data={period:'last_month',from:'2026-10-01',to:'2026-10-31',timezone:'Asia/Shanghai',token_basis:'upstream_total',summary:{tokens:258000000,requests:2,active_days:2,cache_read:258000000,cache_write:0},tools:[],activity:{},standing:{},cost:{status:'unavailable',usd_micros:null,models:[]}};
 assert.match(shareTitle({nickname:'甲'},data),/上个月.*2.58 亿/);
 for(const cover of [false,true])for(const draw of [drawAchievementPoster,drawReceiptPoster,drawRankingPoster,drawGroupPoster]){
  const texts=[],ctx=new Proxy({measureText:v=>({width:[...String(v)].length*10}),fillText:v=>texts.push(String(v))},{get:(o,k)=>k in o?o[k]:()=>{}});
  draw(ctx,{user:{nickname:'甲'},usage:data,created_at:Date.parse('2026-11-01'),data:{period:'last_month',day:'2026-11-15',scope:'group',name:'群',members:2,total:1,entries:[{rank:1,nickname:'甲',tokens:258000000,tokens_fmt:'2.58 亿'}]},cover,codeImage:{official:true}});
  if(draw!==drawReceiptPoster)assert.ok(texts.some(v=>v.includes('上个月')),draw.name);assert.ok(!texts.some(v=>v.includes('近30天')),draw.name);
  if(draw===drawAchievementPoster||draw===drawRankingPoster||draw===drawGroupPoster)assert.ok(texts.some(v=>v.includes('2026-10-01')&&v.includes('2026-10-31')),draw.name);
  if(draw===drawReceiptPoster)assert.ok(texts.some(v=>v.includes('2026-10-01')&&v.includes('2026-10-31')),draw.name);
 }
});

test('真实请求封装使用last_month并复用缓存，跨北京时间月份后重新取新月份',async()=>{
 let now=Date.parse('2026-11-30T23:59:00+08:00');class Clock extends Date{static now(){return now;}}
 const calls=[],module={exports:{}},wx={getStorageSync:k=>k==='session_token'?'session':'',request:o=>calls.push(o)};
 vm.runInNewContext(fs.readFileSync(path.join(root,'utils/api.js'),'utf8'),{module,wx,Date:Clock,require:id=>require(path.join(root,'utils',path.basename(id)))});
 const api=module.exports;let pending=api.myUsage('last_month');assert.match(calls.at(-1).url,/period=last_month/);calls.at(-1).success({statusCode:200,data:{period:'last_month',from:'2026-10-01',to:'2026-10-31'}});await pending;
 await api.myUsage('last_month');assert.equal(calls.length,1);now+=60001;pending=api.myUsage('last_month');assert.equal(calls.length,2);calls.at(-1).success({statusCode:200,data:{period:'last_month',from:'2026-11-01',to:'2026-11-30'}});assert.equal((await pending).from,'2026-11-01');
 pending=api.createShare('last_month','receipt');assert.equal(calls.at(-1).data.period,'last_month');assert.equal(calls.at(-1).data.style,'receipt');calls.at(-1).success({statusCode:200,data:{id:'a'.repeat(24)}});await pending;
});
