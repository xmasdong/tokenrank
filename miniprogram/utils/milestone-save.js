// Only the user's explicit Save tap invokes the native album permission flow.
function milestoneSaving(wx,api){return {
 saveMilestoneImage(){
  const path=this.data.socialPosterPath;if(!path||this.data.saving||!this._socialVisible)return;
  const version=this._socialVersion,epoch=api.accountEpoch();
  const current=()=>this._socialVisible&&version===this._socialVersion&&epoch===api.accountEpoch()&&path===this.data.socialPosterPath;
  this.setData({saving:true});
  wx.saveImageToPhotosAlbum({filePath:path,
   success:()=>{if(current())wx.showToast({title:'已保存到相册',icon:'success'});},
   fail:error=>{if(!current()||/cancel/i.test(error.errMsg||''))return;
    const fallback=()=>{if(current())wx.showToast({title:'保存失败，请重试',icon:'none'});};
    wx.getSetting({success:setting=>{if(!current())return;
     if(setting.authSetting?.['scope.writePhotosAlbum']===false)wx.showModal({title:'允许保存到相册',content:'需要相册权限才能保存图片。',confirmText:'去设置',success:result=>{if(result.confirm&&current())wx.openSetting({});}});
     else fallback();},fail:fallback});},
   complete:()=>this.setData({saving:false})});
 },
};}
module.exports={milestoneSaving};
