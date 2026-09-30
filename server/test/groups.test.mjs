import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { beijingDay } from '../src/lib.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const appid = 'wx-test';
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const keyB64 = Buffer.from(keyBytes).toString('base64');
  const now = Date.now();
  for (const id of [1, 2, 3]) {
    db.prepare('INSERT INTO users(id,openid,session_key,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, `user-${id}`, keyB64, `用户${id}`, `00000000-0000-0000-0000-${String(id).padStart(12,'0')}.png`, now, now);
    db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run(`session-${id}`, id, now + 3600000);
  }
  function prepare(sql) {
    let args = [];
    const params = () => Object.fromEntries(args.map((v, i) => [String(i + 1), v instanceof ArrayBuffer ? new Uint8Array(v) : v]));
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(params()) ?? null; },
      async all() { return { results: db.prepare(sql).all(params()) }; },
      _run() { const r = db.prepare(sql).run(params()); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      async run() { return this._run(); },
    };
  }
  const env = { WX_APPID: appid, DB: { prepare, async batch(stmts) {
    db.exec('BEGIN');
    try { const out = stmts.map(s => s._run()); db.exec('COMMIT'); return out; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  } } };
  async function request(path, body, uid = 1) {
    const response = await worker.fetch(new Request('https://rank.test' + path, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(uid ? { authorization: `Bearer session-${uid}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    return { status: response.status, data: await response.json() };
  }
  async function resolve(groupOpenId, uid = 1, g, watermark = appid, options = {}) {
    return resolvePayload({ opengid: groupOpenId, group_openid: `member-${uid}`, chat_type: 3 }, uid, g, watermark, options, groupOpenId);
  }
  async function resolvePayload(payload, uid = 1, g, watermark = appid, options = {}, expectedId = payload.opengid || payload.openGId || payload.groupOpenId || '') {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plain = JSON.stringify({ ...payload, ...(watermark === null ? {} : { watermark: { appid: watermark } }) });
    const data = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(plain));
    const ref = Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(expectedId))).toString('hex');
    return request('/api/groups/resolve', { encrypted_data: Buffer.from(data).toString('base64'), iv: Buffer.from(iv).toString('base64'), g,
      confirm: true, expected_group_ref: ref, ...options }, uid);
  }
  return { db, request, resolve, resolvePayload, env };
}

test('官方 opengid 可预览并确认，同群不同用户的 group_openid 不拆榜', async t => {
  const f = fixture(t);
  const preview = await f.resolve('official-group', 1, undefined, undefined, { confirm: false });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.exists, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 0);
  const a = await f.resolve('official-group', 1, undefined, undefined, { expected_group_ref: preview.data.group_ref });
  const b = await f.resolve('official-group', 2);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.id, b.data.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 1);
});

test('新参榜用户缺头像或昵称只能预览，保存两项后才能确认建榜或入群', async t => {
  const f = fixture(t);
  for (const [nickname, avatar] of [[null, null], ['只有昵称', null], [' ', 'saved.png'], [null, 'saved.png']]) {
    f.db.prepare('UPDATE users SET nickname=?,avatar_path=? WHERE id=1').run(nickname, avatar);
    assert.equal((await f.resolve('profile-gate', 1, undefined, undefined, { confirm: false })).status, 200);
    const denied = await f.resolve('profile-gate');
    assert.equal(denied.status, 428); assert.equal(denied.data.code, 'PROFILE_REQUIRED');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 0);
    assert.equal((await f.request('/api/me')).data.profile_complete, false);
  }
  const forged = await f.request('/api/profile', { nickname: '已填昵称', avatar_url: 'https://fake/avatar.png' });
  assert.equal(forged.data.profile_complete, true); // Existing saved avatar is retained; URL input is ignored.
  f.db.prepare('UPDATE users SET avatar_path=NULL WHERE id=1').run();
  assert.equal((await f.request('/api/profile', { nickname: '已填昵称', avatar_url: 'https://fake/avatar.png' })).data.profile_complete, false);
  assert.equal((await f.resolve('profile-gate')).status, 428);
  assert.equal((await uploadAvatar(f)).status, 200);
  const joined = await f.resolve('profile-gate'); assert.equal(joined.status, 200);
  assert.equal((await f.request('/api/me')).data.profile_complete, true);
  f.db.prepare('UPDATE users SET avatar_path=NULL WHERE id=2').run();
  assert.equal((await f.resolve('profile-gate', 2)).status, 428);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_group_members').get().n, 1);
});

test('已加入但资料缺失的成员仍上榜；补资料引导保留，群榜与个人群名次一致', async t => {
  const f = fixture(t), g = (await f.resolve('existing-profile')).data;
  await f.resolve('existing-profile', 2);
  seedUsage(f, 1, 0, 100); seedUsage(f, 2, 0, 900);
  f.db.prepare('UPDATE users SET nickname=NULL WHERE id=2').run();
  const path = `/api/leaderboard?scope=group&id=${g.id}`;
  assert.equal((await f.request(path, null, 2)).status, 428);
  const board = (await f.request(path)).data;
  assert.equal(board.total, 2); assert.equal(board.members, 2); assert.equal(board.me.rank, 2);
  assert.equal(board.entries[0].nickname, 'AI玩家-0002');
  assert.equal((await f.request('/api/my/rankings')).data.groups[0].my_rank, 2);
  const mine = (await f.request('/api/my/rankings', null, 2)).data.groups[0];
  assert.equal(mine.my_rank, 1); assert.equal(mine.profile_required, true); assert.equal(mine.my_tokens, 900);
  assert.equal((await f.request('/api/my/usage', null, 2)).data.summary.tokens, 900);
  await f.request('/api/profile', { nickname: '微信昵称' }, 2);
  const restored = (await f.request(path, null, 2)).data;
  assert.equal(restored.total, 2); assert.equal(restored.me.rank, 1);
  assert.equal((await f.request('/api/my/rankings')).data.groups[0].my_rank, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_totals').get().n, 2);
});

test('缺头像或昵称不影响各周期群排名，群外用户仍不展示，补齐资料不改变名次', async t => {
  const f = fixture(t), g = (await f.resolve('profile-independent-rank')).data;
  await f.resolve('profile-independent-rank', 2);
  seedUsage(f, 1, 0, 100); seedUsage(f, 2, 0, 900); seedUsage(f, 3, 0, 1000);
  f.db.prepare('UPDATE daily_totals SET updated_at=? WHERE user_id=2').run(Date.now() + 1000);
  const latest = f.db.prepare('SELECT updated_at FROM daily_totals WHERE user_id=2').get().updated_at;
  for (const [nickname, avatar] of [['有昵称', null], [null, null], [null, 'saved.png'], ['完整资料', 'saved.png']]) {
    f.db.prepare('UPDATE users SET nickname=?,avatar_path=? WHERE id=2').run(nickname, avatar);
    for (const period of ['day', 'week', 'month', 'all']) {
      const board = (await f.request(`/api/leaderboard?scope=group&id=${g.id}&period=${period}`)).data;
      assert.equal(board.total, 2); assert.equal(board.me.rank, 2); assert.equal(board.updated_at, latest);
      assert.deepEqual(board.entries.map(e => e.tokens), [900, 100]);
      assert.equal(board.entries[0].nickname, nickname || 'AI玩家-0002');
      assert.equal(board.entries[0].avatar_url, avatar ? `https://rank.test/avatars/${avatar}` : null);
      assert.equal(board.entries[0].global_rank, 2);
      const mine = (await f.request(`/api/my/rankings?period=${period}`, null, 2)).data.groups[0];
      assert.equal(mine.my_rank, 1); assert.equal(mine.updated_at, latest);
    }
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_totals').get().n, 3);
});

test('旧群字段与官方 opengid 共用同一榜；拒绝个人群内标识、单聊和冲突字段', async t => {
  const f = fixture(t);
  const original = await f.resolve('compatible-group');
  for (const field of ['openGId', 'groupOpenId']) {
    const old = await f.resolvePayload({ [field]: 'compatible-group' }, 2);
    assert.equal(old.status, 200); assert.equal(old.data.id, original.data.id);
  }
  for (const payload of [
    { group_openid: 'member-not-group' },
    { opengid: '', open_single_roomid: 'private-room', group_openid: 'private-member' },
    { opengid: 'a', openGId: 'b' },
    { opengid: ' ' },
  ]) assert.equal((await f.resolvePayload(payload)).status, 400);
  const single = await f.resolvePayload({ open_single_roomid: 'private-room', chat_type: 1 });
  assert.equal(single.status, 400); assert.match(JSON.stringify(single.data), /群榜需要在微信群里打开/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 1);
});

test('A 群卡片转发至新 B 群：创建 B 群，不能把 B 用户加入 A 群', async t => {
  const f = fixture(t);
  const a = (await f.resolve('wechat-a', 1)).data;
  const b = (await f.resolve('wechat-b', 2, a.id)).data;
  assert.notEqual(a.id, b.id);
  assert.equal(b.created, true);
  assert.deepEqual(f.db.prepare('SELECT group_id FROM rank_group_members WHERE user_id=2').all().map(r => r.group_id), [b.id]);
});

test('已有 B 群优先按真实身份解析，重复进入不增加榜单或成员', async t => {
  const f = fixture(t);
  const a = (await f.resolve('wechat-a')).data;
  const b = (await f.resolve('wechat-b', 2)).data;
  assert.equal((await f.resolve('wechat-b', 3, a.id)).data.id, b.id);
  await f.resolve('wechat-b', 3, a.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_groups').get().n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_group_members WHERE group_id=?').get(b.id).n, 2);
});

test('并发首次进入同一微信群只创建一张榜，两人均入群', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.resolve('new-group', 1), f.resolve('new-group', 2)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.data.id, b.data.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_groups').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_group_members').get().n, 2);
});

