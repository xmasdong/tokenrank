const {compact,integer}=require('./usage');
const {detailsView}=require('./calendar-display');
const COLORS=['#EFF2F5','#9BE9A8','#40C463','#30A14E','#216E39'];
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const monday=day=>addDays(day,-(new Date(day+'T00:00:00Z').getUTCDay()+6)%7);

function heatmapView(report) {
  if(Array.isArray(report.heatmap?.weeks)&&Array.isArray(report.heatmap?.days))return report.heatmap;
  const source=report.heatmap, extended=Array.isArray(source?.daily)&&source.daily.length>0;
  const raw=extended?source.daily:report.daily;
  const from=extended?source.from:report.month+'-01';
  const past=raw.filter(day=>!day.future);
  const to=extended?source.to:past[past.length-1]?.day||report.month+'-01';
  const [year,month]=report.month.split('-').map(Number);
  const monthEnd=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  const start=monday(from),last=extended?source.end:addDays(monday(monthEnd),6);
  const byDay=new Map(raw.map(day=>[day.day,day]));
  const max=Math.max(0,...raw.filter(day=>day.reported&&!day.future&&!day.outside).map(day=>day.tokens));
  const count=Math.round((Date.parse(last+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000)+1;
  const days=Array.from({length:count},(_,i)=>{
    const day=addDays(start,i),row=byDay.get(day),inMonth=day.slice(0,7)===report.month;
    const outside=extended?day<from||day>to||!!row?.outside:!inMonth;
    const future=!!row?.future||(!extended&&inMonth&&!!report.today&&day>report.today);
    const reported=!outside&&!future&&!!row?.reported,tokens=reported?row.tokens:null;
    const level=!reported||!tokens?0:Math.min(4,Math.max(1,Math.ceil(tokens/max*4)));
    return {...row,day,reported,tokens,outside,future,level,number:Number(day.slice(-2)),detailView:detailsView(row?.details),
      state:outside?'outside':future?'future':!reported?'missing':tokens===0?'zero':'used',
      statusText:outside?'范围外':future?'未到日期':!reported?'未同步':tokens===0?'已同步 · 零用量':'已同步',
      amount:reported?compact(tokens):null,exact:reported?integer(tokens):'',requestsText:reported?integer(row.requests):''};
  });
  const weeks=[];
  for(let i=0;i<days.length;i+=7){const cells=days.slice(i,i+7);const label=cells.find(day=>!day.outside&&(day.day.endsWith('-01')||day.day===from));
    weeks.push({key:cells[0].day,days:cells,label:label?Number(label.day.slice(5,7))+'月':''});}
  const summary=extended?source.summary:report.summary;
  const peak=days.filter(day=>day.reported&&day.tokens>0).sort((a,b)=>b.tokens-a.tokens||a.day.localeCompare(b.day))[0]||null;
  return {from,to,days,weeks,summary,peak,extended,details:source?.details||report.details||null,detailView:detailsView(source?.details||report.details),periodLabel:extended?'近 13 周':'本月',
    rangeText:from+' — '+to,amount:summary.reported_days?compact(summary.tokens):null,exact:summary.reported_days?integer(summary.tokens):'',
    weekdays:['一','二','三','四','五','六','日'],rows:['一','','三','','五','','']};
}
module.exports={COLORS,heatmapView};
