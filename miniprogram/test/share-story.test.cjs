const { test }=require('node:test');
const assert=require('node:assert/strict');
const {story,shareTitle}=require('../utils/share-story');
const usage=(tokens=0)=>({period:'day',summary:{tokens},tools:[],activity:{},standing:{}});
test('亿级用量、真实名次与分享标题使用同一数据；不把排名包装成能力证明',()=>{
  const data={...usage(990000000),standing:{rank:57,participants:1000}};
  const s=story(data);assert.equal(s.value,'9.90');assert.equal(s.unit,'亿');
  assert.equal(s.rankText,'#57');assert.equal(s.rankNote,'1,000 位同期上榜用户');
  assert.match(shareTitle({nickname:'小冬'},data),/9.90 亿 Tokens · 全站 #57/);
});
test('零用量不虚构排名；中断时显示历史最长连续，工具来自真实明细',()=>{
  const empty=story(usage());assert.equal(empty.rankText,'未上榜');assert.equal(empty.streakValue,0);
  assert.equal(empty.days,0);
  const data={...usage(100),activity:{active_days:20,current_streak:0,longest_streak:8},tools:[{name:'未分类',tokens:100,unclassified:true},{name:'Codex',tokens:90,percent:90}]};
  const streak=story(data,'streak');assert.equal(streak.days,20);assert.equal(streak.streakLabel,'最长连续');assert.equal(streak.streakValue,8);
  assert.equal(story(data).top.name,'Codex');assert.equal(story(data).top.percent,90);
});
test('达到一亿后统一使用亿并保留两位小数，完整数字不变',()=>{
  const {compact,integer}=require('../utils/usage');
  assert.deepEqual(compact(99999999),{value:'10000',unit:'万'});
  assert.deepEqual(compact(100000000),{value:'1.00',unit:'亿'});
  assert.deepEqual(compact(258000000),{value:'2.58',unit:'亿'});
  assert.deepEqual(compact(36500000000000),{value:'365000.00',unit:'亿'});
  assert.equal(integer(36500000000000),'36,500,000,000,000');
});
test('榜单、缓存、工具明细与分享标题使用一致的亿级格式',()=>{
  const {formatTokens,present}=require('../utils/usage');
  const data={...usage(258000000),from:'2026-09-28',to:'2026-09-28',
    summary:{tokens:258000000,requests:1,cache_read:200000000,cache_write:100000000},
    daily:[{day:'2026-09-28',tokens:258000000}],models:[],tools:[{name:'Codex',tokens:258000000}]};
  const display=present(data);
  assert.equal(formatTokens(258000000),'2.58 亿');
  assert.equal(display.cacheReadText,'2.00 亿');assert.equal(display.cacheWriteText,'1.00 亿');
  assert.equal(display.tools[0].formatted,'2.58 亿');assert.equal(display.peakText,'2.58 亿');
  assert.match(shareTitle({},data),/2.58 亿 Tokens/);assert.equal(display.exact,'258,000,000');
});
test('新分享标注含缓存与北京时间，旧分享保留原来的口径',()=>{
  const {usageBasis}=require('../utils/usage');
  const current=usageBasis({token_basis:'upstream_total',timezone:'Asia/Shanghai'});
  assert.equal(current.basisLabel,'总用量 · 含缓存');
  assert.equal(current.shortNote,'含缓存 · 北京时间');
  const legacy=usageBasis({});
  assert.equal(legacy.basisLabel,'输入 + 输出 · 不含缓存');
  assert.equal(legacy.shortNote,'不含缓存 · UTC');
});
