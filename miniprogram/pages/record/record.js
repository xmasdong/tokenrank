const api=require('../../utils/api');
const privacyNotice = require('../../utils/privacy-notice');
const {story,shareTitle}=require('../../utils/share-story');
const {integer}=require('../../utils/usage');
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
  onShow(){ privacyNotice.maybeShow(wx);this.setData({fromGroup:flow.enteredFromGroup()});return this.load();},
  onHide(){this._requestId=(this._requestId||0)+1;},
  onUnload(){this.onHide();},
  async load(){
    wx.hideShareMenu();
    if(!this.data.id){this.setData({loading:false,error:'链接无效，请重新打开卡片。'});return;}
    const requestId=this._requestId=(this._requestId||0)+1;
    this.setData({loading:true,error:'',record:null});
    try{const record=await api.sharedRecord(this.data.id);if(requestId!==this._requestId)return;
      this.setData({record,initial:[...(record.user.nickname||'记')][0],story:story(record.usage,this.data.mode),exact:integer(record.usage.summary.tokens),loading:false});
      wx.showShareMenu({menus:['shareAppMessage'],withShareTicket:true});
    }catch(err){if(requestId===this._requestId)this.setData({loading:false,error:err.message});}
  },
  avatarError(){this.setData({avatarFailed:true});},
  goMine(){wx.switchTab({url:'/pages/profile/profile'});},
  goGroup(){wx.navigateTo({url:'/pages/group/group?enter=1'});},
  onShareAppMessage(){
    const record=this.data.record;
    return record ? {title:shareTitle(record.user,record.usage),path:'/pages/record/record?id='+this.data.id}
      : {title:'Token 用量统计',path:'/pages/index/index'};
  },
});
