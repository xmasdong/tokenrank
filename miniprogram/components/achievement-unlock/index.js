const api=require('../../utils/api');
const prompt=require('../../utils/achievement-prompt');
// This component coordinates entry only; the celebration uses a normal native page.
Component({
 properties:{user:{type:Object,value:null,observer(){this.maybeShow();}}},
 lifetimes:{attached(){this._active=true;this.maybeShow();},detached(){this._active=false;this.close();}},
 pageLifetimes:{show(){this._active=true;this.maybeShow();},hide(){this._active=false;this.close();}},
 methods:{
  maybeShow(){
   if(!this._active)return;
   prompt.maybePrompt(api,wx,this.properties.user,()=>this._active,(result,done)=>{
    this._done=null;
    wx.navigateTo({url:'/pages/achievements/achievements?unlock=1&ticket='+encodeURIComponent(result.ticket),fail:done});
   },done=>{this._done=done;});
  },
  close(){const done=this._done;this._done=null;done?.();},
 },
});
