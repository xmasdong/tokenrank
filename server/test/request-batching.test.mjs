import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {requestFixture} from './helpers/request-fixture.mjs';
import {beijingDay,beijingDaysAgo} from '../src/lib.js';

test('合并首屏接口仅返回当前登录账号；群身份、资料完善和禁用检查保留',async t=>{
 const f=requestFixture(t,worker);for(const path of ['/api/my/overview','/api/my/groups-overview','/api/groups/g1/page'])assert.equal((await f.req(path,null)).status,401);
 f.db.exec("DELETE FROM rank_group_members WHERE group_id='g1' AND user_id=1");let r=await f.req('/api/groups/g1/page');assert.equal(r.status,200);assert.equal(r.data.group.joined,false);assert.equal(r.data.board,null);assert.equal(r.data.insights,null);
 f.db.exec("INSERT INTO rank_group_members VALUES('g1',1,1,0);UPDATE users SET avatar_path=NULL WHERE id=1");r=await f.req('/api/groups/g1/page');assert.equal(r.data.user.profile_complete,false);assert.equal(r.data.board,null);
 f.db.exec('UPDATE users SET disabled_at=1 WHERE id=1');for(const path of ['/api/my/overview','/api/my/groups-overview','/api/groups/g1/page'])assert.equal((await f.req(path)).status,403);
});

test('群首屏与旧榜单、完整群汇总一致，50名外保留本人；不泄露原始身份或其他设备',async t=>{
 const f=requestFixture(t,worker,{groups:2,users:62});f.seed(1,beijingDay(),999999,{device:'old'});
 f.db.exec('UPDATE users SET nickname=NULL,avatar_path=NULL WHERE id=2');
 const writes=f.db.prepare('SELECT total_changes() n').get().n;
 const [merged,board,insights]=await Promise.all([f.req('/api/groups/g1/page'),f.req('/api/leaderboard?scope=group&id=g1'),f.req('/api/groups/g1/insights')]);
 assert.equal(merged.status,200);assert.deepEqual(merged.data.board,board.data);assert.deepEqual(merged.data.insights,insights.data);
 assert.equal(merged.data.board.me.rank,62);assert.equal(merged.data.board.entries.length,50);assert.equal(merged.data.board.has_more,true);assert.equal(merged.data.board.members,62);
 assert.equal(merged.data.insights.summary.tokens,195300);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,writes);
 assert.doesNotMatch(JSON.stringify(merged.data),/private-|secret-|device_id|contributors|group_openid|session-/);
});

test('群列表批量聚合，查询数量不随加入群数增长；人数优先、近期更新及隐藏状态正确',async t=>{
 for(const groups of [1,20,55]){
  const f=requestFixture(t,worker,{groups});const r=await f.req('/api/my/groups-overview');assert.equal(r.status,200);assert.ok(r.queries<=7,`${groups}群执行${r.queries}SQL`);assert.equal(r.data.rankings.groups.length,Math.min(50,groups));assert.equal(r.data.rankings.groups[0].my_rank,6);assert.equal(r.data.rankings.global.rank,6);
 }
 const f=requestFixture(t,worker,{groups:2});f.db.exec("DELETE FROM rank_group_members WHERE group_id='g1' AND user_id=6;UPDATE rank_group_members SET hidden=1 WHERE group_id='g2' AND user_id=1");
 const r=(await f.req('/api/my/groups-overview')).data;assert.equal(r.rankings.groups[0].id,'g2');assert.equal(r.rankings.groups[0].my_rank,null);assert.equal(r.rankings.groups[1].my_rank,5);
});

test('个人概览复用登录身份，与原始个人统计完全一致，按周期隔离且只读',async t=>{
 const f=requestFixture(t,worker);f.seed(1,beijingDaysAgo(1),20);const before=f.db.prepare('SELECT total_changes() n').get().n;
 for(const period of ['day','week','month','last_month','all']){
  const [r,u]=await Promise.all([f.req('/api/my/overview?period='+period+'&user_id=2'),f.req('/api/my/usage?period='+period)]);
  assert.equal(r.status,200);assert.equal(r.data.user.user_id,1);assert.deepEqual(r.data.usage,u.data);
 }
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('工具和模型合并为一次事务，数值与两个旧接口一致，零值、缺失、重叠和公开样本不变',async t=>{
 const f=requestFixture(t,worker);f.seed(1,beijingDaysAgo(2),150);f.seed(2,beijingDaysAgo(8),0);f.seed(1,'2026-10-01',20);
 f.db.exec("UPDATE daily_totals SET models_json='invalid' WHERE user_id=2;UPDATE users SET rank_hidden=1 WHERE id=3;UPDATE users SET disabled_at=1 WHERE id=4");
 for(const route of ['/api/my/analysis','/api/insights'])for(const period of ['day','week','month','last_month','all']){
  const result=await f.req(route+'?period='+period+'&dimension=tools&bundle=1');assert.equal(result.status,200);assert.ok(result.queries<=6);
  for(const dimension of ['tools','models']){const single=await f.req(route+'?period='+period+'&dimension='+dimension);assert.deepEqual(result.data[dimension],single.data,route+'/'+period+'/'+dimension);}
 }
});

test('合并排行榜分享返回同版本前五名，公开记录不附带私人渲染数据；无历史不写入分享',async t=>{
 const f=requestFixture(t,worker);const r=await f.req('/api/shares',1,{period:'day',style:'usage',include_ranking:true});assert.equal(r.status,200);assert.equal(r.data.ranking.entries.length,5);assert.equal(r.data.ranking.total,6);assert.equal(r.data.ranking.me.tokens,r.data.usage.summary.tokens);assert.equal(r.data.ranking.me.rank,r.data.usage.standing.rank);
 const publicRecord=await f.req('/api/shares/'+r.data.id,null);assert.equal(publicRecord.status,200);assert.equal(publicRecord.data.ranking,undefined);assert.equal(publicRecord.data.user.user_id,undefined);
 const bad=await f.req('/api/shares',1,{style:'receipt',include_ranking:true});assert.equal(bad.status,400);
 const g=requestFixture(t,worker);g.db.exec('DELETE FROM daily_totals');const empty=await g.req('/api/shares',1,{period:'day'});assert.equal(empty.status,400);assert.equal(empty.data.code,'NO_USAGE');assert.equal(g.db.prepare('SELECT COUNT(*) n FROM usage_shares').get().n,0);
});
