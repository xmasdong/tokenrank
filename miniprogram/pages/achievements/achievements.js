const api=require('../../utils/api');
const {catalogueView,MOTION_KEY,milestoneTitle}=require('../../utils/milestones');
const {socialImages}=require('../../utils/social-images');
const {milestoneSaving}=require('../../utils/milestone-save');
const {achievementPlayback}=require('../../utils/achievement-playback');
Page({
 ...socialImages(wx,api),
 ...milestoneSaving(wx,api),
 ...achievementPlayback(wx,api),
 data:{unlocking:false,newBadgeCount:0,achievementPlaying:false,motionError:'',loading:true,error:'',catalogue:null,rows:[],selected:null,selectedRow:-1,isDetail:false,cardUser:null,showFuture:false,shareReady:false,sharePreparing:false,shareError:'',saving:false,motion:true},
 onLoad(options={}){this._manualReplay=options.replay==='1';this.initAchievementUnlock(options);let badge=typeof options.badge==='string'&&options.badge.length<240?options.badge:'';try{badge=decodeURIComponent(badge);}catch{}this._requestedBadge=badge.length<80?badge:'';this._requestedFamily=typeof options.family==='string'&&options.family.length<40?options.family:'';const isDetail=this._unlocking||!!(this._requestedBadge||this._requestedFamily);this.setData({isDetail,motion:!wx.getStorageSync(MOTION_KEY)});if(isDetail)wx.setNavigationBarTitle?.({title:this._unlocking?'新成就':'成就卡'});wx.showShareMenu?.({menus:['shareAppMessage'],withShareTicket:true});},
 onShow(){this._visible=true;this._socialVisible=true;this.setData({motion:!wx.getStorageSync(MOTION_KEY)});if(!this._unlocking&&this.data.unlocking)this.setData({unlocking:false});return this.load();},
 onReady(){this._socialCanvasReady=true;return this.buildSocialImages();},
 onHide(){this._visible=false;this.cancelAchievementDisplay();this._socialVisible=false;this._loadVersion=(this._loadVersion||0)+1;this._selectionVersion=(this._selectionVersion||0)+1;this._shareTask=null;this._shareRecord=null;this.resetSocialImages();this.setData({sharePreparing:false,shareReady:false});},
 onUnload(){this.onHide();},
 async onPullDownRefresh(){try{await this.load({force:true});}finally{wx.stopPullDownRefresh();}},
 retry(){return this.load({force:true});},
 async load(options={}){
  const version=this._loadVersion=(this._loadVersion||0)+1,epoch=api.accountEpoch();
  this.setData({loading:!this.data.catalogue,error:''});
  try{
   const current=()=>this._visible&&version===this._loadVersion&&epoch===api.accountEpoch();
   const user=await api.ensureLogin();if(!current())return;
   let raw;
   if(this._unlocking&&!this._achievementClaim){
    const prepared=await api.prepareAchievements();
    if(!current()){
     if(prepared.claim_id&&epoch===api.accountEpoch())api.releaseAchievements(prepared.claim_id).catch(()=>{});
     return;
    }
    if(!prepared.badge){this.finishAchievementUnlock();wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/index/index'})});return;}
    this._achievementClaim={id:prepared.claim_id,expiresAt:prepared.expires_at,badgeId:prepared.badge.id,epoch,confirmed:false,ackPending:false};
    this._requestedBadge=prepared.badge.id;raw=prepared.catalogue;this.setData({newBadgeCount:prepared.count});
   }else raw=await api.achievements(options);
   if(!current())return;
   const catalogue=catalogueView(raw);this.setData({catalogue,rows:catalogue.rows,cardUser:user,loading:false});
   const previous=this.data.selected?.badge?.id||this._requestedBadge;
   const family=catalogue.families.find(f=>f.badges.some(b=>b.id===previous))||catalogue.families.find(f=>f.id===this._requestedFamily);
   this._requestedBadge='';
   if(family){this.select(family.id,previous);}
   else if(this.data.selected){this.select(this.data.selected.family.id);}
   else if(this.data.isDetail)this.setData({error:'奖章不存在，请返回收藏页重新选择'});
  }catch(err){if(this._visible&&version===this._loadVersion)this.setData({loading:false,error:err.message||'成就加载失败'});}
 },
 replayEarned(){const badges=(this.data.catalogue?.families||[]).flatMap(f=>f.badges).filter(b=>b.earned).sort((a,b)=>(b.priority||0)-(a.priority||0));if(badges[0]&&this.data.motion)wx.navigateTo({url:'/pages/achievements/achievements?badge='+encodeURIComponent(badges[0].id)+'&replay=1'});},
 selectFamily(e){const id=e.currentTarget.dataset.id;if(this.data.catalogue?.families.some(f=>f.id===id))wx.navigateTo({url:'/pages/achievements/achievements?family='+encodeURIComponent(id)});},
 select(id,badgeId=''){
  const family=this.data.catalogue?.families.find(f=>f.id===id);if(!family)return;
  const badge=family.badges.find(b=>b.id===badgeId)||family.displayBadge;
  const row=this.data.rows.find(r=>r.items.some(f=>f.id===id));
  this.stopAchievementPlayback();if(this.data.selected?.badge?.id!==badge?.id)this._artReadyId='';
  this._selectionVersion=(this._selectionVersion||0)+1;this._shareTask=null;this._shareRecord=null;this.resetSocialImages();
  this.setData({motionError:'',selected:{family,badge:badge||null},selectedRow:row.index,shareReady:false,sharePreparing:false,shareError:''});
  if((this._unlocking&&this._achievementClaim?.badgeId===badge?.id)||(this._manualReplay&&badge?.earned)){this._manualReplay=false;this.requestAchievementPlayback();}
  if(badge?.earned)return this.prepareShare();
 },
 selectTier(e){if(this.data.selected)this.select(this.data.selected.family.id,e.currentTarget.dataset.id);},
 closeDetails(){this._selectionVersion=(this._selectionVersion||0)+1;this._shareTask=null;this._shareRecord=null;this.resetSocialImages();this.setData({selected:null,selectedRow:-1,shareReady:false,sharePreparing:false});},
 toggleFuture(){const showFuture=!this.data.showFuture;if(!showFuture&&this.data.selected&&!this.data.selected.family.enabled)this.closeDetails();this.setData({showFuture});},
 toggleMotion(e){wx.setStorageSync(MOTION_KEY,!e.detail.value);this.setData({motion:e.detail.value});},
 async prepareShare(){
  if(this._shareTask)return this._shareTask;
  const badge=this.data.selected?.badge;if(!badge?.earned||!this._visible)return;
  const version=this._selectionVersion,epoch=api.accountEpoch();const current=()=>this._visible&&version===this._selectionVersion&&epoch===api.accountEpoch();
  this.setData({sharePreparing:true,shareError:''});
  const task=api.createAchievementShare({badge_id:badge.id,achievement_snapshot:this.data.catalogue.snapshot}).then(record=>{
   if(!current())return;this._shareRecord=record;this._shareEpoch=epoch;this._socialRecord=record;this.setData({shareReady:true,cardUser:record.user});return this.buildSocialImages();
  }).catch(err=>{if(current())this.setData({shareError:err.message||'分享准备失败，请刷新重试'});}).finally(()=>{if(current()){this._shareTask=null;this.setData({sharePreparing:false});}});
  this._shareTask=task;return task;
 },
 retryImage(){this.setData({socialImageError:''});return this._shareRecord?this.buildSocialImages():this.prepareShare();},
 previewImage(){if(this.data.socialPosterPath)wx.previewImage({current:this.data.socialPosterPath,urls:[this.data.socialPosterPath]});},
 onShareAppMessage(){const record=this._shareEpoch===api.accountEpoch()?this._shareRecord:null;return record?{title:milestoneTitle(record.user,record.usage),path:'/pages/record/record?id='+record.id,...(this.data.socialCoverPath?{imageUrl:this.data.socialCoverPath}:{})}:{title:'Token 群排名',path:'/pages/index/index'};},
 goConnect(){wx.navigateTo({url:'/pages/connect/connect'});},
});
