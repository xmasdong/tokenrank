const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {drawInsightPoster,insightImages,HEIGHT}=require('../utils/insight-poster');
function context(){const texts=[],images=[],ctx=new Proxy({measureText:v=>({width:[...String(v)].length*16}),fillText:v=>texts.push(String(v)),drawImage:(...v)=>images.push(v)}, {get:(o,k)=>k in o?o[k]:()=>{}});return {ctx,texts,images};}
test('日历海报只用真实同步日，区分零、未同步与未来，保留作者和固定小程序码',()=>{
 const c=context(),code={official:true},report={month:'2026-10',summary:{tokens:258000000,reported_days:2,active_days:1},daily:[{day:'2026-10-01',reported:true,tokens:258000000},{day:'2026-10-02',reported:true,tokens:0},{day:'2026-10-03',reported:false,tokens:null},{day:'2026-10-04',future:true}]};
 assert.throws(()=>drawInsightPoster(c.ctx,{kind:'calendar',report}),/小程序码/);
 drawInsightPoster(c.ctx,{kind:'calendar',report,nickname:'原作者',codeImage:code});assert.ok(c.texts.includes('原作者'));assert.ok(c.texts.includes('2.58 亿 Tokens'));assert.ok(c.texts.includes('零用量'));assert.ok(c.texts.includes('未同步'));assert.ok(!c.texts.includes('01'));assert.equal(c.images.filter(r=>r[0]===code).length,1);
});
test('模型分析与趋势图保留正确口径、区间、截取范围，不虚构上期增长',()=>{
 for(const kind of ['analysis','trends']){const c=context(),row={name:'真实模型',tokens:258000000,users:2,rank:1,percent:83.2,previous_rank:null};
 const report={scope:'public',tool:'真实工具',from:'2026-10-01',to:'2026-10-07',previous_from:'2026-09-24',previous_to:'2026-09-30',summary:{users:3},items:[row],entries:[row]};
 drawInsightPoster(c.ctx,{kind,dimension:'models',metric:'users',report,codeImage:{official:true}});assert.ok(c.texts.some(v=>v.includes('模型')));assert.ok(c.texts.some(v=>v.includes('前 1 项')));
 assert.ok(c.texts.includes(kind==='trends'?'2 人':'2.58 亿'));if(kind==='trends'){assert.ok(c.texts.includes('上期无记录'));assert.ok(c.texts.some(v=>v.includes('2026-09-24')));}
 }
});
function fixture(){let epoch=0,exports=0,previews=0,codeLoad;const canvas={createImage:()=>{const img={};Object.defineProperty(img,'src',{set(){codeLoad=()=>img.onload();}});return img;},getContext:()=>context().ctx};
 const wx={createSelectorQuery:()=>({in(){return this;},select(){return this;},fields(){return this;},exec(fn){fn([{node:canvas}]);}}),canvasToTempFilePath:o=>{exports++;o.success({tempFilePath:'real-render.png'});},previewImage:()=>previews++,showToast(){}};
 const api={accountEpoch:()=>epoch,accountState:()=>''};const report={month:'2026-10',summary:{tokens:0,reported_days:0,active_days:0},daily:[]};
 const p={...insightImages(wx,api),_visible:true,data:{report},setData(v){Object.assign(this.data,v);},insightImageOptions:()=>({kind:'calendar'})};return{p,report,loadCode:()=>codeLoad(),remove:()=>epoch++,get exports(){return exports;},get previews(){return previews;}};
}
test('图片按已显示报告复用；离页、换数据或注销时不导出不弹过期预览',async()=>{
 const f=fixture();const first=f.p.shareInsightImage();await new Promise(r=>setImmediate(r));f.loadCode();await first;await f.p.shareInsightImage();assert.equal(f.exports,1);assert.equal(f.previews,2);
 for(const interrupt of [f=>f.p._visible=false,f=>f.p.data.report={},f=>f.remove()]){const g=fixture(),pending=g.p.shareInsightImage();interrupt(g);await new Promise(r=>setImmediate(r));g.loadCode();await pending;assert.equal(g.exports,0);assert.equal(g.previews,0);assert.equal(g.p.data.insightImageBusy,false);}
});
test('取消显示费用立即废弃旧图片；绘制途中修改选择不会弹出旧金额的图片',async()=>{
 const f=fixture();f.p.data.display={cost:true};f.p.insightImageOptions=function(){return{kind:'calendar',display:this.data.display};};
 const first=f.p.shareInsightImage();await new Promise(r=>setImmediate(r));f.loadCode();await first;assert.equal(f.exports,1);
 f.p.data.display={cost:false};const second=f.p.shareInsightImage();await new Promise(r=>setImmediate(r));f.loadCode();await second;assert.equal(f.exports,2);
 const g=fixture();g.p.data.display={cost:true};g.p.insightImageOptions=f.p.insightImageOptions;
 const pending=g.p.shareInsightImage();await new Promise(r=>setImmediate(r));g.p.data.display={cost:false};g.loadCode();await pending;assert.equal(g.exports,0);assert.equal(g.previews,0);
});
