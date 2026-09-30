/** Group codes open the app; joining a real WeChat group still requires its in-chat card. */
const { drawCodeBadge } = require('./share-code');
function drawGroupPoster(ctx, { data, cover = false, codeImage, previewOnly = false }) {
  // Chat covers already open the app when tapped; only saved posters carry the mini program code.
  if (!cover && !codeImage && !previewOnly) throw new Error('小程序码尚未就绪，请重试');
  const W = 750, H = cover ? 600 : 1150, L = 46, R = 704;
  const C = { paper:'#F7F3E9', ink:'#252C26', soft:'#727467', accent:'#A8392D', rule:'#D8D1C1' };
  const sans = '"PingFang SC", "Noto Sans CJK SC", sans-serif', serif = sans; // no Chinese serif anywhere
  const text = (value,x,y,size=24,color=C.ink,width=658,align='left',font=sans) => {
    ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='alphabetic';
    ctx.font=`600 ${size}px ${font}`;
    const chars=[...String(value??'')];
    if(ctx.measureText(chars.join('')).width>width){while(chars.length&&ctx.measureText(chars.join('')+'…').width>width)chars.pop();chars.push('…');}
    ctx.fillText(chars.join(''),x,y);
  };
  const rule=y=>{ctx.fillStyle=C.rule;ctx.fillRect(L,y,R-L,1);};
  const period={day:'今日',week:'近7天',month:'近30天'}[data.period]||'今日';
  ctx.fillStyle=C.paper;ctx.fillRect(0,0,W,H);
  text('Token 群排名',L,cover?40:52,20);text(`${data.members} 人已加入 · ${period}`,R,cover?40:52,20,C.soft,420,'right');
  text(data.name||'本群 Token 排名',L,cover?88:120,cover?35:42,C.ink,658,'left',serif);
  const shown = cover ? 4 : 5;
  const countNote = data.total == null ? `${period} Token 用量`
    : `本周期 ${data.total} 人上榜${data.total > shown ? ` · 展示前 ${shown} 名` : ''}`;
  if(!cover)text(countNote,L,165,23,C.soft);
  rule(cover?113:196);
  const rows=data.entries.slice(0,shown), start=cover?156:250, gap=cover?70:102;
  rows.forEach((e,i)=>{
    const y=start+i*gap;
    text(String(e.rank).padStart(2,'0'),L,y,cover?28:34,C.accent,65);
    text(e.nickname||'AI 玩家',L+65,y,cover?24:28,C.ink,cover?255:280);
    text(e.tokens_fmt,R,y,cover?29:34,e.rank===1?C.accent:C.ink,270,'right');
    text(`${e.requests} 次调用`,L+65,y+28,18,C.soft,330);
    text('Tokens',R,y+28,17,C.soft,150,'right');
    if(i<rows.length-1)rule(y+(cover?44:62));
  });
  if(!rows.length)text('本周期暂无用量',L,start+36,28,C.soft);
  if(cover){
    rule(428);
    text(data.me?`我的群内排名 #${data.me.rank}`:'我的群内排名 —',L,494,28,C.ink,400,'left',serif);
    if(data.me)text(`${data.me.tokens_fmt} Tokens`,R,494,28,C.accent,240,'right');
    text('含缓存总用量 · 北京时间自然日',L,H-22,16,C.soft,330);
    text(countNote,R,H-22,16,C.soft,320,'right');
    return;
  }
  const footer=cover?380:858, size=cover?180:238, qx=R-size, qy=cover?388:874;
  rule(footer-16);
  text(data.me?`我的群内排名 #${data.me.rank}`:'我的群内排名 —',L,footer+32,cover?27:31,C.ink,cover?450:390,'left',serif);
  if(data.me)text(`${data.me.tokens_fmt} Tokens`,L,footer+78,cover?28:34,C.accent,cover?450:390);
  text('扫码进入小程序',L,footer+(cover?121:143),cover?23:25,C.ink,cover?450:390);
  text('入群请点击群内卡片',L,footer+(cover?156:185),cover?20:21,C.soft,cover?450:390);
  drawCodeBadge(ctx,codeImage,qx,qy,size);
  if(!codeImage) {text('小程序码区域',qx+size/2,qy+size/2-5,18,C.soft,size-20,'center');text('预览不含真实码',qx+size/2,qy+size/2+24,17,C.soft,size-16,'center');}
  text('含缓存总用量 · 北京时间自然日',L,H-16,16,C.soft);
}
module.exports={drawGroupPoster};
