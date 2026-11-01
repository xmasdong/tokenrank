const prompt=require('./achievement-prompt');
function achievementPlayback(wx,api){return {
 initAchievementUnlock(options){
  const ticket=typeof options.ticket==='string'?options.ticket:'';
  this._unlockTicket=options.unlock==='1'&&prompt.validTicket(ticket,api)?ticket:'';
  if(options.unlock==='1'&&ticket&&!this._unlockTicket)prompt.finish(ticket);
  this._unlocking=!!this._unlockTicket;
  this.setData({unlocking:this._unlocking});
 },
 stopAchievementPlayback(){
  clearTimeout(this._achievementTimer);clearTimeout(this._artWaitTimer);this._playRevision=(this._playRevision||0)+1;this._playRequested=false;this._activePlayback=null;
  this.setData({achievementPlaying:false,motionWaiting:false});
 },
 finishAchievementUnlock(){
  const ticket=this._unlockTicket;this._unlockTicket='';this._unlocking=false;
  if(ticket)prompt.finish(ticket);
 },
 cancelAchievementDisplay(){
  this.stopAchievementPlayback();
  const claim=this._achievementClaim;this._achievementClaim=null;
  if(claim&&!claim.confirmed&&!claim.ackPending&&claim.epoch===api.accountEpoch())api.releaseAchievements(claim.id).catch(()=>{});
  this.finishAchievementUnlock();
 },
 onBadgeArtReady(e){
  if(e.detail?.id!==this.data.selected?.badge?.id)return;
  this._artReadyId=e.detail.id;this.tryAchievementPlayback();
 },
 onBadgeArtError(e){
  if(e.detail?.id!==this.data.selected?.badge?.id)return;
  this._artReadyId='';this.stopAchievementPlayback();this.setData({motionError:'奖章图片加载失败，请刷新后重试'});
 },
 requestAchievementPlayback(){
  if(!this.data.selected?.badge?.earned||!this._visible)return;
  this.stopAchievementPlayback();this._playRequested=true;this.setData({motionError:'',motionWaiting:true});
  const revision=this._playRevision,epoch=api.accountEpoch();
  this._artWaitTimer=setTimeout(()=>{
   if(!this._visible||revision!==this._playRevision||epoch!==api.accountEpoch()||!this._playRequested)return;
   this.stopAchievementPlayback();this.setData({motionError:'奖章图片未就绪，请点击重播重试'});
  },8000);
  const probe=()=>{if(this._visible&&revision===this._playRevision&&epoch===api.accountEpoch()&&this._playRequested)this.selectComponent?.('#achievementCard')?.ensureArtReady?.();};
  if(wx.nextTick)wx.nextTick(probe);else probe();
  this.tryAchievementPlayback();
 },
 replayMotion(){
  if(!this.data.motion){wx.showToast?.({title:'请先开启解锁动效',icon:'none'});return;}
  this.requestAchievementPlayback();
 },
 tryAchievementPlayback(){
  const badge=this.data.selected?.badge;
  if(!this._playRequested||!this._visible||!badge?.earned||this._artReadyId!==badge.id)return;
  this._playRequested=false;clearTimeout(this._artWaitTimer);
  const revision=this._playRevision,epoch=api.accountEpoch();
  const current=()=>this._visible&&revision===this._playRevision&&epoch===api.accountEpoch()&&this.data.selected?.badge?.id===badge.id;
  const frame=wx.nextTick?fn=>wx.nextTick(fn):fn=>fn();
  frame(()=>{
   if(!current())return;
   this._activePlayback={id:badge.id,playId:revision,epoch};
   this.setData({achievementPlaying:!!this.data.motion,motionWaiting:false,achievementPlayId:revision},()=>{
    if(!current())return;
    // A timeout is an error, never evidence that an animation actually ran.
    this._achievementTimer=setTimeout(()=>{
     if(!current())return;
     if(this.data.motion){this.stopAchievementPlayback();this.setData({motionError:'动效未能播放，请点击重播重试'});}
     else this.onAchievementMotionEnd({detail:{id:badge.id,playId:revision}});
    },this.data.motion?3000:250);
   });
  });
 },
 onAchievementMotionEnd(e){
  const play=this._activePlayback;
  if(!play||!this._visible||play.epoch!==api.accountEpoch()||play.playId!==this._playRevision||play.playId!==e.detail?.playId||play.id!==e.detail?.id||play.id!==this.data.selected?.badge?.id)return;
  const id=play.id;this.stopAchievementPlayback();this.confirmAchievementDisplay(id);
 },
 onAchievementMotionError(e){
  const play=this._activePlayback;
  if(!play||!this._visible||play.epoch!==api.accountEpoch()||play.playId!==e.detail?.playId||play.id!==e.detail?.id)return;
  this.stopAchievementPlayback();this.setData({motionError:'当前微信未能播放动效，请更新微信后重试'});
 },
 async confirmAchievementDisplay(badgeId){
  const claim=this._achievementClaim;
  if(!claim||claim.confirmed||claim.ackPending||claim.badgeId!==badgeId||!this._visible||claim.epoch!==api.accountEpoch())return;
  claim.ackPending=true;
  try{
   for(let attempt=0;attempt<2;attempt++){
    try{const result=await api.confirmAchievements(claim.id);claim.confirmed=result.confirmed===true;break;}
    catch(error){if(error.statusCode!==409||attempt||Date.now()>=claim.expiresAt)throw error;}
   }
  }catch{
   if(this._visible&&claim.epoch===api.accountEpoch())this.setData({motionError:'展示确认失败，可重播后重试'});
  }finally{
   claim.ackPending=false;
   if(!this._visible&&!claim.confirmed&&claim.epoch===api.accountEpoch())api.releaseAchievements(claim.id).catch(()=>{});
  }
 },
};}
module.exports={achievementPlayback};
