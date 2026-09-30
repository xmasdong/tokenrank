const { integer } = require('./usage');
const { story, nameOf } = require('./share-story');
const { drawCodeBadge } = require('./share-code');
const THEMES = {
  paper: { bg: '#F7F3E9', ink: '#252C26', soft: '#727467', accent: '#A8392D', panel: '#A8392D', onPanel: '#FFF4E3', rule: '#D8D1C1', gold: '#907329' },
  ink: { bg: '#222C27', ink: '#F5EDDA', soft: '#B2B9A8', accent: '#D2B677', panel: '#D2B677', onPanel: '#222C27', rule: '#526052', gold: '#D2B677' },
};
const SANS = '"PingFang SC", "Noto Sans CJK SC", sans-serif';
const NUM = '"Avenir Next", "PingFang SC", "Noto Sans CJK SC", sans-serif';
function drawUsagePoster(ctx, { user, usage, theme = 'paper', cover = false, codeImage, avatarImage, previewOnly = false }) {
  // Chat covers already open the app when tapped; only saved posters carry the mini program code.
  if (!cover && !codeImage && !previewOnly) throw new Error('小程序码尚未就绪，请重试');
  const C = THEMES[theme] || THEMES.paper, S = story(usage), W = 1000, H = cover ? 800 : 1400, L = 64, R = 936;
  const txt = (v,x,y,size,color=C.ink,weight=400,width=872,font=SANS,align='left') => {
    const value=String(v);ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;
    ctx.font=`${weight} ${size}px ${font}`;
    while(size>20&&ctx.measureText(value).width>width){size--;ctx.font=`${weight} ${size}px ${font}`;}
    let content=value;
    if(ctx.measureText(value).width>width){const chars=[...value];while(chars.length&&ctx.measureText(chars.join('')+'…').width>width)chars.pop();content=chars.join('')+'…';}
    ctx.fillText(content,x,y);return ctx.measureText(content).width;
  };
  const rule=(y,x=L,to=R)=>{ctx.beginPath();ctx.strokeStyle=C.rule;ctx.lineWidth=1;ctx.moveTo(x,y);ctx.lineTo(to,y);ctx.stroke();};
  const qr=(x,y,size)=>{drawCodeBadge(ctx,codeImage,x,y,size);
    if(!codeImage) {txt('小程序码区域',x+size/2,y+size/2-8,20,'#727467',400,size-28,SANS,'center');txt('预览不含真实码',x+size/2,y+size/2+22,18,'#727467',400,size-20,SANS,'center');}};
  const avatar=(x,y,size)=>{if(avatarImage){ctx.save();ctx.beginPath();ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2);ctx.clip();ctx.drawImage(avatarImage,x,y,size,size);ctx.restore();}
    else {ctx.fillStyle=C.panel;ctx.beginPath();ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2);ctx.fill();txt([...nameOf(user)][0],x+size/2,y+size*.68,size*.44,C.onPanel,600,size-8,SANS,'center');}};
  // Number with a smaller, lighter unit so "21 天" doesn't read as one heavy block.
  const numUnit=(value,unit,x,y,size,color=C.ink,width=264)=>{const w=txt(value,x,y,size,color,700,width,NUM);txt(unit,x+w+8,y,Math.round(size*.45),C.soft,400,Math.max(40,width-w),SANS);};
  ctx.fillStyle=C.bg;ctx.fillRect(0,0,W,H);
  txt('Token 群排名',L,66,24,C.ink,700);
  txt(usage.to,R,66,22,C.soft,400,300,SANS,'right');
  rule(92);
  avatar(L,cover?114:124,cover?62:78);
  txt(nameOf(user),cover?146:162,cover?156:173,cover?28:32,C.ink,600,700);
  if(cover) {
    txt(`${S.label}用量`,L,276,28,C.soft);
    const width=txt(S.value,L-4,446,140,C.accent,700,660,NUM);
    txt(`${S.unit} Tokens`,L+width+16,443,34,C.accent,600,Math.max(130,862-width));
    rule(516);
    txt(`${S.rankText}  全站`,L,590,33,C.ink,600,420);
    txt(`${S.streakLabel} ${S.streakValue} 天 · 累计活跃 ${S.days} 天`,L,640,25,C.soft,400,420);
    txt(S.top?S.top.name:'暂无工具明细',R,590,30,C.ink,600,420,SANS,'right');
    txt(`${integer(usage.summary.requests)} 次调用`,R,640,25,C.soft,400,420,SANS,'right');
    txt(`${S.basisLabel} · ${S.timezoneLabel}`,L,760,18,C.soft);
    return;
  }
  ctx.fillStyle=C.panel;ctx.fillRect(L,242,872,380);
  txt(`${S.label}用量`,L+34,304,30,C.onPanel,500);
  const width=txt(S.value,L+28,479,160,C.onPanel,700,646,NUM);
  txt(S.unit,L+width+46,474,49,C.onPanel,600,100);
  txt(`${integer(usage.summary.tokens)} tokens`,L+34,560,25,C.onPanel,400,800);
  const range=usage.from===usage.to?usage.to:`${usage.from} — ${usage.to}`;
  txt(range,L,682,22,C.soft);txt(S.shortNote,R,682,19,C.soft,400,480,SANS,'right');
  const cols=[L,365,670];
  txt('全站用量排名',cols[0],747,23,C.soft);txt(S.streakLabel,cols[1],747,23,C.soft);txt('累计活跃',cols[2],747,23,C.soft);
  txt(S.rankText,cols[0],814,53,C.ink,700,264,NUM);
  numUnit(S.streakValue,'天',cols[1],814,53);
  numUnit(S.days,'天',cols[2],814,53);
  txt(S.rankNote,cols[0],855,19,C.soft,400,272);txt(S.streakNote,cols[1],855,19,C.soft,400,272);
  txt(S.firstDay?`自 ${S.firstDay} 起`:'暂无活跃记录',cols[2],855,19,C.soft,400,272);
  rule(890);
  txt('主力 AI 工具',L,947,27,C.ink,600);txt('按同期 Token 用量',R,947,21,C.soft,400,360,SANS,'right');
  txt(S.top?.name || '暂无工具明细',L,1000,38,C.ink,600,520);
  txt(S.top?`${Number(S.top.percent||0).toFixed(1)}%`:'待同步',R,1000,29,C.accent,600,290,NUM,'right');
  ctx.fillStyle=C.rule;ctx.fillRect(L,1022,872,8);ctx.fillStyle=C.accent;ctx.fillRect(L,1022,872*Math.min(1,Math.max(0,(S.top?.percent||0)/100)),8);
  
  rule(1080);
  txt('调用次数',L,1150,24,C.soft);
  numUnit(integer(usage.summary.requests),'次',L,1228,58,C.ink,544);
  txt('长按识别小程序码',L,1310,22,C.soft,400,560);
  qr(676,1106,260);
}
module.exports={THEMES,drawUsagePoster,nickname:nameOf};
