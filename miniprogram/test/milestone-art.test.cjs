const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {STAGES}=require('../utils/milestone-art');
const {badgeView,familyView,loadBadgeImage}=require('../utils/milestones');
async function catalogue(){const {buildAchievements}=await import('../../server/src/achievements.js');return buildAchievements([],[],[],{device_id:'test'},Date.parse('2026-10-31T00:00:00+08:00'));}
test('所有服务端四档条件都有不同的实际造型资源，旧分享不带档位仍按原门槛匹配',async()=>{
 const data=await catalogue();let count=0;
 for(const family of data.families.filter(f=>f.badges.length>1)){
  assert.deepEqual(family.thresholds,STAGES[family.id].thresholds);const paths=[],hashes=[];
  for(const badge of family.badges){const b=badgeView(badge);paths.push(b.artPath);const file=path.join(__dirname,'..',b.artPath);assert.ok(fs.existsSync(file),file);hashes.push(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
   const legacy={...badge,tier:999,artPath:'/arbitrary/file.png'};assert.equal(badgeView(legacy).artPath,b.artPath);delete legacy.tier;assert.equal(badgeView(legacy).artPath,b.artPath);count++;
  }
  assert.equal(new Set(paths).size,4);assert.equal(new Set(hashes).size,4);
 }
 assert.equal(count,28);assert.equal(data.families.find(f=>f.id==='connect').badges.length,1);assert.equal(badgeView({...data.families[0].badges[0],art:'../unsafe'}),null);
});
test('收藏缩略图取已达成的最高档，未达成显示第一档，未开放造型保持原图',async()=>{
 const data=await catalogue(),source=data.families.find(f=>f.id==='total');
 const family=familyView({...source,badges:source.badges.map(b=>({...b,earned:b.threshold<=1e9}))});
 assert.equal(family.artPath,badgeView(source.badges[1]).artPath);assert.equal(family.displayBadge.threshold,1e9);
 assert.equal(familyView(source).artPath,badgeView(source.badges[0]).artPath);
 const future=familyView(data.families.find(f=>f.id==='build'));assert.equal(future.artPath,'/assets/badges/build-modules.png');assert.equal(future.badges.length,0);
});
test('分享画布按具体门槛加载图片，而非复用系列图片；未知门槛安全回退原图',async()=>{
 const source=(await catalogue()).families.find(f=>f.id==='total'),loaded=[];
 const canvas={createImage(){return{set src(value){loaded.push(value);queueMicrotask(()=>this.onload());}};}};
 for(const b of source.badges)await loadBadgeImage(canvas,b);
 assert.deepEqual(loaded,source.badges.map(b=>badgeView(b).artPath));assert.equal(new Set(loaded).size,4);
 await loadBadgeImage(canvas,{...source.badges[0],threshold:123456789,tier:100});assert.equal(loaded.at(-1),'/assets/badges/usage-orbit.png');
 await assert.rejects(loadBadgeImage(canvas,{...source.badges[0],art:'https://untrusted.test/image.png'}),/奖章图片不可用/);
});
