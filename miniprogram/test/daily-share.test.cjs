const {test}=require('node:test'),assert=require('node:assert/strict');
const {dailyShareView,dailyTitle}=require('../utils/daily-share');
const {drawDailyPoster,SOCIAL_HEIGHT}=require('../utils/social-poster');
const usage=()=>({period:'day',from:'2026-10-18',to:'2026-10-18',report_day:'2026-10-18',summary:{tokens:258000000,requests:1382,input_tokens:50000000,output_tokens:8000000,cache_read:200000000,cache_write:0},tools:[{name:'Codex',tokens:258000000,percent:100}],models:[{name:'Model',tokens:258000000,percent:100}]});
test('日报标题和展示使用实际日期、数字、调用数和主力工具模型，不称历史日报为今日',()=>{
 const data=usage(),view=dailyShareView(data);assert.equal(view.dateText,'2026.10.18');assert.equal(view.value,'2.58');assert.equal(view.unit,'亿');assert.equal(view.requestsText,'1,382');assert.equal(view.topModel,'Model');assert.equal(view.topTool,'Codex');
 assert.equal(dailyTitle({nickname:'甲'},data),'甲 · 10.18 · 2.58亿 Tokens · 1,382 次');
 const zero=usage();zero.summary.tokens=0;zero.summary.requests=0;assert.equal(dailyShareView(zero).value,'0');
 delete zero.summary.cache_read;assert.equal(dailyShareView(zero).cacheReadText,'—');delete zero.summary.tokens;assert.throws(()=>dailyShareView(zero),/无效/);
 const wrong=usage();wrong.to='2026-10-19';assert.throws(()=>dailyShareView(wrong),/无效/);
});
test('日报封面与长图都带固定小程序码，展示指定日期和真实数字，不虚构名次或坚持记录',()=>{
 for(const cover of [true,false]){
  const texts=[],images=[],ctx=new Proxy({measureText:value=>({width:[...String(value)].length*16}),fillText:value=>texts.push(String(value)),drawImage:(...args)=>images.push(args)},{get:(object,key)=>key in object?object[key]:()=>{}}),code={official:true},data={user:{nickname:'甲'},usage:usage(),cover};
  assert.throws(()=>drawDailyPoster(ctx,data),/小程序码/);drawDailyPoster(ctx,{...data,codeImage:code});
  assert.ok(texts.includes('2.58'));assert.ok(texts.some(value=>value.includes('1,382')));assert.ok(texts.includes('2026.10.18'));assert.ok(texts.includes('Codex'));assert.ok(texts.includes('Model'));
  assert.equal(texts.some(value=>/全站排名|累计活跃|最长连续|今日|生产力|晒给你/.test(value)),false);
  const image=images.find(args=>args[0]===code);assert.ok(image);assert.ok(image[2]+image[4]<=(cover?800:SOCIAL_HEIGHT));
 }
});
