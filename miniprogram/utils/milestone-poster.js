const {painter,SOCIAL_HEIGHT}=require('./social-poster');
const {drawCodeBadge}=require('./share-code');
const {badgeView}=require('./milestones');
const COLORS={paper:'#FAFBF5',ground:'#F3F5EF',ink:'#213D2B',soft:'#6A7C67',line:'#DBE3D5',accent:'#BD7931'};
function frame(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();ctx.fillStyle=COLORS.paper;ctx.fill();ctx.strokeStyle=COLORS.line;ctx.lineWidth=2;ctx.stroke();}
function drawMilestonePoster(ctx,{user,usage,cover=false,codeImage,avatarImage,badgeImage}){
 const b=badgeView(usage.milestone);if(!b||!codeImage||!badgeImage)throw new Error('奖章和小程序码尚未就绪，请重试');if(b.earned===false)throw new Error('该奖章尚未达成');
 const H=cover?800:SOCIAL_HEIGHT,p=painter(ctx,H),c=COLORS,title=b.family==='connect'?'首次同步':b.targetText,label=b.family==='connect'?'电脑接入':b.label;
 ctx.fillStyle=c.ground;ctx.fillRect(0,0,1000,H);frame(ctx,28,28,944,H-56,24);
 const text=(value,x,y,size,color=c.ink,width=824,align='left')=>p.text(value,x,y,size,color,width,align);
 text('Token 群排名',80,88,25,c.soft);text('已达成',920,88,24,c.soft,180,'right');
 if(cover){
  ctx.drawImage(badgeImage,62,156,470,470);
  text(label,558,220,28,c.soft,352);text(title,558,302,60,c.ink,352);text('达成于 '+b.dateText,558,356,24,c.soft,352);
  text(b.metric_label,558,430,25,c.soft,352);text(b.metricText,558,480,36,c.accent,352);
  p.avatar(user,avatarImage,112,680,64);text(user.nickname||'AI 玩家',164,692,30,c.ink,530);
  drawCodeBadge(ctx,codeImage,738,550,180);
  text((b.unit==='Tokens'?'含缓存总量 · ':'')+'北京时间 · 分享时的记录',80,748,20,c.soft,824);
 }else{
  ctx.drawImage(badgeImage,245,128,510,510);
  text(label,500,688,29,c.soft,824,'center');text(title,500,778,72,c.ink,824,'center');text('达成于 '+b.dateText,500,836,27,c.soft,824,'center');
  ctx.fillStyle=c.line;ctx.fillRect(80,888,840,1);
  text(b.metric_label,80,950,27,c.soft,500);text(b.metricText,920,950,37,c.accent,360,'right');
  text(usage.to?'截至 '+usage.to+' 的记录':'分享时的记录',80,998,24,c.soft,824);
  p.avatar(user,avatarImage,116,1092,64);text(user.nickname||'AI 玩家',166,1104,31,c.ink,520);
  text((b.unit==='Tokens'?'含缓存总量 · ':'')+'北京时间',80,1160,23,c.soft,600);text('分享时的记录',80,1200,22,c.soft,600);
  drawCodeBadge(ctx,codeImage,718,1026,202);
 }
}
module.exports={drawMilestonePoster,COLORS};
