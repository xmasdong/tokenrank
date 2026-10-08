const {test}=require('node:test'),assert=require('node:assert/strict');
const {presentCost,issuedAt,receiptTitle}=require('../utils/cost');
const {drawReceiptPoster,RECEIPT_HEIGHT}=require('../utils/receipt-poster');
test('receipt lines round to four decimals and add up to the displayed total',()=>{
  const models=Array.from({length:7},(_,i)=>({name:'model-'+i,usd_micros:106+i}));
  const cost={status:'complete',usd_micros:models.reduce((s,m)=>s+m.usd_micros,0),models};
  const result=presentCost(cost);
  assert.equal(result.models.length,6);assert.equal(result.models.at(-1).name,'其他模型（2）');
  assert.equal(result.models.reduce((s,m)=>s+Math.round(Number(m.amount)*10000),0),Math.round(Number(result.amount)*10000));
  assert.equal(presentCost().amount,'—');assert.equal(presentCost({status:'unavailable',usd_micros:0}).available,false);
  assert.equal(presentCost({status:'complete',usd_micros:0,models:[{name:'free',usd_micros:0}]}).amount,'0.0000');
  assert.equal(presentCost({status:'complete',usd_micros:1234567890}).amount,'1,234.5679');
});
test('partial estimates and Beijing issue times are explicit; forwards retain owner and amount',()=>{
  const usage={cost:{status:'partial',usd_micros:686480000,models:[],unpriced_count:2,missing_days:3}};
  const c=presentCost(usage.cost);assert.equal(c.label,'已计价部分');assert.match(c.note,/2 个模型未计价 · 3 天金额未同步/);
  assert.equal(issuedAt(Date.parse('2026-10-08T11:18:00Z')),'2026-10-08 19:18');
  assert.match(receiptTitle({nickname:'原作者'},usage),/原作者 · AI 用量账单 · \$686.4800 · API 等值估算/);
});
test('saved receipts require the real mini program code, and absent prices never render a dollar zero',()=>{
  const texts=[],ctx=new Proxy({measureText:s=>({width:String(s).length*15}),fillText:s=>texts.push(s)},{get:(o,k)=>k in o?o[k]:()=>{}});
  const snapshot={user:{nickname:'测试昵称'},usage:{from:'2026-10-01',to:'2026-10-08',summary:{tokens:258000000,cache_read:200000000,active_days:8}}};
  assert.throws(()=>drawReceiptPoster(ctx,snapshot),/小程序码/);
  drawReceiptPoster(ctx,{...snapshot,previewOnly:true});
  assert.ok(texts.includes('—'));assert.ok(!texts.some(s=>s.includes('$0')));assert.equal(RECEIPT_HEIGHT,1940);
});
