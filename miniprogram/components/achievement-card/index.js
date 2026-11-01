Component({
 properties:{badge:{type:Object,value:null},family:{type:Object,value:null},user:{type:Object,value:null},shared:{type:Boolean,value:false},playing:{type:Boolean,value:false}},
 data:{avatarFailed:false},
 observers:{'user.avatar_url'(){this.setData({avatarFailed:false});}},
 methods:{avatarError(){this.setData({avatarFailed:true});},artReady(){this.triggerEvent('artready',{id:this.properties.badge?.id});},artError(){this.triggerEvent('arterror',{id:this.properties.badge?.id});}},
});
