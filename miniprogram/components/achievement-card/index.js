Component({
 properties:{badge:{type:Object,value:null},family:{type:Object,value:null},user:{type:Object,value:null},shared:{type:Boolean,value:false},playing:{type:Boolean,value:false},playId:{type:Number,value:0}},
 data:{avatarFailed:false,artNodes:[]},
 observers:{
  'user.avatar_url'(){this.setData({avatarFailed:false});},
  'badge.artPath, family.artPath'(){this.renderArt();},
  'playing, playId'(playing,id){if(playing)this.playBadgeMotion(id);else this.stopBadgeMotion();},
 },
 lifetimes:{ready(){this.renderArt();},detached(){this.stopBadgeMotion();}},
 methods:{
  avatarError(){this.setData({avatarFailed:true});},
  artSource(){return this.properties.badge?.artPath||this.properties.family?.artPath||'';},
  renderArt(force=false){
   const src=this.artSource();if(!src||(!force&&this.data.artNodes[0]?.src===src))return;
   this._loadedSrc='';this._artKey=(this._artKey||0)+1;
   this.setData({artNodes:[{key:this._artKey,src}]});
  },
  ensureArtReady(){
   // Re-read readiness when the page missed a cached image's original load event.
   if(this._loadedSrc===this.artSource())this.triggerEvent('artready',{id:this.properties.badge?.id});
   else this.renderArt(true);
  },
  currentArt(e){return Number(e.currentTarget?.dataset?.artKey)===this._artKey&&e.currentTarget.dataset.artSrc===this.artSource();},
  artReady(e){if(!this.currentArt(e))return;this._loadedSrc=this.artSource();this.triggerEvent('artready',{id:this.properties.badge?.id});},
  artError(e){if(!this.currentArt(e))return;this._loadedSrc='';this.triggerEvent('arterror',{id:this.properties.badge?.id});},
  stopBadgeMotion(){
   this._motionRun=(this._motionRun||0)+1;
   this.clearAnimation?.('.medal-motion');this.clearAnimation?.('.medal-sweep');
  },
  playBadgeMotion(playId){
   this.stopBadgeMotion();const run=this._motionRun,id=this.properties.badge?.id;
   const current=()=>run===this._motionRun&&this.properties.playing&&playId===this.properties.playId&&id===this.properties.badge?.id;
   if(typeof this.animate!=='function'){this.triggerEvent('motionerror',{id,playId});return;}
   // Animate the wrapper view, not the native image; every replay creates a new run.
   try{
    this.animate('.medal-sweep',[
     {opacity:0,translateX:-180,offset:0},{opacity:.7,translateX:-90,offset:.25},{opacity:0,translateX:180,offset:1},
    ],600);
    this.animate('.medal-motion',[
     {opacity:.15,scale:[.86,.86],translateY:12,ease:'cubic-bezier(.16,1,.3,1)'},
     {opacity:1,scale:[1,1],translateY:0},
    ],650,()=>{if(current())this.triggerEvent('motionend',{id,playId});});
   }catch{if(current())this.triggerEvent('motionerror',{id,playId});}
  },
 },
});
