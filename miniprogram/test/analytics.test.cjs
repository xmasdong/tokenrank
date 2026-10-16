const {test}=require('node:test'),assert=require('node:assert/strict');
const {presentAnalysis}=require('../utils/analytics');
const {drawDonut,drawTrend}=require('../utils/analytics-chart');
const {openInsight,setInsightAccessProvider}=require('../utils/insight-access');
test('人数占比按常用人数计算，未同步和已上报零值在趋势中分开',()=>{
 const raw={scope:'public',summary:{tokens:100,breakdown_tokens:100,users:2,requests:3},items:[{key:'a',name:'A',tokens:100,percent:100,preferred_users:1,preferred_percent:50},{key:'u',name:'其他 / 未分类',unclassified:true,tokens:0,percent:0,preferred_users:1,preferred_percent:50}],daily:[{day:'2026-10-14',reported:false,tokens:null,parts:[]},{day:'2026-10-15',reported:true,tokens:0,parts:[]},{day:'2026-10-16',reported:true,tokens:100,parts:[{name:'A',tokens:100}]}]};
 const result=presentAnalysis(raw,{metric:'people',name:'A'});assert.deepEqual(result.segments.map(x=>x.value),[1,1]);assert.equal(result.daily[0].value,null);assert.equal(result.daily[1].value,0);assert.equal(result.daily[2].value,100);
});
test('折线不跨越未同步日期连线，空占比不绘制虚构数据段',()=>{
 const calls=[];const ctx=new Proxy({measureText:s=>({width:String(s).length*10})},{get:(o,k)=>k in o?o[k]:(...args)=>calls.push([k,...args])});
 drawTrend(ctx,320,264,[{label:'10/14',value:10},{label:'10/15',value:null},{label:'10/16',value:20}]);assert.equal(calls.filter(x=>x[0]==='lineTo').length,3);
 calls.length=0;drawDonut(ctx,320,264,[],'0','Tokens');assert.equal(calls.filter(x=>x[0]==='arc').length,1);assert.ok(calls.some(x=>x[0]==='fillText'&&x[1]==='暂无数据'));
});
test('激励钩子当前免费直达，取消、未完成、无凭证或迟到结果均不能打开数据',async()=>{
 let opened=0,adCalls=0;const request={feature:'community_audience',policy:{feature:'community_audience',mode:'free'},context:{name:'A'}};
 setInsightAccessProvider(async()=>{adCalls++;return{completed:true,grant:'opaque-proof'};});
 await openInsight(request,async()=>opened++);assert.equal(opened,1);assert.equal(adCalls,0);
 request.policy.mode='rewarded';
 for(const result of [null,{completed:false},{completed:true},{completed:'yes',grant:'wrong'}]){setInsightAccessProvider(async()=>result);assert.equal(await openInsight(request,async()=>opened++),false);}
 setInsightAccessProvider(null);await assert.rejects(()=>openInsight(request,async()=>opened++),/暂未开放/);
 let release,current=true;setInsightAccessProvider(()=>new Promise(resolve=>release=resolve));const late=openInsight({...request,current:()=>current},async()=>opened++);current=false;release({completed:true,grant:'proof'});assert.equal(await late,false);assert.equal(opened,1);setInsightAccessProvider(null);
});

test('Tab 画布在可见帧重绘，隐藏、更新或卸载后旧帧不能恢复旧图',()=>{
 const vm=require('node:vm'),fs=require('node:fs');let definition;const frames=[],drawn=[];
 const canvas={getContext:()=>({scale(){}}),requestAnimationFrame:fn=>frames.push(fn)};
 const wx={getWindowInfo:()=>({pixelRatio:2}),createSelectorQuery:()=>({in(){return this;},select(){return this;},fields(){return this;},exec(fn){fn([{node:canvas,width:320,height:264}]);}})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../components/usage-chart/index.js'),'utf8'),{Component:value=>definition=value,wx,require:()=>({drawDonut:()=>drawn.push('donut'),drawTrend:()=>drawn.push('trend')})});
 const c={...definition.methods,data:{mode:'donut',segments:[],daily:[],centerValue:'1',centerLabel:'Tokens'},setData(patch){Object.assign(this.data,patch);}};
 definition.lifetimes.ready.call(c);assert.equal(drawn.length,0);
 definition.pageLifetimes.hide.call(c);frames.shift()();assert.equal(drawn.length,0);
 definition.pageLifetimes.show.call(c);frames.shift()();assert.deepEqual(drawn,['donut']);
 c.draw();c.data.mode='trend';c.draw();frames.shift()();frames.shift()();assert.deepEqual(drawn,['donut','trend']);
 c.draw();definition.lifetimes.detached.call(c);frames.shift()();assert.equal(drawn.length,2);
});
