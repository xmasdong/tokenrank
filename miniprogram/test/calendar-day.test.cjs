const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {dayView,dailyRow}=require('../utils/calendar-day');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const report=(day,tokens=258000000,cost={status:'complete',usd_micros:98765400})=>({day,from:day,to:day,has_history:true,summary:{tokens},cost,top_model:{name:'Model-A',tokens}});
const calendar=(daily)=>({month:'2026-10',today:'2026-10-31',daily,summary:{tokens:daily.reduce((n,d)=>n+(d.tokens||0),0),reported_days:daily.filter(d=>d.reported).length,active_days:1}});
const row=(day,tokens=10,details)=>({day,tokens,requests:98765,reported:true,...(details?{details}:{})});
function fixture(raw,overrides={}){
 let definition,epoch=0,now=Date.parse('2026-10-31T12:00:00+08:00');const storage=new Map();
 class Clock extends Date{static now(){return now;}}
 const api={accountEpoch:()=>epoch,accountState:()=>'',ensureLogin:async()=>{},calendar:async()=>raw,...overrides};
 const wx={showShareMenu(){},getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/calendar/calendar.js'),'utf8'),{Page:v=>definition=v,wx,Date:Clock,require:id=>id.endsWith('/api')?api:require(path.join(__dirname,'../utils',path.basename(id)))});
 const p={...definition,data:JSON.parse(JSON.stringify(definition.data)),setData(v){Object.assign(this.data,v);}};p.onLoad({});
 return {p,api,changeAccount:()=>epoch++,setNow:value=>now=Date.parse(value)};
}
test('日期详情突出含缓存总量和USD估算，零费用、缺价、缺记录分别呈现',()=>{
 const real=dayView(row('2026-10-01',258000000,{cost:{status:'partial',usd_micros:98765400,unpriced_count:2}}));
 assert.equal(real.amount.value,'2.58');assert.equal(real.exact,'258,000,000');assert.equal(real.cost,'$98.7654');assert.match(real.costNote,/已计价部分.*2 个模型未计价.*非实际账单/);
 const zero=dayView(row('2026-10-01',0,{cost:{status:'complete',usd_micros:0}}));assert.equal(zero.amount.value,'0');assert.equal(zero.cost,'$0.0000');
 const unpriced=dayView(row('2026-10-01',1,{cost:{status:'unavailable',usd_micros:null,unpriced_count:1}}));assert.equal(unpriced.cost,'—');assert.equal(unpriced.costStatus,'暂无可用价格');
 assert.equal(dayView(row('2026-10-01')).costStatus,'暂无估算数据');
 const missing=dayView({day:'2026-10-01',reported:false});assert.equal(missing.amount,null);assert.equal(missing.cost,'—');assert.equal(missing.costStatus,'未同步');
 assert.ok(!JSON.stringify(real).includes('98765'));
});
test('兼容明细用同一份日报配对数量与金额，错日期和无效数值不能混入',()=>{
 const day='2026-10-01',old=row(day,10),r=dailyRow(report(day),day,old);
 assert.equal(r.tokens,258000000);assert.equal(dayView(r).cost,'$98.7654');assert.equal(old.tokens,10);
 assert.throws(()=>dailyRow(report('2026-10-02'),day,old),/日期/);
 assert.throws(()=>dailyRow({...report(day),has_history:undefined},day,old),/记录/);
 assert.throws(()=>dailyRow({...report(day),summary:{tokens:null}},day,old),/用量/);
 const missing=dailyRow({...report(day),has_history:false,summary:{tokens:null}},day,old);assert.equal(dayView(missing).amount,null);assert.equal(dayView(missing).cost,'—');
});
test('新版日历直接取每日费用，改显示选项不隐藏私人日期明细，也不将金额带入未勾选的分享图',async()=>{
 let requests=0;const raw=calendar([row('2026-10-01',258000000,{cost:{status:'complete',usd_micros:12340000}}),row('2026-10-02',0,{cost:{status:'complete',usd_micros:0}})]);
 const {p}=fixture(raw,{daily:async()=>{requests++;throw Error('not needed');}});await p.onShow();
 await p.chooseDate('2026-10-01');assert.equal(p.data.dayView.cost,'$12.3400');
 p.changeDisplay({detail:{value:[]}});assert.equal(p.data.dayView.amount.value,'2.58');assert.equal(p.data.dayView.cost,'$12.3400');assert.equal(p.insightImageOptions().display.cost,false);assert.equal(p.insightImageOptions().display.tokens,false);
 await p.stepDay({currentTarget:{dataset:{delta:1}}});assert.equal(p.data.dayView.cost,'$0.0000');assert.equal(requests,0);
});
test('旧日历复用已读日报；首次补齐后的来回点选命中缓存，不修改原日历或分享数据',async()=>{
 const day='2026-10-01',raw=calendar([row(day)]),cache=new Map();let requests=0;
 const {p}=fixture(raw,{peekDaily:d=>cache.get(d),daily:async d=>{requests++;const r=report(d);cache.set(d,r);return r;}});
 await p.onShow();await p.chooseDate(day);assert.equal(requests,1);assert.equal(p.data.dayView.amount.value,'2.58');assert.equal(p.data.dayView.cost,'$98.7654');
 await p.chooseDate(day);await p.pickDate({detail:{value:day}});assert.equal(requests,1);assert.equal(raw.daily[0].tokens,10);assert.equal(p.data.report.heatmap.days.find(d=>d.day===day).tokens,10);
 assert.equal(p.data.dayCostBusy,false);
});
test('今日兼容读取今日用量缓存，不调用只允许已结束日期的日报接口',async()=>{
 const day='2026-10-31';let reads=0;const {p}=fixture(calendar([row(day)]),{peekUsage:period=>{assert.equal(period,'day');return report(day,50);},myUsage:async()=>{reads++;},daily:async()=>assert.fail('today is not a completed daily report')});
 await p.onShow();assert.equal(p.data.dayView.exact,'50');assert.equal(p.data.dayView.cost,'$98.7654');assert.equal(reads,0);
});
test('北京时间跨日后，旧日历的原今日改走已结束日期日报，不把新一天金额配进旧日期',async()=>{
 const day='2026-10-31',calls=[];const {p,setNow}=fixture(calendar([row(day)]),{myUsage:async()=>{calls.push('today');return report(day,30);},daily:async d=>{calls.push(d);return report(d,40);}});
 await p.onShow();assert.equal(p.data.dayView.exact,'30');setNow('2026-11-01T00:01:00+08:00');await p.chooseDate(day);
 assert.deepEqual(calls,['today',day]);assert.equal(p.data.dayView.exact,'40');assert.equal(p.data.selected.day,day);
});
test('切换日期、离页、换月份或换账号后，迟到金额不能覆盖新的选择',async()=>{
 const a='2026-10-01',b='2026-10-02',raw=calendar([row(a),row(b)]);let resolveA;
 const {p}=fixture(raw,{daily:d=>d===b?Promise.resolve(report(b,20,{status:'complete',usd_micros:2000000})):new Promise(r=>resolveA=r)});
 await p.onShow();const pending=p.chooseDate(a);await p.chooseDate(b);resolveA(report(a,999));await pending;
 assert.equal(p.data.selected.day,b);assert.equal(p.data.dayView.cost,'$2.0000');assert.equal(p.data.dayView.exact,'20');
 for(const interrupt of [f=>f.p.onHide(),f=>f.changeAccount(),f=>f.p.setData({report:{...f.p.data.report,month:'2026-09'},selected:null})]){
  let resolve;const f=fixture(calendar([row(a)]),{daily:()=>new Promise(r=>resolve=r)});await f.p.onShow();const pending=f.p.chooseDate(a);await flush();interrupt(f);resolve(report(a));await pending;assert.notEqual(f.p.data.dayView.cost,'$98.7654');
 }
});
test('估算失败只影响金额，可单独重试；日期不匹配不显示错误配对',async()=>{
 const day='2026-10-01';let fail=true,force;const {p}=fixture(calendar([row(day,258000000)]),{daily:async(d,o)=>{force=o.force;if(fail)throw Error('offline');return report(d);}});
 await p.onShow();await p.chooseDate(day);assert.equal(p.data.dayView.amount.value,'2.58');assert.match(p.data.dayCostError,/重试/);assert.equal(p.data.dayCostBusy,false);
 fail=false;await p.retryDayDetails();assert.equal(force,true);assert.equal(p.data.dayView.cost,'$98.7654');assert.equal(p.data.dayCostError,'');
 const wrong=fixture(calendar([row(day)]),{daily:async()=>report('2026-10-02')});await wrong.p.onShow();await wrong.p.chooseDate(day);assert.equal(wrong.p.data.dayView.cost,'—');assert.match(wrong.p.data.dayCostError,/重试/);
});
test('未同步或未来日期不补成零估算，不发多余日报请求',async()=>{
 let reads=0;const {p}=fixture(calendar([{day:'2026-10-01',reported:false,tokens:null},{day:'2026-10-31',reported:false,tokens:null},{day:'2026-11-01',future:true,reported:false,tokens:null}]),{daily:async()=>reads++,myUsage:async()=>reads++});
 await p.onShow();await p.chooseDate('2026-11-01');assert.equal(p.data.dayView.cost,'—');assert.equal(p.data.dayView.reported,false);assert.equal(reads,0);
});
