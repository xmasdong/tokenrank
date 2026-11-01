const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
 let now=1000,epoch=0,sequence=0;const timers=new Map(),frames=[],confirmed=[],released=[],finished=[],toasts=[];
 const api={accountEpoch:()=>epoch,accountState:()=>'',confirmAchievements:async id=>{confirmed.push(id);return{confirmed:true};},releaseAchievements:async id=>{released.push(id);return{released:true};}};
 const wx={nextTick:fn=>frames.push(fn),showToast:o=>toasts.push(o.title)},module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/achievement-playback.js'),'utf8'),{module,require:()=>({finish:id=>finished.push(id),validTicket:(id,a)=>id==='valid'&&a.accountEpoch()===0}),Date:{now:()=>now},setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)});
 const badge={id:'total:100000000',earned:true};
 const p={...module.exports.achievementPlayback(wx,api),_visible:true,data:{motion:true,selected:{badge}},setData(v,done){Object.assign(this.data,v);done?.();},_achievementClaim:{id:'claim',badgeId:badge.id,epoch:0,expiresAt:61000,confirmed:false,ackPending:false}};
 function advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}}
 return{p,api,confirmed,released,finished,toasts,frames,advance,render:()=>{while(frames.length)frames.shift()();},art:()=>p.onBadgeArtReady({detail:{id:badge.id}}),hide:()=>{p._visible=false;p.cancelAchievementDisplay();},changeAccount:()=>epoch++};
}
test('图片未就绪及首帧前不确认；可见动画完成后才提交一次确认',async()=>{
 const f=fixture();f.p.requestAchievementPlayback();f.advance(1000);assert.equal(f.confirmed.length,0);
 f.art();assert.equal(f.confirmed.length,0);f.render();assert.equal(f.p.data.achievementPlaying,true);
 f.advance(699);assert.equal(f.confirmed.length,0);f.advance(1);await flush();assert.deepEqual(f.confirmed,['claim']);assert.equal(f.p._achievementClaim.confirmed,true);
 f.hide();assert.equal(f.released.length,0);
});
test('图片加载前离页、动画中离页及切换账号均不确认，离页释放未展示资格',async()=>{
 const a=fixture();a.p.requestAchievementPlayback();a.hide();a.art();a.render();a.advance(1000);await flush();assert.equal(a.confirmed.length,0);assert.deepEqual(a.released,['claim']);
 const b=fixture();b.p.requestAchievementPlayback();b.art();b.render();b.advance(300);b.hide();b.advance(1000);await flush();assert.equal(b.confirmed.length,0);assert.deepEqual(b.released,['claim']);
 const c=fixture();c.p.requestAchievementPlayback();c.art();c.render();c.changeAccount();c.advance(1000);await flush();assert.equal(c.confirmed.length,0);
});
test('手动重播只播放当前已达成奖章，不准备、确认或修改任何历史展示记录',async()=>{
 const f=fixture();f.p._achievementClaim=null;f.art();
 for(let i=0;i<2;i++){f.p.replayMotion();f.render();assert.equal(f.p.data.achievementPlaying,true);f.advance(700);await flush();assert.equal(f.p.data.achievementPlaying,false);}
 assert.equal(f.confirmed.length,0);assert.equal(f.released.length,0);
 f.p.data.selected.badge.earned=false;f.p.replayMotion();f.render();assert.equal(f.p.data.achievementPlaying,false);
});
test('关闭动效时自动展示静态奖章，仍等渲染完成；手动重播不绕过偏好',async()=>{
 const f=fixture();f.p.data.motion=false;f.p.replayMotion();assert.equal(f.frames.length,0);assert.equal(f.toasts.length,1);
 f.p.requestAchievementPlayback();f.art();f.render();assert.equal(f.p.data.achievementPlaying,false);f.advance(249);assert.equal(f.confirmed.length,0);f.advance(1);await flush();assert.equal(f.confirmed.length,1);
});
test('图片失败不确认，确认失败如实保留补播机会；409重试有上限',async()=>{
 const f=fixture();f.p.requestAchievementPlayback();f.p.onBadgeArtError({detail:{id:'total:100000000'}});f.advance(1000);assert.equal(f.confirmed.length,0);assert.match(f.p.data.motionError,/图片加载失败/);
 let attempts=0;f.api.confirmAchievements=async()=>{attempts++;const e=Error('changed');e.statusCode=409;throw e;};
 f.p.requestAchievementPlayback();f.art();f.render();f.advance(700);await flush();assert.equal(attempts,2);assert.equal(f.p._achievementClaim.confirmed,false);assert.match(f.p.data.motionError,/确认失败/);f.hide();assert.equal(f.released.length,1);
});
test('账号失效的页面交接释放旧提示队列，但不取得展示资格',()=>{
 const f=fixture();f.changeAccount();f.p.initAchievementUnlock({unlock:'1',ticket:'valid'});assert.equal(f.p._unlocking,false);assert.deepEqual(f.finished,['valid']);
});
