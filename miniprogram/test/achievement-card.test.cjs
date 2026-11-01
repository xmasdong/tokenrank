const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function card(){
 let definition;const events=[],animations=[],cleared=[];
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/achievement-card/index.js'),'utf8'),{Component:value=>definition=value});
 const p={...definition.methods,properties:{badge:{id:'total:1',artPath:'/badge-1.webp'},playing:false,playId:0},data:structuredClone(definition.data),setData(v){Object.assign(this.data,v);},triggerEvent(name,detail){events.push({name,...detail});},animate(selector,frames,duration,done){animations.push({selector,frames,duration,done});},clearAnimation(selector){cleared.push(selector);}};
 p.renderArt();
 return{p,events,animations,cleared,definition,load(node=p.data.artNodes[0]){p.artReady({currentTarget:{dataset:{artKey:node.key,artSrc:node.src}}});},play(id){p.properties.playing=true;p.properties.playId=id;definition.observers['playing, playId'].call(p,true,id);}};
}
test('缓存图片的加载事件被页面错过后，可重新取得组件就绪状态而不重新加载',()=>{
 const f=card();f.load();f.events.length=0;const key=f.p.data.artNodes[0].key;
 f.p.ensureArtReady();assert.equal(f.events[0].name,'artready');assert.equal(f.events[0].id,'total:1');assert.equal(f.p.data.artNodes[0].key,key);
});
test('未知图片状态强制重建图片节点；旧图片迟到的成功和失败事件不污染当前奖章',()=>{
 const f=card(),old=f.p.data.artNodes[0];f.p.ensureArtReady();const next=f.p.data.artNodes[0];assert.notEqual(next.key,old.key);
 f.load(old);f.p.artError({currentTarget:{dataset:{artKey:old.key,artSrc:old.src}}});assert.equal(f.events.length,0);
 f.load(next);assert.equal(f.events[0].name,'artready');
 f.p.properties.badge={id:'total:2',artPath:'/badge-2.webp'};f.p.renderArt();f.load(next);assert.equal(f.events.length,1);f.load();assert.equal(f.events[1].id,'total:2');
});
test('每次重播都重新调用原生关键帧动画，只有当前播放的完成回调可通知页面',()=>{
 const f=card();f.play(1);assert.equal(f.animations.length,2);assert.equal(f.events.length,0);
 const old=f.animations.find(a=>a.selector==='.medal-motion');assert.equal(old.duration,650);assert.equal(old.frames[0].scale[0],.86);assert.equal(old.frames.at(-1).opacity,1);
 f.play(2);old.done();assert.equal(f.events.length,0);f.animations.at(-1).done();assert.equal(f.events.length,1);assert.equal(f.events[0].playId,2);assert.equal(f.events[0].name,'motionend');
 f.p.stopBadgeMotion();f.animations.at(-1).done();assert.equal(f.events.length,1);
});
test('原生动画不可用或抛错时发出失败事件，不伪造播放完成',()=>{
 const f=card();f.p.animate=undefined;f.play(1);assert.equal(f.events[0].name,'motionerror');
 const g=card();g.p.animate=()=>{throw Error('native failure');};g.play(1);assert.equal(g.events[0].name,'motionerror');
});
