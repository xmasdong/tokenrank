const {test}=require('node:test'),assert=require('node:assert/strict');
const {KEY,normalizeDisplay,readDisplay,saveDisplay,detailsView}=require('../utils/calendar-display');
const {drawInsightPoster,insightPosterHeight}=require('../utils/insight-poster');
test('默认只公开Token，四个选项可独立关闭并记住，损坏或不可用的存储不编造选项',()=>{
 const store=new Map(),wx={getStorageSync:k=>store.get(k),setStorageSync:(k,v)=>store.set(k,v)};
 assert.deepEqual(readDisplay(wx),{tokens:true,device:false,model:false,cost:false});
 const allOff={tokens:false,device:false,model:false,cost:false};saveDisplay(wx,allOff);assert.deepEqual(readDisplay(wx),allOff);assert.equal(store.get(KEY).cost,false);
 assert.deepEqual(normalizeDisplay({tokens:'false',cost:1,unknown:true}),{tokens:true,device:false,model:false,cost:false});
 assert.equal(readDisplay({getStorageSync(){throw Error('unavailable');}}).tokens,true);
});
test('旧接口未提供详细统计与真实缺记录区分，真实零估算仍显示，不将估算当实付',()=>{
 const old=detailsView();assert.equal(old.supported,false);assert.equal(old.costAvailable,false);assert.equal(old.costNote,'');
 const missing=detailsView({device:null,top_model:null,cost:{status:'unavailable',usd_micros:null}});assert.equal(missing.supported,true);assert.equal(missing.device,'暂无设备记录');assert.equal(missing.cost,'暂无费用记录');
 const zero=detailsView({cost:{status:'complete',usd_micros:0}});assert.equal(zero.cost,'$0.0000');assert.equal(zero.costAvailable,true);assert.match(zero.costNote,/非实际账单/);
 const partial=detailsView({device:{label:'macOS'},top_model:{name:'B'},cost:{status:'partial',usd_micros:98765400,missing_days:2,unpriced_count:3}});
 assert.equal(partial.cost,'$98.7654');assert.match(partial.costNote,/已计价部分.*3 个模型未计价.*2 天金额未同步.*非实际账单/);
});
test('16种显示组合在图片中只包含已勾选字段，隐藏Token同时隐藏峰值数字，小程序码不截断',()=>{
 const report={month:'2026-10',summary:{tokens:258000000,reported_days:1,active_days:1},daily:[{day:'2026-10-01',reported:true,tokens:258000000,requests:1}],details:{device:{label:'macOS'},top_model:{name:'Model-X'},cost:{status:'complete',usd_micros:98765400}}};
 for(let bits=0;bits<16;bits++){
  const display={tokens:!!(bits&1),device:!!(bits&2),model:!!(bits&4),cost:!!(bits&8)},texts=[],images=[],code={official:true};
  const ctx=new Proxy({measureText:v=>({width:[...String(v)].length*14}),fillText:v=>texts.push(String(v)),drawImage:(...a)=>images.push(a)},{get:(o,k)=>k in o?o[k]:()=>{}});
  drawInsightPoster(ctx,{kind:'calendar',report,display,codeImage:code});
  assert.equal(texts.some(t=>t.includes('2.58')),display.tokens);assert.equal(texts.some(t=>t.includes('macOS')),display.device);assert.equal(texts.some(t=>t.includes('Model-X')),display.model);assert.equal(texts.some(t=>t.includes('$98.7654')),display.cost);
  if(display.cost)assert.ok(texts.some(t=>t.includes('非实际账单')));
  const qr=images.find(a=>a[0]===code);assert.ok(qr);assert.ok(qr[2]+qr[4]<=insightPosterHeight({kind:'calendar',display,report}));
 }
});
test('旧接口海报只提示一次暂无详细统计；四至六行月历的内容与码图均在画布内',()=>{
 for(const month of ['2027-02','2026-09','2026-03'])for(const tokens of [true,false]){
  const report={month,today:'2027-03-01',summary:{tokens:0,reported_days:1,active_days:0},daily:[{day:month+'-01',reported:true,tokens:0,requests:0}]},display={tokens,device:true,model:true,cost:true};
  const texts=[],images=[],code={official:true},height=insightPosterHeight({kind:'calendar',display,report});
  const ctx=new Proxy({measureText:v=>({width:[...String(v)].length*14}),fillText:(v,x,y)=>texts.push({v:String(v),x,y}),drawImage:(...a)=>images.push(a)},{get:(o,k)=>k in o?o[k]:()=>{}});
  drawInsightPoster(ctx,{kind:'calendar',report,display,codeImage:code});
  assert.equal(texts.filter(t=>t.v==='暂无详细统计').length,1);assert.ok(!texts.some(t=>/设备信息未同步|费用未同步|\$0/.test(t.v)));
  assert.ok(texts.every(t=>t.y>0&&t.y<height));assert.ok(texts.find(t=>t.v==='暂无详细统计').y<height-240);
  const qr=images.find(a=>a[0]===code);assert.ok(qr[2]+qr[4]<=height);
 }
});