test('不把未绑定的历史手动群锚定到任意转发目的群', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO rank_groups(id,name,owner_user_id,created_at) VALUES(?,?,?,?)').run('oldgroup', '旧群', 1, Date.now());
  const result = await f.resolve('new-group', 2, 'oldgroup');
  assert.notEqual(result.data.id, 'oldgroup');
  assert.equal(f.db.prepare('SELECT group_openid_hash FROM rank_groups WHERE id=?').get('oldgroup').group_openid_hash, null);
});

test('伪造应用水印、错误密文和未登录请求均不能建立群关系', async t => {
  const f = fixture(t);
  assert.equal((await f.resolve('x', 1, undefined, 'other-app')).status, 400);
  assert.equal((await f.resolvePayload({ openGId: 'x' }, 1, undefined, null)).status, 400);
  assert.equal((await f.resolvePayload({ opengid: 'x', watermark: null }, 1, undefined, null)).status, 400);
  assert.equal((await f.resolvePayload({ opengid: 'x', watermark: {} }, 1, undefined, null)).status, 400);
  assert.equal((await f.request('/api/groups/resolve', { encrypted_data: 'invalid', iv: 'invalid' })).status, 400);
  assert.equal((await f.request('/api/groups/resolve', {}, 0)).status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_groups').get().n, 0);
});

test('官方群接口无 watermark 的 opengid 可预览并确认，自分享者不依赖第二人建榜', async t => {
  const f = fixture(t);
  const preview = await f.resolve('self-shared', 1, undefined, null, { confirm: false });
  assert.equal(preview.status, 200); assert.equal(preview.data.exists, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 0);
  const joined = await f.resolve('self-shared', 1, undefined, null, { expected_group_ref: preview.data.group_ref });
  assert.equal(joined.status, 200); assert.equal(joined.data.created, true);
  const mine = await f.request('/api/groups/mine');
  assert.equal(mine.data.groups.length, 1); assert.equal(mine.data.groups[0].id, joined.data.id);
  const other = await f.resolve('self-shared', 2, undefined, null);
  assert.equal(other.status, 200); assert.equal(other.data.id, joined.data.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 1);
});

test('缺水印的官方格式仍须由当前用户会话密钥解密，明文和别人的密文不建榜', async t => {
  const f = fixture(t);
  const differentKey = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  f.db.prepare('UPDATE users SET session_key=? WHERE id=2').run(differentKey);
  assert.equal((await f.resolve('wrong-user-key', 2, undefined, null)).status, 400);
  const plain = Buffer.from(JSON.stringify({ opengid: 'forged-group' })).toString('base64');
  assert.equal((await f.request('/api/groups/resolve', { encrypted_data: plain, iv: Buffer.alloc(16).toString('base64') })).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 0);
});

test('识别新群或已有群只预览，未明确确认不创建榜单也不加入成员',async t=>{
  const f=fixture(t);
  const preview=(await f.resolve('new',1,undefined,undefined,{confirm:false})).data;
  assert.equal(preview.exists,false);assert.equal(preview.joined,false);assert.equal(preview.id,'');
  assert.match(preview.group_ref,/^[0-9a-f]{64}$/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n,0);
  const joined=(await f.resolve('new')).data;
  for(const confirm of [false,undefined,'true',1]) {
    const next=await f.resolve('new',2,undefined,undefined,{confirm});
    assert.equal(next.status,200);assert.equal(next.data.id,joined.id);assert.equal(next.data.joined,false);
    assert.equal(next.data.members,1);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_group_members').get().n,1);
  assert.equal((await f.resolve('new',1,undefined,undefined,{confirm:false})).data.joined,true);
});

test('确认时群身份改变或缺少预览绑定，不能加入任何群',async t=>{
  const f=fixture(t);
  const preview=(await f.resolve('a',1,undefined,undefined,{confirm:false})).data;
  assert.equal((await f.resolve('b',1,undefined,undefined,{expected_group_ref:preview.group_ref})).status,409);
  assert.equal((await f.resolve('a',1,undefined,undefined,{expected_group_ref:undefined})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_group_members').get().n,0);
});

test('数据库唯一约束阻止第二张同群榜，改榜名不影响群身份',async t=>{
  const f=fixture(t);const a=(await f.resolve('same')).data;
  const row=f.db.prepare('SELECT * FROM rank_groups WHERE id=?').get(a.id);
  assert.throws(()=>f.db.prepare('INSERT INTO rank_groups(id,name,owner_user_id,created_at,group_openid_hash) VALUES(?,?,?,?,?)').run('duplicate','重复榜',2,Date.now(),row.group_openid_hash),/UNIQUE/);
  assert.equal((await f.request(`/api/groups/${a.id}/rename`,{name:'新榜名'})).status,200);
  const b=(await f.resolve('same',2)).data;
  assert.equal(b.id,a.id);assert.equal(b.name,'新榜名');
});

test('知道群 ID 不能绕过真实群验证入群；已入群用户可幂等确认', async t => {
  const f = fixture(t);
  const a = (await f.resolve('wechat-a')).data;
  assert.equal((await f.request('/api/groups/join', { id: a.id }, 2)).status, 403);
  assert.equal((await f.request('/api/groups/join', { id: a.id }, 1)).status, 200);
  assert.equal((await f.request('/api/groups', { name: '手动创建' }, 2)).status, 409);
  assert.equal((await f.request(`/api/leaderboard?scope=group&id=${a.id}`,null,0)).status,401);
  assert.equal((await f.request(`/api/leaderboard?scope=group&id=${a.id}`,null,2)).status,403);
  assert.equal((await f.request(`/api/leaderboard?scope=group&id=${a.id}`,null,1)).status,200);
});

test('同分时列表、个人、群内和全站排名保持一致', async t => {
  const f = fixture(t);
  const group = (await f.resolve('rank-group')).data;
  await f.resolve('rank-group', 2);
  const day = beijingDay();
  for (const uid of [1, 2]) seedDay(f, uid, day, {tokens:200,requests:1});
  const global = (await f.request('/api/leaderboard?period=day', null, 2)).data;
  const local = (await f.request(`/api/leaderboard?scope=group&id=${group.id}&period=day`, null, 2)).data;
  const mine = (await f.request('/api/my/rankings?period=day', null, 2)).data;
  assert.equal(global.entries[1].rank, 2);
  assert.equal(global.me.rank, 2);
  assert.equal(local.me.rank, 2);
  assert.equal(local.me.global_rank, 2);
  assert.equal(mine.groups[0].my_rank, 2);
  assert.equal(mine.global.rank, 2);
});

test('多个群并行查询仍按创建时间排序，保留各群不同排名且不包含未加入群', async t => {
  const f = fixture(t);
  seedDay(f, 1, beijingDay(), { tokens: 200, requests: 1 });
  seedDay(f, 2, beijingDay(), { tokens: 100, requests: 1 });
  for (let i = 0; i < 8; i++) {
    f.db.prepare('INSERT INTO rank_groups(id,name,owner_user_id,created_at) VALUES(?,?,?,?)').run(`many-${i}`, `群${i}`, 1, 100 + i);
    if (i < 7) f.db.prepare('INSERT INTO rank_group_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(`many-${i}`, 2, 100);
    if (i % 2 === 0 || i === 7) f.db.prepare('INSERT INTO rank_group_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(`many-${i}`, 1, 100);
  }
  const result = await f.request('/api/my/rankings?period=day', null, 2);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.groups.map(g => g.id), [6, 5, 4, 3, 2, 1, 0].map(i => `many-${i}`));
  for (const g of result.data.groups) {
    assert.equal(g.my_rank, Number(g.id.slice(-1)) % 2 === 0 ? 2 : 1);
    assert.equal(g.global_rank, 2); assert.equal(g.my_tokens, 100);
  }
});

test('个人用量无须入群；仅返回本人，不能通过 user_id 查询其他人', async t => {
  const f = fixture(t);
  const day = beijingDay();
  seedDay(f,1,day,{tokens:12345,requests:7,cache_read:900,cache_write:100,models:[['model-a',12345]]});
  seedDay(f,2,day,{tokens:99999,requests:20});
  const result = await f.request('/api/my/usage?period=day&user_id=2');
  assert.equal(result.status, 200); assert.equal(result.data.summary.tokens, 12345);
  assert.equal(result.data.summary.requests, 7); assert.equal(result.data.summary.cache_read, 900);
  assert.equal(result.data.models[0].name, 'model-a'); assert.equal(result.data.tools[0].name, 'Codex');
  assert.equal(result.data.has_history, true); assert.equal(result.data.first_day, day);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_group_members').get().n, 0);
  assert.equal((await f.request('/api/my/usage', null, 0)).status, 401);
  const empty = await f.request('/api/my/usage?period=all', null, 3);
  assert.equal(empty.data.has_history, false); assert.equal(empty.data.summary.tokens, 0);
  assert.equal(empty.data.daily.length, 30); assert.deepEqual(empty.data.models, []);
});

test('今日无用量也能看到已同步历史，今日趋势包含此前数据', async t => {
  const f = fixture(t);
  const yesterday = beijingDay(Date.now() - 86400000);
  const older = beijingDay(Date.now() - 40 * 86400000);
  for (const day of [yesterday, older]) seedDay(f,1,day,{tokens:100,requests:2});
  const today = (await f.request('/api/my/usage?period=day')).data;
  assert.equal(today.summary.tokens, 0); assert.equal(today.has_history, true);
  assert.equal(today.lifetime_tokens, 200); assert.equal(today.daily[5].tokens, 100);
  const all = (await f.request('/api/my/usage?period=all')).data;
  assert.equal(all.summary.tokens, 200); assert.equal(all.summary.active_days, 2);
  assert.equal(all.from, older); assert.equal(all.daily.length, 30);
});

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=', 'base64');
async function uploadAvatar(f, {nickname='微信昵称', image=tinyPng, type='image/png', uid=1}={}) {
  const form = new FormData();form.set('nickname',nickname);form.set('avatar',new Blob([image],{type}),'avatar.png');
  const encoded = new Response(form);
  return worker.fetch(new Request('https://rank.test/api/profile',{method:'POST',headers:{'content-type':encoded.headers.get('content-type'),...(uid?{authorization:`Bearer session-${uid}`}:{})},body:await encoded.arrayBuffer()}),f.env);
}

test('微信头像上传后持久化，公开域名读回，昵称单独修改保留头像',async t=>{
  const f=fixture(t);f.env.PUBLIC_BASE_URL='https://public.test';
  f.db.prepare('UPDATE users SET avatar_path=NULL WHERE id=2').run();
  const res=await uploadAvatar(f);assert.equal(res.status,200);const user=await res.json();
  assert.equal(user.nickname,'微信昵称');assert.match(user.avatar_url,/^https:\/\/public.test\/avatars\/.*\.png$/);
  const image=await worker.fetch(new Request(user.avatar_url),f.env);
  assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),tinyPng);
  const saved=await f.request('/api/profile',{nickname:'新昵称'});assert.equal(saved.data.avatar_url,user.avatar_url);
  assert.equal((await f.request('/api/me')).data.avatar_url,user.avatar_url);
  const another=await uploadAvatar(f,{nickname:'再换一次'});const next=await another.json();
  assert.notEqual(next.avatar_url,user.avatar_url);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM user_avatars').get().n,1);
  assert.equal((await worker.fetch(new Request(user.avatar_url),f.env)).status,404);
  assert.equal((await f.request('/api/me',null,2)).data.avatar_url,null);
});

test('无会话、非图片、超限头像和非法昵称不改变已有资料',async t=>{
  const f=fixture(t);await uploadAvatar(f);const before=f.db.prepare('SELECT nickname,avatar_path FROM users WHERE id=1').get();
  for(const options of [{uid:0},{image:Buffer.from('<svg onload="alert(1)"/>'),type:'image/png'},{image:Buffer.alloc(300*1024)},{nickname:''}]){
    assert.ok((await uploadAvatar(f,options)).status>=400);
    assert.deepEqual(f.db.prepare('SELECT nickname,avatar_path FROM users WHERE id=1').get(),before);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM user_avatars').get().n,1);
});

function seedDay(f,uid,day,{tokens=100,requests=1,cache_read=0,cache_write=0,models=[['private-model',tokens]]}={}) {
  f.db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,source_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(uid,'test-device',day,tokens,0,0,cache_read,cache_write,requests,JSON.stringify(models),JSON.stringify([['Codex',tokens]]),Date.now(),Date.now());
  f.db.prepare('INSERT OR REPLACE INTO usage_sync_state VALUES(?,?,?,?)').run(uid,'test-device',Date.now(),Date.now());
}
function seedUsage(f, uid, offset, tokens = 100, requests = 1) {
  const day=beijingDay(Date.now()+offset*86400000);seedDay(f,uid,day,{tokens,requests});return day;
}

async function largeGroup(t) {
  const f = fixture(t), group = (await f.resolve('large-group')).data;
  const now = Date.now();
  for (let id = 1; id <= 139; id++) {
    if (id > 3) f.db.prepare('INSERT INTO users(id,openid,created_at,updated_at) VALUES(?,?,?,?)').run(id, `user-${id}`, now, now);
    f.db.prepare('UPDATE users SET nickname=? WHERE id=?').run(`成员${id}`, id);
    f.db.prepare('UPDATE users SET avatar_path=? WHERE id=?').run(`00000000-0000-0000-0000-${String(id).padStart(12,'0')}.png`, id);
    if (id > 1 && id <= 138) f.db.prepare('INSERT INTO rank_group_members(group_id,user_id,joined_at) VALUES(?,?,?)').run(group.id, id, now);
    if (id <= 123 || id === 139) seedUsage(f, id, 0, id === 1 ? 1 : id === 139 ? 999 : 100);
  }
  seedUsage(f, 124, -1, 200);
  return { ...f, group, path: `/api/leaderboard?scope=group&id=${group.id}&period=day` };
}

test('群榜 123 人按 50/50/23 分页，同分不漏不重；已加入人数与上榜人数分开', async t => {
  const f = await largeGroup(t);
  // Existing members without avatars must remain on every page, including after #50.
  f.db.exec('UPDATE users SET avatar_path=NULL WHERE id>1');
  let url = f.path, all = [], pages = [], snapshot;
  do {
    const res = await f.request(url); assert.equal(res.status, 200);
    const data = res.data; pages.push(data.entries.length); all.push(...data.entries);
    assert.equal(data.total, 123); assert.equal(data.members, 138); assert.equal(data.me.rank, 123);
    assert.equal(data.me.global_rank, 124);
    if (snapshot) assert.equal(data.snapshot, snapshot); else snapshot = data.snapshot;
    assert.doesNotMatch(JSON.stringify(data), /"(?:uid|user_id|openid|session_key)"/);
    url = data.has_more ? `${f.path}&offset=${data.next_offset}&snapshot=${data.snapshot}` : null;
    if (!url) assert.equal(data.next_offset, null);
  } while (url);
  assert.deepEqual(pages, [50, 50, 23]);
  assert.deepEqual(all.map(e => e.rank), Array.from({ length: 123 }, (_, i) => i + 1));
  assert.deepEqual(all.map(e => e.nickname), [...Array.from({ length: 122 }, (_, i) => `成员${i + 2}`), '成员1']);
  assert.equal((await f.request('/api/leaderboard')).data.entries.length, 50);
  assert.equal((await f.request(f.path.replace('period=day', 'period=week'))).data.total, 124);
});

test('空群榜和恰好 50 人都没有多余续页，零用量成员仍计入已加入人数', async t => {
  const f = await largeGroup(t);
  f.db.exec('DELETE FROM daily_totals WHERE user_id>50');
  let data = (await f.request(f.path)).data;
  assert.equal(data.entries.length, 50); assert.equal(data.total, 50); assert.equal(data.has_more, false); assert.equal(data.next_offset, null);
  f.db.exec('UPDATE daily_totals SET tokens=0');
  data = (await f.request(f.path)).data;
  assert.deepEqual(data.entries, []); assert.equal(data.total, 0); assert.equal(data.members, 138);
  assert.equal(data.has_more, false); assert.equal(data.me, null);
});

test('续页须验证会话与群成员；非法参数、跨周期快照与排名变化不能混页', async t => {
  const f = await largeGroup(t);
  const first = (await f.request(f.path)).data;
  const next = `${f.path}&offset=50&snapshot=${first.snapshot}`;
  for (const suffix of ['offset=-1', 'offset=1.5', 'offset=50', 'offset=50&snapshot=invalid'])
    assert.equal((await f.request(`${f.path}&${suffix}`)).status, 400);
  assert.equal((await f.request(next, null, 0)).status, 401);
  assert.equal((await f.request(next.replace('period=day', 'period=week'))).status, 409);
  f.db.prepare('UPDATE daily_totals SET tokens=200 WHERE user_id=2').run();
  assert.equal((await f.request(next)).status, 409);
  const refreshed = (await f.request(f.path)).data;
  assert.notEqual(refreshed.snapshot, first.snapshot);
  assert.equal((await f.request(`${f.path}&offset=50&snapshot=${refreshed.snapshot}`)).status, 200);
  f.db.prepare('DELETE FROM rank_group_members WHERE group_id=? AND user_id=138').run(f.group.id);
  assert.equal((await f.request(`${f.path}&offset=50&snapshot=${refreshed.snapshot}`)).status, 409);
  f.db.prepare('DELETE FROM rank_group_members WHERE group_id=? AND user_id=1').run(f.group.id);
  assert.equal((await f.request(next)).status, 403);
});

test('分享名次遵守所选周期及同分顺序；历史活动跨周期且排除空白日', async t => {
  const f = fixture(t);
  for (const uid of [1, 2]) seedUsage(f, uid, 0, 200);
  seedUsage(f, 3, -1, 1000); seedUsage(f, 1, -1, 0, 2); seedUsage(f, 1, -2, 0, 0);
  const day = (await f.request('/api/my/usage?period=day', null, 2)).data;
  assert.deepEqual(day.standing, { rank: 2, participants: 2, hidden: false });
  const week = (await f.request('/api/my/usage?period=week', null, 2)).data;
  assert.deepEqual(week.standing, { rank: 3, participants: 3, hidden: false });
  const zero = (await f.request('/api/my/usage?period=day', null, 3)).data;
  assert.deepEqual(zero.standing, { rank: null, participants: 2, hidden: false });
  const activity = (await f.request('/api/my/usage?period=day')).data.activity;
  assert.equal(activity.active_days, 2); assert.equal(activity.current_streak, 2);
});

test('分享摘要由服务端生成，不接受客户端伪造数据，公开内容只含卡片白名单', async t => {
  const f = fixture(t); seedUsage(f, 1, 0, 12800);
  f.db.prepare('UPDATE users SET nickname=? WHERE id=1').run('原昵称');
  assert.equal((await f.request('/api/shares', { period: 'day' }, 0)).status, 401);
  assert.equal((await f.request('/api/shares', { period: 'day' }, 3)).status, 400);
  const shared = await f.request('/api/shares', { period:'day', user_id:2, summary:{tokens:999999}, nickname:'伪造' });
  assert.equal(shared.status, 200); assert.match(shared.data.id, /^[0-9a-f]{24}$/);
  assert.equal(shared.data.usage.summary.tokens, 12800); assert.equal(shared.data.user.nickname, '原昵称');
  assert.equal(shared.data.expires_at - shared.data.created_at, 90 * 86400000);
  assert.deepEqual(Object.keys(shared.data.user).sort(), ['avatar_url','nickname']);
  assert.deepEqual(Object.keys(shared.data.usage).sort(), ['activity','from','period','standing','summary','timezone','to','token_basis','tools']);
  assert.doesNotMatch(JSON.stringify(shared.data), /private-model|openid|session|connect_token|user_id/);
  const publicView = await f.request('/api/shares/' + shared.data.id, null, 0);
  assert.deepEqual(publicView.data, shared.data);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rank_group_members').get().n, 0);
});

test('分享去重复用同一摘要；后续同步、改名和榜单变化不改变已分享的记录', async t => {
  const f = fixture(t); seedUsage(f, 1, 0, 200);
  const [a, b] = await Promise.all([f.request('/api/shares', {period:'day'}), f.request('/api/shares', {period:'day'})]);
  assert.equal(a.data.id, b.data.id); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_shares').get().n, 1);
  f.db.prepare('UPDATE daily_totals SET tokens=300 WHERE user_id=1').run();
  f.db.prepare('UPDATE users SET nickname=? WHERE id=1').run('新昵称'); seedUsage(f, 2, 0, 900);
  assert.deepEqual((await f.request('/api/shares/' + a.data.id, null, 0)).data, a.data);
  const next = (await f.request('/api/shares', {period:'day'})).data;
  assert.notEqual(next.id, a.data.id); assert.equal(next.usage.summary.tokens, 300);
  assert.equal(next.usage.standing.rank, 2); assert.equal(next.user.nickname, '新昵称');
});

test('只有本人能停用分享；过期或停用后摘要和小程序码都不可获取，再生成使用新入口', async t => {
  const f = fixture(t); seedUsage(f, 1, 0);
  const a = (await f.request('/api/shares', {period:'day'})).data;
  assert.equal((await f.request(`/api/shares/${a.id}/revoke`, {}, 2)).status, 404);
  assert.equal((await f.request(`/api/shares/${a.id}/revoke`, {}, 0)).status, 401);
  assert.equal((await f.request(`/api/shares/${a.id}`, null, 0)).status, 200);
  assert.equal((await f.request(`/api/shares/${a.id}/revoke`, {})).status, 200);
  assert.equal((await f.request(`/api/shares/${a.id}`, null, 0)).status, 404);
  assert.equal((await f.request(`/api/wx/share-code?share=${a.id}`, null, 0)).status, 404);
  const b = (await f.request('/api/shares', {period:'day'})).data;
  assert.notEqual(a.id, b.id);
  f.db.prepare('UPDATE usage_shares SET expires_at=? WHERE id=?').run(Date.now()-1, b.id);
  assert.equal((await f.request(`/api/shares/${b.id}`, null, 0)).status, 404);
  assert.equal((await f.request(`/api/wx/share-code?share=${b.id}`, null, 0)).status, 404);
  assert.equal((await f.request('/api/shares/1', null, 0)).status, 404);
});

function reportClient(f) {
  const token='a'.repeat(32);
  f.db.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES(?,?,?)').run(token,1,Date.now());
  return async body => {
    const response=await worker.fetch(new Request('https://rank.test/report',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),f.env);
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
}
const totalReport=(tokens=258000000,extra={})=>({v:2,device_id:'test-device',timezone:'Asia/Shanghai',token_basis:'upstream_total',source_at:Date.now(),full:true,complete:true,
  days:[{day:beijingDay(),tokens,input_tokens:1000000,output_tokens:2000000,cache_read:250000000,cache_write:5000000,requests:2,models:[['model',tokens]],tools:[['Codex',tokens]]}],...extra});
test('原版总量从上报到个人页、排名、分享保持一致，缓存不重复加算',async t=>{
  const f=fixture(t),send=reportClient(f);
  assert.equal((await send(totalReport())).status,200);
  const mine=(await f.request('/api/my/usage')).data;
  assert.equal(mine.summary.tokens,258000000);assert.equal(mine.summary.input_tokens,1000000);assert.equal(mine.summary.output_tokens,2000000);
  assert.equal(mine.timezone,'Asia/Shanghai');assert.equal(mine.token_basis,'upstream_total');
  assert.equal(mine.tools[0].percent,100);
  assert.equal((await f.request('/api/leaderboard')).data.entries[0].tokens,258000000);
  const share=(await f.request('/api/shares',{period:'day'})).data;
  assert.equal(share.usage.summary.tokens,258000000);assert.equal(share.usage.token_basis,'upstream_total');
});
test('新快照允许历史下调，重复上报不累加，过期快照与 v1 被拒绝',async t=>{
  const f=fixture(t),send=reportClient(f);const stamp=Date.now()-1000;
  assert.equal((await send(totalReport(100,{source_at:stamp}))).status,200);
  const limited=await send(totalReport(20));assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
  f.db.exec('UPDATE connect_tokens SET last_report_at=0');assert.equal((await send(totalReport(20,{source_at:stamp+1,full:false}))).status,200);
  f.db.exec('UPDATE connect_tokens SET last_report_at=0');assert.equal((await send(totalReport(20,{source_at:stamp+1,full:false}))).status,200);
  assert.equal(f.db.prepare('SELECT tokens FROM ranked_usage').get().tokens,20);
  f.db.exec('UPDATE connect_tokens SET last_report_at=0');assert.equal((await send(totalReport(999,{source_at:stamp}))).status,409);
  assert.equal((await send({v:1,days:[]})).status,426);
  assert.equal(f.db.prepare('SELECT tokens FROM ranked_usage').get().tokens,20);
});
test('初次历史分批结束前不入榜，旧 UTC 口径不混入，切换电脑须完整同步',async t=>{
  const f=fixture(t),send=reportClient(f);
  f.db.prepare('INSERT INTO daily_stats(user_id,day,tokens,updated_at) VALUES(?,?,?,?)').run(1,beijingDay(),999,Date.now());
  assert.equal((await f.request('/api/my/usage')).status,409);
  assert.equal((await send(totalReport(100,{complete:false}))).status,200);
  assert.equal((await f.request('/api/leaderboard')).data.entries.length,0);
  f.db.exec('UPDATE connect_tokens SET last_report_at=0');assert.equal((await send(totalReport(100))).status,200);
  assert.equal((await f.request('/api/my/usage')).data.summary.tokens,100);
  assert.equal(f.db.prepare('SELECT tokens FROM daily_stats').get().tokens,999);
  f.db.exec('UPDATE connect_tokens SET last_report_at=0');assert.equal((await send(totalReport(500,{device_id:'other',full:false}))).status,409);
  assert.equal((await send(totalReport(500,{device_id:'other'}))).status,200);
  assert.equal((await f.request('/api/my/usage')).data.summary.tokens,500);
});
test('不截断不合法总量、日期或分类；整批拒绝，不写入部分数据',async t=>{
  const f=fixture(t),send=reportClient(f);
  for(const change of [{tokens:1.1},{tokens:1e13+1},{day:'2026-02-30'},{tools:[['Codex',258000001]]}]){
    const body=totalReport();Object.assign(body.days[0],change);assert.equal((await send(body)).status,400);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM daily_totals').get().n,0);
});

test('群名最多 100 字（按字符计），昵称仍限 16 字', async t => {
  const f = fixture(t); const a = (await f.resolve('long-name')).data;
  const long = '群'.repeat(99) + '😀';
  const ok = await f.request(`/api/groups/${a.id}/rename`, { name: long });
  assert.equal(ok.status, 200); assert.equal(f.db.prepare('SELECT name FROM rank_groups WHERE id=?').get(a.id).name, long);
  assert.equal((await f.request(`/api/groups/${a.id}/rename`, { name: '群'.repeat(101) })).status, 400);
  assert.equal((await f.request(`/api/groups/${a.id}/rename`, { name: '群名 https://x.cn' })).status, 400);
  const { sanitizeName, sanitizeGroupName } = await import('../src/lib.js');
  assert.equal(sanitizeName('昵'.repeat(17)), null); assert.equal(sanitizeGroupName('昵'.repeat(17)), '昵'.repeat(17));
});

test('建榜时可顺带起名；名称不合规时不建榜；已有榜时忽略传入的名称', async t => {
  const f = fixture(t);
  assert.equal((await f.resolve('named-new', 1, undefined, undefined, { name: '看 https://x.cn' })).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n, 0);
  const created = await f.resolve('named-new', 1, undefined, undefined, { name: '  Vibe Coding 交流群 ' });
  assert.equal(created.status, 200); assert.equal(created.data.name, 'Vibe Coding 交流群');
  const other = await f.resolve('named-new', 2, undefined, undefined, { name: '被覆盖的名字' });
  assert.equal(other.data.name, 'Vibe Coding 交流群');
  const blank = await f.resolve('blank-new', 1, undefined, undefined, { name: '   ' });
  assert.equal(blank.data.name, '本群 Token 排名');
});

test('默认名时任何成员可起一次名；起名后只有发起者能改；非成员不能改', async t => {
  const f = fixture(t); const g = (await f.resolve('claimable', 1)).data; await f.resolve('claimable', 2);
  let info = await f.request(`/api/groups/${g.id}`, null, 2);
  assert.equal(info.data.named, false); assert.equal(info.data.can_rename, true);
  assert.equal((await f.request(`/api/groups/${g.id}/rename`, { name: '外人起名' }, 3)).status, 403);
  assert.equal((await f.request(`/api/groups/${g.id}/rename`, { name: '成员起的名' }, 2)).status, 200);
  info = await f.request(`/api/groups/${g.id}`, null, 2);
  assert.equal(info.data.named, true); assert.equal(info.data.can_rename, false);
  assert.equal((await f.request(`/api/groups/${g.id}/rename`, { name: '再改一次' }, 2)).status, 403);
  assert.equal((await f.request(`/api/groups/${g.id}`, null, 1)).data.can_rename, true);
  assert.equal((await f.request(`/api/groups/${g.id}/rename`, { name: '发起者改名' }, 1)).status, 200);
  assert.equal(f.db.prepare('SELECT name FROM rank_groups WHERE id=?').get(g.id).name, '发起者改名');
});

test('广场榜同样每页 50 人续页，匿名可看；排名变化时续页返回 409', async t => {
  const f = await largeGroup(t);
  const path = '/api/leaderboard?scope=global&period=day';
  let url = path, all = [], pages = [];
  do {
    const res = await f.request(url, null, 0); assert.equal(res.status, 200);
    const data = res.data; pages.push(data.entries.length); all.push(...data.entries);
    assert.equal(data.total, 124); assert.equal(data.members, undefined);
    url = data.has_more ? `${path}&offset=${data.next_offset}&snapshot=${data.snapshot}` : null;
  } while (url);
  assert.deepEqual(pages, [50, 50, 24]);
  assert.deepEqual(all.map(e => e.rank), Array.from({ length: 124 }, (_, i) => i + 1));
  const first = (await f.request(path, null, 0)).data;
  f.db.prepare('UPDATE daily_totals SET tokens=5000 WHERE user_id=5').run();
  assert.equal((await f.request(`${path}&offset=50&snapshot=${first.snapshot}`, null, 0)).status, 409);
  assert.equal((await f.request(`${path}&offset=50`, null, 0)).status, 400);
});

test('后台停用的账号不出现在任何榜单，上传被拒；恢复后重新上榜', async t => {
  const f = await largeGroup(t);
  const global = '/api/leaderboard?scope=global&period=day';
  const before = (await f.request(global, null, 0)).data;
  assert.equal(before.entries[0].nickname, '成员139'); assert.equal(before.total, 124);
  f.db.prepare('UPDATE users SET disabled_at=?, disabled_reason=? WHERE id=139').run(Date.now(), '伪造上报');
  const after = (await f.request(global, null, 0)).data;
  assert.equal(after.total, 123); assert.ok(after.entries.every(e => e.nickname !== '成员139'));
  const group = (await f.request(f.path)).data;
  assert.ok(group.entries.every(e => e.nickname !== '成员139'));
  f.db.prepare("INSERT OR REPLACE INTO connect_tokens(token,user_id,created_at) VALUES('b'||hex(randomblob(15)),139,0)").run();
  const tok = f.db.prepare('SELECT token FROM connect_tokens WHERE user_id=139').get().token;
  const res = await worker.fetch(new Request('https://rank.test/report', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}' }), f.env);
  assert.equal(res.status, 403);
  f.db.prepare('UPDATE users SET disabled_at=NULL WHERE id=139').run();
  assert.equal((await f.request(global, null, 0)).data.total, 124);
});

test('关闭排名：自己仍能看到全部用量，广场榜和群榜都不显示，名次为空；恢复后重新上榜', async t => {
  const f = await largeGroup(t);
  const global = '/api/leaderboard?scope=global&period=day';
  assert.equal((await f.request(global, null, 0)).data.total, 124);
  const off = await f.request('/api/profile/ranking', { hidden: true }, 2);
  assert.equal(off.status, 200); assert.equal(off.data.rank_hidden, true);
  const g = (await f.request(global, null, 0)).data;
  assert.equal(g.total, 123); assert.ok(g.entries.every(e => e.nickname !== '成员2'));
  assert.ok((await f.request(f.path)).data.entries.every(e => e.nickname !== '成员2'));
  const mine = (await f.request('/api/my/usage?period=day', null, 2)).data;
  assert.equal(mine.summary.tokens, 100); assert.equal(mine.standing.rank, null); assert.equal(mine.standing.hidden, true);
  const ranks = (await f.request('/api/my/rankings?period=day', null, 2)).data;
  assert.equal(ranks.groups[0].my_rank, null); assert.equal(ranks.groups[0].rank_hidden, true); assert.equal(ranks.groups[0].my_tokens, 100);
  assert.equal((await f.request('/api/profile/ranking', { hidden: 'yes' }, 2)).status, 400);
  await f.request('/api/profile/ranking', { hidden: false }, 2);
  assert.equal((await f.request(global, null, 0)).data.total, 124);
});

test('按群隐藏排名：只在该群榜单消失，其他群和广场照常；非成员不能设置；可恢复', async t => {
  const f = await largeGroup(t);
  const other = (await f.resolve('other-group', 2)).data;
  const global = '/api/leaderboard?scope=global&period=day';
  const otherPath = `/api/leaderboard?scope=group&id=${other.id}&period=day`;
  const hide = await f.request(`/api/groups/${f.group.id}/visibility`, { hidden: true }, 2);
  assert.equal(hide.status, 200);
  assert.ok((await f.request(f.path)).data.entries.every(e => e.nickname !== '成员2'));
  assert.equal((await f.request(f.path)).data.total, 122);
  assert.ok((await f.request(otherPath, null, 2)).data.entries.some(e => e.nickname === '成员2'));
  assert.ok((await f.request(global, null, 0)).data.total === 124);
  assert.equal((await f.request(`/api/groups/${f.group.id}`, null, 2)).data.my_hidden, true);
  const ranks = (await f.request('/api/my/rankings?period=day', null, 2)).data.groups;
  const inLarge = ranks.find(g => g.id === f.group.id), inOther = ranks.find(g => g.id === other.id);
  assert.equal(inLarge.my_rank, null); assert.equal(inLarge.group_hidden, true); assert.ok(inOther.my_rank >= 1);
  f.db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-139', 139, Date.now() + 3600000);
  assert.equal((await f.request(`/api/groups/${f.group.id}/visibility`, { hidden: true }, 139)).status, 403);
  assert.equal((await f.request(`/api/groups/${f.group.id}/visibility`, { hidden: 1 }, 2)).status, 400);
  await f.request(`/api/groups/${f.group.id}/visibility`, { hidden: false }, 2);
  assert.equal((await f.request(f.path)).data.total, 123);
});
