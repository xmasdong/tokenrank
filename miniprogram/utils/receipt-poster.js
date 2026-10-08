const { integer, formatTokens } = require('./usage');
const { presentCost, issuedAt } = require('./cost');
const { drawCodeBadge } = require('./share-code');
const SANS = '"PingFang SC", "Noto Sans CJK SC", "Apple Color Emoji", sans-serif';
const NUM = '"Avenir Next", "PingFang SC", "Apple Color Emoji", sans-serif';
const HEIGHT = 1940;
function drawReceiptPoster(ctx, { user, usage, created_at, theme = 'paper', cover = false, codeImage, previewOnly = false }) {
  if (!cover && !codeImage && !previewOnly) throw new Error('小程序码尚未就绪，请重试');
  const ink = theme === 'ink';
  const C = ink ? { bg:'#17211C', paper:'#27332C', text:'#F5EDDA', muted:'#C0C5B5', rule:'#536255', accent:'#D2B677' }
    : { bg:'#E7E8DB', paper:'#FBF7ED', text:'#302F29', muted:'#777263', rule:'#D7CFBE', accent:'#A8392D' };
  const cost = presentCost(usage.cost), H = cover ? 800 : HEIGHT, L = 106, R = 894, W = R-L;
  const txt = (value,x,y,size=28,color=C.text,weight=400,align='left',width=W,font=SANS) => {
    ctx.fillStyle=color;ctx.textBaseline='alphabetic';ctx.textAlign=align;
    let text=String(value);ctx.font=`${weight} ${size}px ${font}`;
    while(size>18 && ctx.measureText(text).width>width){size--;ctx.font=`${weight} ${size}px ${font}`;}
    if(ctx.measureText(text).width>width){const chars=[...text];while(chars.length && ctx.measureText(chars.join('')+'…').width>width)chars.pop();text=chars.join('')+'…';}
    ctx.fillText(text,x,y);
  };
  const rule = y => {ctx.strokeStyle=C.rule;ctx.lineWidth=2;ctx.setLineDash([7,6]);ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.setLineDash([]);};
  const row = (label,value,y) => {txt(label,L,y,27);txt(value,R,y,29,C.text,500,'right',600,NUM);};
  ctx.fillStyle=C.bg;ctx.fillRect(0,0,1000,H);
  ctx.fillStyle=C.paper;ctx.beginPath();ctx.moveTo(54,48);
  for(let x=54;x<=946;x+=28)ctx.lineTo(x,48+((x-54)/28%2?12:0));
  ctx.lineTo(946,48);
  ctx.lineTo(946,H-48);
  for(let x=946;x>=54;x-=28)ctx.lineTo(x,H-48-((946-x)/28%2?12:0));
  ctx.lineTo(54,H-48);
  ctx.closePath();ctx.fill();
  txt('TOKEN 群排名',500,120,23,C.accent,600,'center');
  txt('AI 用量账单',500,196,52,C.text,700,'center');
  const range=usage.from===usage.to ? usage.to : `${usage.from} — ${usage.to}`;
  if(cover){
    txt(user.nickname || 'AI 玩家',500,276,30,C.text,600,'center');
    txt(range,500,322,23,C.muted,400,'center');rule(367);
    txt(cost.label,500,423,27,C.muted,500,'center');
    txt(cost.available?'$'+cost.amount:'—',500,548,104,C.text,700,'center',W,NUM);
    txt('API 等值估算 · USD · 非实际扣费',500,604,24,C.muted,400,'center');
    txt(cost.note || '非实际扣费',500,686,23,C.muted,400,'center');return;
  }
  row('日期范围',range,280);row('生成时间',issuedAt(created_at) || '—',337);
  row('账户',user.nickname || 'AI 玩家',394);rule(438);
  txt(cost.label,500,499,28,C.text,500,'center');
  txt(cost.available?'$'+cost.amount:'—',500,614,100,C.text,700,'center',W,NUM);
  txt('API 等值估算 · USD · 非实际扣费',500,661,24,C.muted,400,'center');
  txt(cost.note || (cost.available?'按本机价格表计算':'金额尚未同步'),500,704,22,C.muted,400,'center');
  txt(`活跃 ${integer(usage.summary.active_days)} 天${cost.modelCount ? ` · ${cost.modelCount} 个模型` : ''}`,500,759,24,C.muted,400,'center');
  row('总用量',formatTokens(usage.summary.tokens)+' Tokens',822);
  row('缓存读取',formatTokens(usage.summary.cache_read)+' Tokens',875);
  row('缓存写入',formatTokens(usage.summary.cache_write)+' Tokens',928);rule(974);
  txt('模型',L,1025,24,C.muted);txt('USD',R,1025,24,C.muted,400,'right');
  if(cost.models.length) cost.models.forEach((m,i)=>{
    txt(m.name,L,1090+i*56,29,m.other?C.muted:C.text,500,'left',540);
    txt('$'+m.amount,R,1090+i*56,30,m.other?C.muted:C.text,600,'right',270,NUM);
  });
  else {
    txt(cost.unpricedCount?'暂无可计价模型':'更新电脑同步器后可生成金额明细',500,1180,26,C.muted,400,'center');
    txt('Token 用量不受影响',500,1230,23,C.muted,400,'center');
  }
  rule(1420);
  row(cost.note?'已计价合计':'合计',cost.available?'$'+cost.amount:'—',1490);
  drawCodeBadge(ctx,codeImage,368,1560,264);
  if(!codeImage)txt('预览码位',500,1705,22,C.muted,400,'center',210);
  txt('长按识别小程序码',500,1866,23,C.muted,400,'center');
}
module.exports = { drawReceiptPoster, RECEIPT_HEIGHT: HEIGHT };
