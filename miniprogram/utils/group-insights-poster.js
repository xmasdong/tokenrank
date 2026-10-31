const {drawCodeBadge} = require('./share-code');
const {drawDonut,drawTrend} = require('./analytics-chart');
const GROUP_POSTER_HEIGHT=1640;
function drawGroupInsightsPoster(ctx,{report,dimension='models',cover=false,codeImage}) {
  if(!codeImage)throw new Error('小程序码尚未就绪，请重试');
  const analysis=report[dimension], width=1000, height=cover?800:GROUP_POSTER_HEIGHT;
  const text=(value,x,y,size=28,color='#191919',max=900,align='left')=>{
    ctx.font=`400 ${size}px "PingFang SC",sans-serif`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='alphabetic';
    const chars=[...String(value??'')];while(chars.length && ctx.measureText(chars.join('')).width>max)chars.pop();
    const truncated=chars.length<[...String(value??'')].length;ctx.fillText(chars.join('')+(truncated?'…':''),x,y);
  };
  const rule=y=>{ctx.fillStyle='#EDEDED';ctx.fillRect(48,y,904,1);};
  ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,width,height);
  text('Token 群排名 · 群用量',48,54,25,'#888888');text(report.periodLabel,952,54,25,'#888888',180,'right');
  text(report.group.name,48,120,44,'#191919',904);text(report.range,48,164,25,'#888888');
  text(report.amount.value,48,278,84,'#D88A2D',700);text(`${report.amount.unit} Tokens · 含缓存`,48,330,30,'#888888');
  text(report.costText,48,410,40);text(`${report.costLabel} · USD`,48,452,23,'#888888');
  text(`${report.summary.active_users} 人活跃 / ${report.group.members} 人加入`,952,407,29,'#191919',480,'right');
  text(`${report.summary.reported_users} 人有同步记录`,952,452,23,'#888888',480,'right');rule(488);
  text(dimension==='models'?'模型用量':'工具用量',48,548,32);
  if(cover){
    analysis.items.slice(0,2).forEach((row,i)=>{text(row.name,48,604+i*54,28,'#191919',570);text(row.percent+'%',700,604+i*54,28,'#D88A2D',150,'right');});
    if(!analysis.items.length)text('暂无明细',48,610,26,'#888888');
    drawCodeBadge(ctx,codeImage,780,556,172);text('北京时间 · 本群公开用量',48,764,23,'#888888');return;
  }
  ctx.save();ctx.translate(28,565);ctx.scale(1.5,1.5);drawDonut(ctx,260,250,analysis.segments,analysis.centerValue,analysis.centerLabel);ctx.restore();
  analysis.segments.slice(0,6).forEach((row,i)=>{
    const y=616+i*62;ctx.fillStyle=row.color;ctx.fillRect(464,y-18,12,12);
    text(row.name,492,y,25,'#191919',330);text(row.chartPercent+'%',952,y,25,'#666666',115,'right');
  });
  if(!analysis.items.length)text('暂无明细',492,640,26,'#888888');
  text(`覆盖 ${analysis.summary.detail_users} 人 · ${analysis.categoryCount} 个${dimension==='models'?'模型':'工具'}${analysis.has_overlap?' · 按明细占比':''}`,48,980,23,'#888888');
  rule(1012);text(`近 ${analysis.trend_days} 天群用量`,48,1068,32);
  ctx.save();ctx.translate(20,1100);ctx.scale(2,2);drawTrend(ctx,470,132,analysis.daily.map(day=>({...day,value:day.tokens})));ctx.restore();
  rule(1382);text(report.costNote || 'API 等值估算 · 非实际账单',48,1432,23,'#888888',670);
  text('Token 群排名',48,1508,32);text('长按识别小程序码',48,1554,25,'#888888');
  text('群数据快照 · 北京时间',48,1602,22,'#888888');drawCodeBadge(ctx,codeImage,746,1410,206);
}
module.exports={GROUP_POSTER_HEIGHT,drawGroupInsightsPoster};
