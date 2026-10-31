const api=require('../../utils/api');
const {presentGroupInsights,groupReportTitle}=require('../../utils/group-insights');
const {loadCodeImage}=require('../../utils/share-code');
const {drawGroupInsightsPoster,GROUP_POSTER_HEIGHT}=require('../../utils/group-insights-poster');
Page({
  data:{id:'',g:'',period:'day',periods:[{key:'day',label:'今日'},{key:'week',label:'近7天'},{key:'month',label:'近30天'}],
    public:false,report:null,analysis:null,dimension:'models',expanded:false,selectedDay:null,selectedCategory:null,
    loading:true,error:'',record:null,sharePreparing:false,shareError:'',posterPath:'',coverPath:'',imageError:'',imagePreparing:false},
  onLoad(options){this.setData({id:options.id||'',g:options.g||'',public:!!options.id,period:['day','week','month'].includes(options.period)?options.period:'day',dimension:options.dimension==='tools'?'tools':'models'});wx.hideShareMenu();},
  onShow(){this._visible=true;const epoch=api.accountEpoch();if(!this.data.public && this._epoch!==undefined && this._epoch!==epoch)this.setData({report:null,analysis:null});this._epoch=epoch;return this.load();},
  onReady(){this._canvasReady=true;this.buildImages();},
  onHide(){this._visible=false;this._request=(this._request||0)+1;this._imageVersion=(this._imageVersion||0)+1;this.setData({sharePreparing:false,imagePreparing:false});},
  onUnload(){this.onHide();},
  async onPullDownRefresh(){try{await this.load({force:true});}finally{wx.stopPullDownRefresh();}},
  async load(options={}){
    const request=this._request=(this._request||0)+1,epoch=api.accountEpoch();
    const current=()=>this._visible&&request===this._request&&epoch===api.accountEpoch();
    wx.hideShareMenu();this._imageVersion=(this._imageVersion||0)+1;
    this.setData({loading:!this.data.report,error:'',record:null,posterPath:'',coverPath:'',shareError:'',imageError:'',selectedDay:null,selectedCategory:null});
    try{
      let raw,record;
      if(this.data.public){record=await api.sharedRecord(this.data.id);if(record.style!=='group-insights'||!record.report)throw new Error('群数据分享已失效');raw=record.report;}
      else{await api.ensureSession();if(!current())return;raw=await api.groupInsights(this.data.g,this.data.period,options);}
      if(!current())return;
      const report=presentGroupInsights(raw);this.setData({report,analysis:report[this.data.dimension],period:report.period,loading:false});
      if(record){this.setRecord(record);return;}
      this.setData({sharePreparing:true});
      try{record=await api.createGroupInsightsShare(this.data.g,raw.period,raw.snapshot,options);if(current())this.setRecord(record);}
      catch(error){if(current())this.setData({shareError:error.statusCode===409?'群数据已有更新，下拉刷新后再分享':error.message||'分享准备失败，请重试'});}
      finally{if(current())this.setData({sharePreparing:false});}
    }catch(error){if(current())this.setData({loading:false,error:error.message||'群数据暂不可用'});}
  },
  setRecord(record){if(record.style!=='group-insights'||!/^[0-9a-f]{24}$/.test(record.id))throw new Error('分享记录无效');this._recordEpoch=api.accountEpoch();this.setData({record});wx.showShareMenu({menus:['shareAppMessage'],withShareTicket:true});this.buildImages();},
  switchPeriod(e){const period=e.currentTarget.dataset.key;if(this.data.public||period===this.data.period||!['day','week','month'].includes(period))return;this.setData({period,report:null,analysis:null,expanded:false});return this.load();},
  switchDimension(e){const dimension=e.currentTarget.dataset.key;if(!['tools','models'].includes(dimension)||dimension===this.data.dimension)return;this._imageVersion=(this._imageVersion||0)+1;this.setData({dimension,analysis:this.data.report[dimension],expanded:false,selectedCategory:null,posterPath:'',coverPath:'',imageError:''});this.buildImages();},
  selectCategory(e){const row=this.data.analysis.items.find(item=>item.key===(e.detail?.key||e.currentTarget?.dataset.key));this.setData({selectedCategory:row||null});},
  selectDay(e){this.setData({selectedDay:this.data.analysis.daily[e.detail.index]||null});},
  toggleRows(){this.setData({expanded:!this.data.expanded});},
  retry(){return this.load({force:true});},
  goMine(){wx.switchTab({url:'/pages/profile/profile'});},
  goGroup(){if(this.data.g)wx.navigateBack({delta:1});},
  async buildImages(){
    if(!this._visible||!this._canvasReady||!this.data.record||!this.data.report||this.data.posterPath)return;
    if(this._drawing){this._imagePending=true;return;}
    this._drawing=true;const version=this._imageVersion,epoch=api.accountEpoch(),report=this.data.report,dimension=this.data.dimension;
    const current=()=>this._visible&&version===this._imageVersion&&epoch===api.accountEpoch();
    this.setData({imagePreparing:true,imageError:''});
    try{
      const canvas=await new Promise(resolve=>wx.createSelectorQuery().in(this).select('#groupCanvas').fields({node:true}).exec(rows=>resolve(rows?.[0]?.node)));
      if(!canvas||!current())return;const codeImage=await loadCodeImage(canvas);if(!current())return;
      for(const cover of [true,false]){
        canvas.width=1000;canvas.height=cover?800:GROUP_POSTER_HEIGHT;
        drawGroupInsightsPoster(canvas.getContext('2d'),{report,dimension,cover,codeImage});
        const path=await new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas,destWidth:canvas.width,destHeight:canvas.height,fileType:'png',success:r=>resolve(r.tempFilePath),fail:reject}));
        if(!current())return;this.setData(cover?{coverPath:path}:{posterPath:path});
      }
    }catch(error){if(current())this.setData({imageError:'图片生成失败，点此重试'});}
    finally{this._drawing=false;if(current())this.setData({imagePreparing:false});if(this._imagePending){this._imagePending=false;this.buildImages();}}
  },
  shareImage(){
    const path=this.data.posterPath,record=this.data.record,epoch=api.accountEpoch();if(!path||!record||epoch!==this._recordEpoch)return;
    const preview=()=>{if(this._visible&&epoch===api.accountEpoch())wx.previewImage({urls:[path]});};
    if(!wx.showShareImageMenu){preview();return;}
    wx.showShareImageMenu({path,needShowEntrance:true,entrancePath:`/pages/group-report/group-report?id=${record.id}&dimension=${this.data.dimension}`,fail:error=>{if(!/cancel/i.test(error.errMsg||''))preview();}});
  },
  onShareAppMessage(){
    const record=this.data.record;if(!record||this._recordEpoch!==api.accountEpoch()||record.expires_at<=Date.now())return{title:'Token 群排名',path:'/pages/index/index'};
    return{title:groupReportTitle(this.data.report),path:`/pages/group-report/group-report?id=${record.id}&dimension=${this.data.dimension}`,imageUrl:this.data.coverPath||'/assets/share-cover.png'};
  },
});
