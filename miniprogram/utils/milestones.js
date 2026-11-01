const {formatTokens,integer}=require('./usage');
const {stageArt,stageIndex}=require('./milestone-art');
const ART_IDS=['terminal','code-leaves','neural-core','linked-loops','build-modules','release-plane','value-bridge','impact-beacon','steady-flame','upload-calendar','milestone-peaks','usage-orbit'];
const MOTION_KEY='achievement_motion_off';
const artPath=id=>ART_IDS.includes(id)?'/assets/badges/'+id+'.png':'';
const prefixes={connect:'首次同步',requests:'累计调用',models:'记录模型',tools:'使用工具',active:'连续活跃',uploads:'连续上传',peak:'单日',total:'累计'};
function quantity(n,unit){return unit==='Tokens'?formatTokens(n):integer(n)+' '+unit;}
function badgeView(b){
 if(!b||!artPath(b.art)||!Number.isSafeInteger(b.threshold)||b.threshold<1)return null;
 const target=quantity(b.threshold,b.unit),current=quantity(b.current,b.unit);
 return {...b,artPath:stageArt(b)||artPath(b.art),stageIndex:stageIndex(b),targetText:target,title:b.family==='connect'?'首次同步':(prefixes[b.family]||b.label)+' '+target,
  metricText:current,dateText:b.achieved_day?b.achieved_day.replace(/-/g,'.'):'',
  progress:Math.min(100,Math.max(0,b.current/b.threshold*100)),gapText:quantity(Math.max(0,b.threshold-b.current),b.unit)};
}
function familyView(f){
 const badges=f.badges.map(badgeView).filter(Boolean),earned=badges.filter(b=>b.earned);
 const display=earned[earned.length-1]||badges[0];
 return {...f,artPath:display?.artPath||artPath(f.art),badges,earnedCount:earned.length,hasEarned:!!earned.length,
  statusText:!f.enabled?'暂未开放':earned.length?earned.length+' / '+badges.length:'未达成',displayBadge:display||null};
}
function catalogueView(data){
 const families=data.families.map(familyView);let index=0;
 const rows=[];
 for(const future of [false,true]){
  const list=families.filter(f=>!f.enabled===future);
  for(let i=0;i<list.length;i+=3)rows.push({index:index++,future,firstFuture:future&&i===0,items:list.slice(i,i+3)});
 }
 return {...data,families,rows};
}
const milestoneTitle=(user,usage)=>`${user.nickname||'AI 玩家'} · ${badgeView(usage.milestone)?.title||'成就记录'}`;
function loadBadgeImage(canvas,badge){
 return new Promise((resolve,reject)=>{const path=typeof badge==='string'?artPath(badge):badgeView(badge)?.artPath;if(!path){reject(new Error('奖章图片不可用'));return;}const image=canvas.createImage();const timer=setTimeout(()=>reject(new Error('奖章图片加载超时')),10000);
  image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);reject(new Error('奖章图片加载失败'));};image.src=path;});
}
module.exports={ART_IDS,MOTION_KEY,artPath,badgeView,familyView,catalogueView,quantity,milestoneTitle,loadBadgeImage};
