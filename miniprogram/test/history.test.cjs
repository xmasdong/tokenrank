const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calendarView, weeklyView, weeklyTitle, trendsView } = require('../utils/history');
const { drawWeeklyPoster, SOCIAL_HEIGHT } = require('../utils/social-poster');
const weekly = () => ({ period:'week',from:'2026-10-05',to:'2026-10-11',token_basis:'upstream_total',summary:{tokens:258000000,requests:12,active_days:3},
  tools:[{name:'Codex',tokens:258000000,percent:100}],daily:[],
  weekly:{complete:true,reported_days:7,previous_reported_days:7,comparison_status:'comparable',change_percent:12.4,peak:{day:'2026-10-09',tokens:100000000},top_model:{name:'M',tokens:258000000,percent:100}} });
test('日历按周一补齐格子，真实零和无记录都保留各自状态，未来日禁用', () => {
  const v=calendarView({month:'2026-10',daily:[{day:'2026-10-01',reported:true,tokens:0,requests:0},{day:'2026-10-02',reported:false,tokens:null,requests:null},
    {day:'2026-10-03',reported:true,tokens:258000000,requests:12},{day:'2026-10-04',reported:false,future:true,tokens:null}],summary:{tokens:258000000,reported_days:2}});
  assert.equal(v.cells[3].day,'2026-10-01');assert.equal(v.days[0].state,'zero');assert.equal(v.days[0].amount.value,'0');assert.equal(v.days[1].amount,null);
  assert.equal(v.days[2].level,4);assert.equal(v.amount.value,'2.58');assert.equal(v.amount.unit,'亿');assert.equal(v.days[3].state,'future');
});
test('周报不对缺失记录算环比或补零，完整数值与主单位都保留，标题只用日期及数字', () => {
  const w=weekly(),v=weeklyView(w);assert.equal(v.amount.value,'2.58');assert.equal(v.exact,'258,000,000');assert.equal(v.changeText,'+12.4%');assert.equal(v.topModel.name,'M');
  assert.equal(weeklyTitle({nickname:'甲'},w),'甲 · 10-05—10-11 · 2.58亿 Tokens');
  for(const status of ['ongoing','incomplete','zero_base']) {w.weekly.comparison_status=status;assert.doesNotMatch(weeklyView(w).changeText,/%|NaN|Infinity/);}
  w.weekly.reported_days=0;assert.equal(weeklyView(w).amount,null);
  w.weekly.reported_days=1;w.summary.tokens=0;assert.equal(weeklyView(w).amount.value,'0');
});
test('趋势缺上期只显示无记录，零变化不虚构上升，亿单位统一', () => {
  const view=trendsView({metric:'users',entries:[{name:'A',tokens:258000000,users:2,previous_rank:null,rank_change:null},{name:'B',tokens:100,users:1,previous_rank:1,previous_users:1,rank_change:0}]});
  assert.equal(view.entries[0].previousValue,'上期无记录');assert.equal(view.entries[0].rankText,'上期无记录');assert.equal(view.entries[0].amount.unit,'亿');
  assert.equal(view.entries[1].rankText,'位次不变');assert.equal(view.entries[1].width,50);
  const token=trendsView({metric:'tokens',entries:[{name:'A',tokens:258000000,users:2,previous_rank:1,previous_tokens:258000000,rank_change:0}]});assert.equal(token.entries[0].previousValue,'2.58 亿 tokens');
});
test('周报封面和长图都带完整传入的小程序码，含日期、真实数值和群成绩', () => {
  for(const cover of [true,false]) { const texts=[],images=[],ctx=new Proxy({measureText:v=>({width:[...String(v)].length*16}),fillText:v=>texts.push(String(v)),drawImage:(...v)=>images.push(v)}, {get:(o,k)=>k in o?o[k]:()=>{}});
    const usage={...weekly(),group_standing:{name:'本群',rank:12,participants:30}},code={official:true};
    assert.throws(()=>drawWeeklyPoster(ctx,{user:{nickname:'甲'},usage}),/小程序码/);
    drawWeeklyPoster(ctx,{user:{nickname:'甲'},usage,cover,codeImage:code});assert.ok(texts.some(t=>t.includes('2.58亿')));assert.ok(texts.some(t=>t.includes('#12')));
    assert.ok(texts.some(t=>t.includes('2026-10-05')));assert.ok(!texts.some(t=>/打败|生产力|晒给你/.test(t)));
    const image=images.find(i=>i[0]===code);assert.ok(image);assert.ok(image[2]+image[4]<=(cover?800:SOCIAL_HEIGHT));
  }
});
