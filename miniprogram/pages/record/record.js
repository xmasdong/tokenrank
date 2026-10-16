const api=require('../../utils/api');
const {story,shareTitle}=require('../../utils/share-story');
const {integer}=require('../../utils/usage');
const {presentCost,issuedAt,receiptTitle}=require('../../utils/cost');
const flow=require('../../utils/flow');
Page({
  data:{id:'',mode:'achievement',loading:true,error:'',record:null,story:null,exact:'',initial:'记',avatarFailed:false,fromGroup:false},
  onLoad(options){
    wx.hideShareMenu();
    let scene='';try{scene=decodeURIComponent(options.scene||'');}catch{}
    const code=/^s=([0-9a-f]{24})(?:&m=([ast]))?$/.exec(scene)||[];
    const id=options.id||code[1]||'';
    const mode=options.mode||({a:'achievement',s:'streak',t:'tool'}[code[2]])||'achievement';
    this.setData({id:/^[0-9a-f]{24}$/.test(id)?id:'',mode:['achievement','streak','tool'].includes(mode)?mode:'achievement'});
  },
  onShow(){this.setData({fromGroup:flow.enteredFromGroup()});return this.load();},
  onHide(){this._requestId=(this._requestId||0)+1;this.setData({openingMine:false});},
  onUnload(){this.onHide();},
  async load(){
    wx.hideShareMenu();
    if(!this.data.id){this.setData({loading:false,error:'链接无效，请重新打开卡片。'});return;}
    const requestId=this._requestId=(this._requestId||0)+1;
    this.setData({loading:true,error:'',record:null});
    try{const record=await api.sharedRecord(this.data.id);if(requestId!==this._requestId)return;
      const group=record.usage.group_standing;
      this.setData({record,group:group||null,groupRank:group?.rank ? '#' + integer(group.rank) : group?.hidden ? '未参与排名' : '未上榜',cost:presentCost(record.usage.cost),issuedAt:issuedAt(record.created_at),initial:[...(record.user.nickname||'记')][0],story:story(record.usage,this.data.mode),exact:integer(record.usage.summary.tokens),loading:false});
      wx.showShareMenu({menus:['shareAppMessage'],withShareTicket:true});
    }catch(err){if(requestId===this._requestId)this.setData({loading:false,error:err.message});}
  },
  avatarError(){this.setData({avatarFailed:true});},
  async goMine(){
    if(api.accountState()){wx.navigateTo({url:'/pages/account/account'});return;}
    if(this.data.openingMine)return;
    const requestId=this._requestId;
    this.setData({openingMine:true});
    try{
      const user=api.peekMe()||await api.ensureLogin();
      if(requestId!==this._requestId)return;
      if(user.last_report_at)wx.switchTab({url:'/pages/profile/profile'});
      else wx.navigateTo({url:'/pages/connect/connect'});
    }catch(err){if(requestId===this._requestId)wx.showToast({title:err.message||'暂时无法打开，请重试',icon:'none'});}
    finally{if(requestId===this._requestId)this.setData({openingMine:false});}
  },
  goConnect(){wx.navigateTo({url:api.accountState()?'/pages/account/account':'/pages/connect/connect'});},
  goGroup(){wx.navigateTo({url:api.accountState()?'/pages/account/account':'/pages/group/group?enter=1'});},
  onShareAppMessage(){
    const record=this.data.record;
    return record ? {title:(record.style==='receipt'?receiptTitle:shareTitle)(record.user,record.usage),path:'/pages/record/record?id='+this.data.id}
      : {title:'Token 用量统计',path:'/pages/index/index'};
  },
});
