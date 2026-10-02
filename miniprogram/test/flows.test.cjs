const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
const board = name => ({ entries: [{ rank: 1, nickname: name, tokens: 100, requests: 1 }], me: null, updated_at: Date.now() });
const usageData = (period = 'day', tokens = 12000) => ({ period, from: '2026-09-28', to: '2026-09-28',
  summary: { tokens, requests: 12, cache_read: 100, cache_write: 20, active_days: 1 },
  has_history: true, trend_days: 7, daily: [{ day: '2026-09-28', tokens, requests: 12 }],
  models: [{ name: 'Model', tokens, percent: 100 }], tools: [{ name: 'Codex', tokens, percent: 100 }] });

function page(name, overrides = {}, wxOverrides = {}) {
  let definition;
  let timerId = 0;
  const timers = new Map();
  const navigation = [];
  const pages = [];
  const storage = new Map();
  const api = {
    BASE_URL: 'https://rank.test', fmtTokens: n => String(n), fmtRelTime: () => '刚刚', cnRank: n => ({ label: String(n) }), initialOf: n => [...String(n || '?')][0],
    ensureLogin: async () => ({ user_id: 1, nickname: '测试', avatar_url: 'https://rank.test/avatar.png', connected: true, last_report_at: null }),
    ensureSession: async () => {}, sessionFresh: async () => false, peekMe: () => null, peekUsage: () => null, peekRankings: () => null,
    accountState: () => '',
    peekGroup: () => null, peekLeaderboard: () => null,
    relogin: async () => ({}), resolveGroup: async () => ({ id: 'actual-group', name: '本群', joined:true }),
    groupInfo: async () => ({ name: '本群', members: 1, joined: true, owner_id: 1 }),
    fetchLeaderboard: async () => board('test'), myRankings: async () => ({ groups: [] }),
    myUsage: async period => usageData(period),
    createShare: async period => ({id:'a'.repeat(24),user:{nickname:'测试'},usage:usageData(period)}),
    getConnect: async () => ({ token: 'test-token', connected: true, last_report_at: null }),
    ...overrides,
  };
  const wx = {
    getStorageSync: k => storage.get(k) || '', setStorageSync: (k, v) => storage.set(k, v),
    showToast() {}, stopPullDownRefresh() {}, hideShareMenu() {}, showShareMenu() {},
    navigateTo: x => navigation.push(['to', x.url]), switchTab: x => navigation.push(['tab', x.url]),
    navigateBack: x => navigation.push(['back', x.delta]), redirectTo: x => navigation.push(['redirect', x.url]),
    ...wxOverrides,
  };
  const flowModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/flow.js'), 'utf8'), { module: flowModule, require: () => api, wx });
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/${name}.js`), 'utf8'), {
    require: id => id.endsWith('/flow') ? flowModule.exports : id.endsWith('/api') ? api
      : id.endsWith('/share-avatar') ? { loadAvatarImage: async () => null }
      : id.endsWith('/share-code') ? { loadCodeImage: overrides.loadCodeImage || (async () => ({ officialCode: true })) }
      : require(path.join(root, 'utils', path.basename(id))),
    wx, console, getCurrentPages: () => pages, Page: value => definition = value,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const instance = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { p: instance, timers, navigation, pages, api, wx };
}

test('导航拆为群榜、广场、我的，所有页面均已注册', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  assert.deepEqual(app.tabBar.list.map(x => x.text), ['群榜', '广场', '我的']);
  for (const item of app.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, `${item}.${ext}`)));
});

test('群榜首页加载我的群，不请求全站列表；卡片入口不绑定来源群', async () => {
  let globalRequests = 0;
  const { p, navigation } = page('index', {
    fetchLeaderboard: async () => { globalRequests++; return board('global'); },
    myRankings: async () => ({ groups: [{ id: 'group-a', name: '群A', my_rank: 2, my_tokens: 100, members: 2 }] }),
  });
  await p.load();
  assert.equal(globalRequests, 0);
  assert.equal(p.data.myGroups[0].my_rank_label, '2');
  p.openGroup({ currentTarget: { dataset: { id: 'group-a' } } });
  assert.match(navigation[0][1], /g=group-a&from=mine/);
  assert.equal(p.onShareAppMessage().path, '/pages/group/group?enter=1');
});

test('广场切换周期后，迟到的旧响应不能覆盖新周期', async () => {
  const pending = new Map();
  const { p } = page('square', { fetchLeaderboard: ({ period }) => new Promise(resolve => pending.set(period, resolve)) });
  const day = p.load(); await flush();
  const week = p.switchPeriod({ currentTarget: { dataset: { key: 'week' } } }); await flush();
  pending.get('week')(board('week')); await week;
  pending.get('day')(board('day')); await day;
  assert.equal(p.data.period, 'week'); assert.equal(p.data.entries[0].nickname, 'week');
});

test('识别失败后重新分享仍是有效建群入口，不会查询空群 ID', async () => {
  const calls = [];
  const { p } = page('group', { groupInfo: async id => { calls.push(id); } }, { getGroupEnterInfo: ({ fail }) => fail() });
  p.onLoad({ create: '1' }); await p.onShow();
  assert.equal(p.data.enterState, 'failed'); assert.ok(p.data.enterError);
  assert.equal(calls.length, 0);
  const shared = p.onShareAppMessage();
  const next = page('group').p;
  next.onLoad(Object.fromEntries(new URL(shared.path, 'https://test').searchParams));
  assert.equal(next.data.missing, false); assert.equal(next._needsResolve, true);
});

test('首页及群页转发启用群分享票据，识别失败后重新分享也保留', async () => {
  for (const name of ['index', 'group']) {
    const shares = [];
    const { p } = page(name, {}, { showShareMenu: options => shares.push(options), getGroupEnterInfo: options => options.fail() });
    if (name === 'group') p.onLoad({ enter: '1' });
    await p.onShow();
    assert.equal(shares.at(-1).withShareTicket, true);
    assert.equal(p.onShareAppMessage().path, '/pages/group/group?enter=1');
  }
});

test('刷新会话后才取群密文；已有成员直接进入，仍保留未接入电脑状态', async () => {
  const order = [];
  const { p, navigation } = page('group', {
    relogin: async () => order.push('login'),
    resolveGroup: async payload => { order.push('resolve'); assert.equal(payload.g, undefined);assert.notEqual(payload.confirm,true); return { id: 'group-b', name: 'B群', joined:true }; },
  }, { getGroupEnterInfo: ({ success }) => { order.push('encrypted'); success({ encryptedData: 'data', iv: 'iv' }); } });
  p.buildPoster = () => {};
  p.onLoad({ g: 'old-group-a' }); await p.onShow();
  assert.deepEqual(order, ['login', 'encrypted', 'resolve']);
  assert.equal(p.data.id, 'group-b'); assert.equal(p.data.joined, true); assert.equal(p.data.hasReported, false);
  p.goConnect(); assert.match(navigation[0][1], /connect\?g=group-b$/);
});

test('群身份预览后等待确认；取消不入群，也不读取成员榜单',async()=>{
  let confirmations=0,boards=0;
  const {p,pages,navigation}=page('group',{resolveGroup:async body=>{if(body.confirm)confirmations++;return {id:'',name:'本群',exists:false,joined:false,group_ref:'ref'};},
    fetchLeaderboard:async()=>boards++},{getGroupEnterInfo:o=>o.success({encryptedData:'proof',iv:'iv'})});
  p.onLoad({enter:'1'});await p.onShow();
  assert.equal(p.data.enterState,'confirm');assert.equal(p.data.joined,false);assert.equal(p.data.id,'');
  pages.push({},{});p.cancelJoin();
  assert.deepEqual(navigation[0],['back',1]);assert.equal(confirmations,0);assert.equal(boards,0);
});

test('明确确认才加入，重新验证群身份并携带原群绑定，重复点击只提交一次',async()=>{
  const calls=[];let finish;
  const {p}=page('group',{resolveGroup:async body=>{calls.push(body);if(body.confirm)return new Promise(r=>finish=r);return {id:'',name:'本群',exists:false,joined:false,group_ref:'ref'};}},
    {getGroupEnterInfo:o=>o.success({encryptedData:'proof',iv:'iv'})});
  p.buildPoster=()=>{};p.onLoad({enter:'1'});await p.onShow();
  const joining=p.confirmJoin();p.confirmJoin();await flush();
  assert.equal(calls.length,2);assert.equal(calls[1].confirm,true);assert.equal(calls[1].expected_group_ref,'ref');
  finish({id:'canonical',name:'同一张榜',joined:true});await joining;
  assert.equal(p.data.id,'canonical');assert.equal(p.data.enterState,'ready');assert.equal(p.data.joining,false);
});

test('离开页面后迟到的群识别不展示确认，也不会继续发送入群请求',async()=>{
  let finishLogin,requests=0;
  const {p}=page('group',{relogin:()=>new Promise(r=>finishLogin=r),resolveGroup:async()=>requests++},
    {getGroupEnterInfo:o=>o.success({encryptedData:'proof',iv:'iv'})});
  p.onLoad({enter:'1'});const loading=p.onShow();await flush();p.onHide();finishLogin();await loading;
  assert.equal(requests,0);assert.notEqual(p.data.enterState,'confirm');
});

test('确认时群变化失败，需要重新识别；不把原群或分享路径当成目标群',async()=>{
  const {p}=page('group',{resolveGroup:async body=>{if(body.confirm)throw new Error('当前微信群已变化');return {id:'b',name:'B群',exists:true,joined:false,group_ref:'b-ref'};}},
    {getGroupEnterInfo:o=>o.success({encryptedData:'proof',iv:'iv'})});
  p.onLoad({g:'a'});await p.onShow();assert.equal(p.data.id,'b');
  await p.confirmJoin();assert.equal(p.data.enterState,'failed');assert.equal(p.data.joined,false);assert.equal(p.data.joining,false);
});

test('群中个人分享保留作者展示和我的用量，入群入口仅跳转识别页不自动加入',async()=>{
  let groups=0,logins=0,shareOptions;
  const {p,navigation}=page('record',{sharedRecord:async()=>({user:{nickname:'作者'},usage:usageData()}),resolveGroup:async()=>groups++,relogin:async()=>logins++},
    {getEnterOptionsSync:()=>({scene:1044}),showShareMenu:options=>shareOptions=options});
  p.onLoad({id:'a'.repeat(24)});await p.onShow();
  assert.equal(p.data.fromGroup,true);assert.equal(p.data.record.user.nickname,'作者');
  assert.equal(shareOptions.withShareTicket,true);
  p.goGroup();assert.deepEqual(navigation[0],['to','/pages/group/group?enter=1']);
  assert.equal(groups,0);assert.equal(logins,0);p.goMine();assert.deepEqual(navigation[1],['tab','/pages/profile/profile']);
});

test('从我的群进入不重新识别其他微信群；非成员不会按 ID 直接加入', async () => {
  let resolutions = 0; let boards = 0;
  const { p } = page('group', {
    groupInfo: async () => ({ joined: false, name: '已有群', members: 3 }),
    fetchLeaderboard: async () => { boards++; return board('test'); },
  }, { getGroupEnterInfo: () => resolutions++ });
  p.onLoad({ g: 'known-group', from: 'mine' }); await p.onShow();
  assert.equal(resolutions, 0); assert.equal(boards, 0); assert.equal(p.data.joined, false);
});

test('群榜切换周期同样拒绝迟到响应', async () => {
  const pending = new Map();
  const { p } = page('group', { fetchLeaderboard: ({ period }) => new Promise(resolve => pending.set(period, resolve)) });
  p.buildPoster = () => {};
  p.onLoad({ g: 'known-group', from: 'mine' });
  const day = p.onShow(); await flush();
  const month = p.switchPeriod({ currentTarget: { dataset: { key: 'month' } } }); await flush();
  pending.get('month')(board('month')); await month;
  pending.get('day')(board('day')); await day;
  assert.equal(p.data.entries[0].nickname, 'month');
});

test('新成员确认参与后先填头像昵称，原生选择返回保留草稿，保存后继续原群确认', async () => {
  let user = { user_id: 1, nickname: '', avatar_url: null }, confirms = 0, uploads = 0, previews = 0;
  const { p } = page('group', {
    ensureLogin: async () => user,
    resolveGroup: async body => {
      if (body.confirm) { confirms++; assert.equal(body.expected_group_ref, 'original'); return { id: 'actual', joined: true }; }
      previews++; return { id: '', name: '原群', exists: false, joined: false, group_ref: 'original' };
    },
    uploadProfile: async (nickname, file) => { uploads++; assert.equal(file, 'wxfile://chosen'); return user = { user_id: 1, nickname, avatar_url: 'https://saved/avatar.png' }; },
  }, { getGroupEnterInfo: o => o.success({ encryptedData: 'proof', iv: 'iv' }) });
  p.buildPoster = () => {}; p.onLoad({ enter: '1' }); await p.onShow(); await p.confirmJoin();
  assert.equal(p.data.enterState, 'profile'); assert.equal(confirms, 0);
  await p.save({ detail: { value: { nickname: '微信昵称' } } }); assert.equal(uploads, 0); assert.match(p.data.profileError, /头像/);
  p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://chosen' } }); p.onHide(); await p.onShow();
  assert.equal(p.data.nickname, '微信昵称'); assert.equal(p.data.avatarDraft, 'wxfile://chosen'); assert.equal(previews, 1);
  p.onChooseAvatar({ detail: {} }); assert.equal(p.data.avatarDraft, 'wxfile://chosen');
  await p.save({ detail: { value: { nickname: '微信昵称' } } });
  assert.equal(confirms, 1); assert.equal(uploads, 1); assert.equal(p.data.id, 'actual'); assert.equal(p.data.enterState, 'ready');
});

test('老成员缺资料即使有榜单缓存也先补全；缺昵称时复用已保存头像', async () => {
  let user = { user_id: 1, nickname: '', avatar_url: 'https://saved/avatar.png' }, boards = 0;
  const { p } = page('group', {
    peekMe: () => user, peekGroup: () => ({ name: '老群', joined: true, members: 2 }), peekLeaderboard: () => board('cached'),
    ensureLogin: async () => user, fetchLeaderboard: async () => { boards++; return board('fresh'); },
    setProfile: async nickname => user = { ...user, nickname },
  });
  p.buildPoster = () => {}; p.onLoad({ g: 'old', from: 'mine' }); await p.onShow();
  assert.equal(p.data.enterState, 'profile'); assert.equal(boards, 0); assert.equal(p.data.entries.length, 0);
  await p.save({ detail: { value: { nickname: '微信昵称' } } });
  assert.equal(p.data.enterState, 'ready'); assert.equal(boards, 1); assert.equal(p.data.avatarUrl, 'https://saved/avatar.png');
});

test('群资料页拒绝空昵称，保存失败保留草稿，拒绝隐私授权不会绕过必填', async () => {
  let saves = 0, grant, confirmations = 0;
  const { p } = page('group', {
    ensureLogin: async () => ({ user_id: 1 }),
    uploadProfile: async () => { saves++; throw new Error('上传失败'); }, resolveGroup: async () => { confirmations++; },
  }, { getPrivacySetting: o => o.success({ needAuthorization: true }), requirePrivacyAuthorize: o => grant = o });
  p.onLoad({ g: 'old', from: 'mine' }); await p.onShow();
  p.enableNickname(); grant.fail({ errno: 104 }); grant.complete(); assert.equal(p.data.nicknameReady, false);
  await p.save({ detail: { value: {} } }); assert.equal(saves, 0);
  p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://draft' } });
  await p.save({ detail: { value: { nickname: '' } } }); assert.equal(saves, 0);
  await p.save({ detail: { value: { nickname: '草稿' } } });
  assert.equal(p.data.enterState, 'profile'); assert.equal(p.data.nickname, '草稿'); assert.equal(p.data.avatarDraft, 'wxfile://draft');
  assert.match(p.data.profileError, /上传失败/); assert.equal(p.data.saving, false); assert.equal(confirmations, 0);
});

test('群资料保存期间离开不能自动入群，卸载后迟到保存也不导航', async () => {
  for (const unload of [false, true]) {
    let finish, confirms = 0, user = { user_id: 1 };
    const { p } = page('group', { ensureLogin: async () => user,
      uploadProfile: () => new Promise(resolve => finish = resolve),
      resolveGroup: async body => { if (body.confirm) { confirms++; return { id: 'actual', joined: true }; }
        return { joined: false, group_ref: 'ref', name: '群' }; },
    }, { getGroupEnterInfo: o => o.success({ encryptedData: 'proof', iv: 'iv' }) });
    p.buildPoster = () => {}; p.onLoad({ enter: '1' }); await p.onShow(); await p.confirmJoin();
    p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://chosen' } });
    const save = p.save({ detail: { value: { nickname: '昵称' } } });
    if (unload) p.onUnload(); else p.onHide();
    user = { user_id: 1, nickname: '昵称', avatar_url: 'https://saved/avatar.png' }; finish(user); await save;
    assert.equal(confirms, 0);
    if (!unload) { await p.onShow(); assert.equal(confirms, 1); }
  }
});

test('服务端要求补资料时刷新旧资料缓存并显示表单，而不是停留错误页', async () => {
  const { p } = page('group', { ensureLogin: async options => options?.force ? { user_id: 1 }
    : { user_id: 1, nickname: '旧资料', avatar_url: 'https://old/avatar.png' },
    fetchLeaderboard: async () => { const error = new Error('需要资料'); error.statusCode = 428; throw error; },
  });
  p.onLoad({ g: 'old', from: 'mine' }); await p.onShow();
  assert.equal(p.data.enterState, 'profile'); assert.equal(p.data.loading, false); assert.equal(p.data.user.nickname, undefined);
});

test('续页发现资料缺失转入必填表单并清除旧榜单，触底不能继续加载', async () => {
  let reads = 0;
  const { p } = page('group', {
    ensureLogin: async options => options?.force ? { user_id: 1 } : { user_id: 1, nickname: '昵称', avatar_url: 'https://saved/avatar.png' },
    fetchLeaderboard: async () => {
      reads++;
      if (reads === 1) return { ...board('first'), total: 60, has_more: true, next_offset: 50, snapshot: 'old' };
      const error = new Error('请完善资料'); error.statusCode = 428; throw error;
    },
  });
  p.buildPoster = () => {}; p.onLoad({ g: 'old', from: 'mine' }); await p.onShow();
  await p.loadMore();
  assert.equal(p.data.enterState, 'profile'); assert.equal(p.data.hasMore, false);
  assert.equal(p.data.snapshot, ''); assert.equal(p.data.entries.length, 0);
  await p.onReachBottom(); assert.equal(reads, 2);
});

test('接入页检测首次数据并停止后台轮询，平台命令与 AI 提示词同步更新', async () => {
  let reported = false;
  const { p, timers } = page('connect', { getConnect: async () => ({ token: 'token', connected: true, last_report_at: reported ? Date.now() : null }) });
  p.onLoad({ g: 'origin' }); await p.onShow();
  assert.equal(p.data.hasReported, false); assert.equal([...timers.values()][0].ms, 5000);
  p.switchOs({ currentTarget: { dataset: { os: 'win' } } });
  assert.match(p.data.command, /install\.ps1/); assert.match(p.data.aiPrompt, /install\.ps1/); assert.doesNotMatch(p.data.aiPrompt, /install\.sh/);
  reported = true; await [...timers.values()][0].fn();
  assert.equal(p.data.hasReported, true); assert.equal([...timers.values()][0].ms, 30000);
  p.onHide(); assert.equal(timers.size, 0);
});

test('接入页离开后旧请求不能恢复定时器或覆盖页面', async () => {
  let complete;
  const { p, timers } = page('connect', { getConnect: () => new Promise(resolve => complete = resolve) });
  p.onLoad({}); const loading = p.onShow(); await flush(); p.onHide();
  complete({ token: 'late-token', last_report_at: Date.now() }); await loading;
  assert.equal(p.data.rawToken, ''); assert.equal(timers.size, 0);
});

test('接入成功返回原群；没有原页面栈时也保留群上下文', () => {
  const { p, navigation, pages } = page('connect');
  p.onLoad({ g: 'origin' });
  pages.push({ route: 'pages/group/group', data: { id: 'origin' } }, p);
  p.goBoard(); assert.deepEqual(navigation[0], ['back', 1]);
  pages.length = 0; p.goBoard(); assert.match(navigation[1][1], /g=origin&from=connect/);
});

test('接入失败可重试；旧版只有历史上报时标为运行状态未知', async () => {
  let fail = true;
  const { p } = page('connect', { getConnect: async () => { if (fail) throw new Error('网络断开'); return { token: 'token', last_report_at: Date.now() - 86400000 }; } });
  await p.load(); assert.match(p.data.error, /网络断开/);
  fail = false; await p.load(); assert.equal(p.data.error, ''); assert.equal(p.data.connState, 'unknown');
});

test('首次登录失败后可就地重试，登录期间选择的系统用于最终命令', async () => {
  let completeLogin;
  let connectCalls = 0;
  const { p, api } = page('connect', {
    ensureLogin: () => new Promise((resolve, reject) => completeLogin = { resolve, reject }),
    getConnect: async () => { connectCalls++; return { token: 'new-user-token', last_report_at: null }; },
  });
  p.onLoad({});
  const first = p.onShow();
  p.switchOs({ currentTarget: { dataset: { os: 'win' } } });
  assert.equal(p.data.command, ''); assert.equal(connectCalls, 0);
  completeLogin.reject(new Error('微信登录失败')); await first;
  assert.match(p.data.error, /获取到接入命令.*微信登录失败/);
  assert.equal(p.data.command, ''); assert.equal(connectCalls, 0);
  api.ensureLogin = async () => ({ user_id: 2 });
  await p.load();
  assert.equal(p.data.error, ''); assert.equal(connectCalls, 1);
  assert.match(p.data.command, /install\.ps1/); assert.match(p.data.aiPrompt, /Windows/);
  assert.equal(p.data.hasReported, false);
  p.onHide();
});

test('已有历史同步的用户即使今日零用量或没有群，也不回到首次接入状态', async () => {
  const { p } = page('index', {
    ensureLogin: async () => ({ user_id: 1, last_report_at: Date.now() - 86400000 }),
    myUsage: async () => ({ ...usageData('day', 0), has_history: true }),
  });
  await p.load();
  assert.equal(p.data.hasReported, true); assert.equal(p.data.connState, 'unknown');
  assert.equal(p.data.usage.summary.tokens, 0); assert.equal(p.data.myGroups.length, 0);
});

test('无来源群的接入成功入口打开本人用量', () => {
  const { p, navigation } = page('connect');
  p.onLoad({}); p.goBoard();
  assert.deepEqual(navigation[0], ['tab', '/pages/profile/profile']);
});

test('海报导出完成后才调整同一画布尺寸，并只生成一套图片', async () => {
  const exports = [];
  const node = { width: 0, height: 0, getContext: () => ({}) };
  const query = { in() { return this; }, select() { return this; }, fields() { return this; }, exec(fn) { fn([{ node }]); } };
  const { p } = page('group', {}, { createSelectorQuery: () => query, canvasToTempFilePath: options => exports.push({ options, height: node.height }) });
  p.drawPoster = () => {}; p.drawShareCard = () => {};
  const build = p.buildPoster(); await flush();
  assert.equal(exports.length, 1); assert.equal(node.height, 1150);
  exports[0].options.success({ tempFilePath: 'poster.png' }); await flush();
  assert.equal(exports.length, 2); assert.equal(exports[1].height, 600);
  exports[1].options.success({ tempFilePath: 'card.png' }); await build;
  assert.equal(p.data.posterPath, 'poster.png'); assert.equal(p.data.shareCardPath, 'card.png');
});

test('我的页展示接入管理，返回页面不会覆盖尚未保存的昵称', async () => {
  const { p, navigation } = page('profile'); await p.load();
  p.onNicknameInput({ detail: { value: '未保存昵称' } }); await p.load();
  assert.equal(p.data.nickname, '未保存昵称');
  p.goConnect(); assert.equal(navigation[0][1], '/pages/connect/connect');
});

test('重置接入码后，重置前的迟到响应不能恢复旧命令', async () => {
  let resolveOld;
  let calls = 0;
  let rotateWork;
  const { p } = page('connect', {
    getConnect: () => ++calls === 1 ? new Promise(resolve => resolveOld = resolve)
      : Promise.resolve({ token: 'new-token', last_report_at: null }),
    rotateConnect: async () => ({}),
  }, { showModal: options => { rotateWork = options.success({ confirm: true }); } });
  p.data.rawToken = 'old-token';
  const oldLoad = p.load(); await flush();
  p.rotate(); await rotateWork;
  resolveOld({ token: 'old-token', last_report_at: Date.now() }); await oldLoad;
  assert.equal(p.data.rawToken, 'new-token');
  assert.match(p.data.aiPrompt, /new-token/); assert.doesNotMatch(p.data.command, /old-token/);
  assert.equal(p.data.hasReported, false);
});

test('帮助页返回接入页时保留来源群，不再复制带占位符的命令', () => {
  const { p, pages, navigation, wx } = page('about');
  p.onLoad({ g: 'origin' });
  p.goConnect(); assert.match(navigation[0][1], /connect\?g=origin$/);
  pages.push({ route: 'pages/connect/connect' }, p);
  let scrolled = false;
  wx.navigateBack = options => { navigation.push(['back', options.delta]); options.success(); };
  wx.pageScrollTo = options => { assert.equal(options.scrollTop, 0); assert.equal(options.duration, 0); scrolled = true; };
  p.goConnect(); assert.deepEqual(navigation[1], ['back', 1]); assert.equal(scrolled, true);
});

function realApi(wx, extras = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8'), { wx, module, ...extras,
    require: id => require(path.join(root, 'utils', id)) });
  return module.exports;
}

function pagedBoard(offset = 0, total = 123, snapshot = 'a'.repeat(64)) {
  const size = Math.min(50, total - offset);
  return { ...board(''), entries: Array.from({ length: size }, (_, i) => ({ rank: offset + i + 1,
    nickname: `成员${offset + i + 1}`, tokens: 100, requests: 1 })), total, members: 138, snapshot,
    has_more: offset + size < total, next_offset: offset + size < total ? offset + size : null,
    me: { rank: 123, tokens: 1 } };
}

test('群榜触底加载 50/50/23 人，重复点击合并，末页停止且不重绘分享图', async () => {
  const calls = []; let finish, posters = 0;
  const { p } = page('group', { fetchLeaderboard: async (query, options) => {
    calls.push({ ...query, force: options?.force });
    if (query.offset === 50) return new Promise(resolve => finish = resolve);
    return pagedBoard(query.offset || 0);
  } });
  p.buildPoster = () => posters++; p.onLoad({ g: 'a', from: 'mine' }); await p.onShow();
  assert.equal(p.data.entries.length, 50); assert.equal(p.data.members, 138); assert.equal(p.data.total, 123);
  assert.match(p.onShareAppMessage().title, /138 人已加入/);
  const more = p.onReachBottom(); await p.loadMore(); assert.equal(calls.length, 2);
  assert.equal(calls[1].force, true); assert.equal(calls[1].snapshot, 'a'.repeat(64));
  finish(pagedBoard(50)); await more; assert.equal(p.data.entries.length, 100);
  await p.onReachBottom(); assert.equal(p.data.entries.length, 123); assert.equal(p.data.hasMore, false);
  await p.onReachBottom(); assert.equal(calls.length, 3); assert.equal(posters, 1);
  assert.equal(p.data.me.rank, 123);
  assert.deepEqual(Array.from(p.data.entries, e => e.rank), Array.from({ length: 123 }, (_, i) => i + 1));
});

test('续页失败保留已有列表，触底不自动重试风暴，点击后恢复', async () => {
  let calls = 0, fails = true;
  const { p } = page('group', { fetchLeaderboard: async query => {
    calls++; if (query.offset && fails) throw new Error('网络暂不可用');
    return pagedBoard(query.offset || 0);
  } });
  p.buildPoster = () => {}; p.onLoad({ g: 'a', from: 'mine' }); await p.onShow(); await p.loadMore();
  assert.equal(p.data.entries.length, 50); assert.match(p.data.moreError, /网络/); assert.equal(p.data.loadingMore, false);
  await p.onReachBottom(); assert.equal(calls, 2);
  fails = false; await p.loadMore(); assert.equal(p.data.entries.length, 100); assert.equal(p.data.moreError, '');
});

test('续页迟到响应不能混入切换后的周期、刷新结果或已离开的页面', async () => {
  for (const action of ['period', 'refresh', 'hide']) {
    let finish;
    const { p } = page('group', { fetchLeaderboard: async query => query.offset
      ? new Promise(resolve => finish = resolve) : pagedBoard(0, query.period === 'week' ? 2 : 123) });
    p.buildPoster = () => {}; p.onLoad({ g: 'a', from: 'mine' }); await p.onShow();
    const more = p.loadMore(); await flush();
    if (action === 'period') await p.switchPeriod({ currentTarget: { dataset: { key: 'week' } } });
    else if (action === 'refresh') await p.onPullDownRefresh();
    else p.onHide();
    finish(pagedBoard(50)); await more;
    assert.equal(p.data.entries.length, action === 'period' ? 2 : 50, action);
    assert.equal(p.data.loadingMore, false, action);
  }
});

test('排名变化时重新获取首屏，不拼接旧排名；海报返回保留已展开的同快照列表', async () => {
  let changed = false; const toasts = [];
  const first = pagedBoard();
  const user = { user_id: 1, nickname: '测试', avatar_url: 'https://rank.test/avatar.png' }, info = { name: '本群', members: 138, joined: true };
  const { p, api } = page('group', { fetchLeaderboard: async query => {
    if (query.offset && changed) { const error = new Error('榜单变化'); error.statusCode = 409; throw error; }
    return changed ? pagedBoard(0, 124, 'b'.repeat(64)) : query.offset ? pagedBoard(query.offset) : first;
  } }, { showToast: value => toasts.push(value.title) });
  p.buildPoster = () => {}; p.onLoad({ g: 'a', from: 'mine' }); await p.onShow(); await p.loadMore();
  api.peekMe = () => user; api.peekGroup = () => info; api.peekLeaderboard = () => first;
  p.onHide(); await p.onShow(); assert.equal(p.data.entries.length, 100);
  changed = true; await p.loadMore();
  assert.equal(p.data.entries.length, 50); assert.equal(p.data.total, 124); assert.equal(p.data.snapshot, 'b'.repeat(64));
  assert.equal(p.data.loadingMore, false); assert.deepEqual(toasts, ['榜单有更新，已刷新']);
});

test('分页缓存按偏移量和快照区分，续页不会覆盖首屏缓存', async () => {
  const urls = [];
  const api = realApi({ getStorageSync: () => 'session', request: options => {
    urls.push(options.url); options.success({ statusCode: 200, data: { marker: urls.length } });
  } });
  const query = { scope: 'group', id: 'group-a', period: 'day' };
  const first = await api.fetchLeaderboard(query);
  for (const [offset, snapshot] of [[50, 'a'], [100, 'a'], [50, 'b']]) await api.fetchLeaderboard({ ...query, offset, snapshot });
  assert.equal(urls.length, 4); assert.equal(api.peekLeaderboard(query), first);
  assert.equal(new URL(urls[1]).searchParams.get('offset'), '50');
  assert.equal(new URL(urls[3]).searchParams.get('snapshot'), 'b');
});

test('用量与榜单缓存区分周期和群，并发读取合并；过期和北京时间换日重新请求', async () => {
  let now = Date.parse('2026-09-28T15:59:30Z');
  class Clock extends Date { static now() { return now; } }
  const calls = [];
  const api = realApi({ getStorageSync: () => 'session-a', request: options => {
    calls.push(options.url); queueMicrotask(() => options.success({ statusCode: 200, data: { marker: calls.length } }));
  } }, { Date: Clock });
  const [a, b] = await Promise.all([api.myUsage('day'), api.myUsage('day')]);
  assert.equal(a, b); assert.equal(calls.length, 1); assert.equal(api.peekUsage('day'), a);
  await api.myUsage('day'); assert.equal(calls.length, 1);
  await api.myUsage('week');
  await api.fetchLeaderboard({ scope: 'group', id: 'a' });
  await api.fetchLeaderboard({ scope: 'group', id: 'b' });
  assert.equal(calls.length, 4);
  now += 31_000;
  assert.equal(api.peekUsage('day'), null); await api.myUsage('day'); assert.equal(calls.length, 5);
  now += 60_001;
  assert.equal(api.peekUsage('day'), null); await api.myUsage('day'); assert.equal(calls.length, 6);
});

test('下拉强制读取不使用缓存，失败不恢复旧值，后续重试能够成功', async () => {
  let count = 0;
  const api = realApi({ getStorageSync: () => 'session', request: options => queueMicrotask(() => {
    count++;
    if (count === 2) options.fail({ errMsg: 'timeout' });
    else options.success({ statusCode: 200, data: { marker: count } });
  }) });
  await api.myUsage('day');
  await assert.rejects(api.myUsage('day', { force: true }), /timeout/);
  assert.equal(api.peekUsage('day'), null);
  assert.equal((await api.myUsage('day')).marker, 3);
});

test('资料修改清空旧排名与资料缓存，修改前的迟到响应不能重新写入缓存', async () => {
  let finishOld;
  const api = realApi({ getStorageSync: () => 'session', request: options => {
    if (options.url.includes('/api/my/usage')) finishOld = options.success;
    else queueMicrotask(() => options.success({ statusCode: 200, data: { user_id: 1, nickname: '新昵称' } }));
  } });
  await api.ensureLogin();
  const old = api.myUsage('day');
  await api.setProfile('新昵称');
  finishOld({ statusCode: 200, data: { marker: 'old' } }); await old;
  assert.equal(api.peekMe(), null); assert.equal(api.peekUsage('day'), null);
});

test('接入页检测到新上报后清空缓存，返回用量页会读取新数据', async () => {
  const api = realApi({ getStorageSync: () => 'session', request: options => queueMicrotask(() => {
    const data = options.url.endsWith('/api/me') ? { user_id: 1, last_report_at: 10 }
      : options.url.endsWith('/api/connect/token') ? { token: 'private-test-token', last_report_at: 20 } : { marker: 'cached' };
    options.success({ statusCode: 200, data });
  }) });
  await api.ensureLogin(); await api.myUsage('day'); await api.getConnect();
  assert.equal(api.peekMe(), null); assert.equal(api.peekUsage('day'), null);
});

test('仅心跳变化刷新本人状态，不使已缓存的用量反复请求', async () => {
  const api = realApi({ getStorageSync: () => 'session', request: options => queueMicrotask(() => {
    const data = options.url.endsWith('/api/me') ? { user_id: 1, last_report_at: 10 }
      : options.url.endsWith('/api/connect/token') ? { token: 'private', last_report_at: 10, sync_health:{supported:true,state:'online'} } : {marker:'cached'};
    options.success({statusCode:200,data});
  }) });
  await api.ensureLogin(); await api.myUsage('day'); await api.getConnect();
  assert.equal(api.peekMe().sync_health.state,'online');assert.equal(api.peekUsage('day').marker,'cached');
  assert.equal(api.peekMe().token,undefined);
});

test('用量未变仍显示在线，失联、主动关闭、错误和旧版未知分别呈现', async () => {
  const now=Date.now(); let state={token:'t',last_report_at:now-86400000,
    sync_health:{supported:true,state:'online',result:'idle',last_seen_at:now,last_check_at:now}};
  const {p}=page('connect',{getConnect:async()=>state});p.onLoad({});await p.onShow();
  assert.equal(p.data.connState,'live');assert.equal(p.data.connText,'同步程序在线');assert.match(p.data.connHint,/无新增用量/);
  assert.equal(p.data.syncTimes.length,3);
  state.sync_health.last_seen_at=now-16*60000;await p.load();assert.equal(p.data.connState,'stale');assert.match(p.data.connHint,/休眠、断网/);
  state.sync_health.state='stopped';state.sync_health.error_code='USER_DISABLED';await p.load();assert.equal(p.data.connText,'已主动关闭同步');
  state.sync_health={supported:true,state:'error',last_seen_at:now,error_code:'SOURCE_READ_FAILED'};await p.load();assert.match(p.data.connHint,/读取本机统计失败/);
  state.sync_health={supported:false,state:'unknown'};await p.load();assert.equal(p.data.connState,'unknown');
  state={token:'t',last_report_at:null,sync_health:{supported:true,state:'online',result:'idle',last_seen_at:now,last_check_at:now}};
  await p.load();assert.equal(p.data.hasReported,false);assert.equal(p.data.connText,'同步程序在线');p.onHide();
});

test('并发的过期会话请求只登录一次，登录响应直接复用用户资料', async () => {
  let logins = 0; let meRequests = 0;
  const api = realApi({ getStorageSync: () => 'expired', setStorageSync() {}, removeStorageSync() {},
    login: options => { logins++; queueMicrotask(() => options.success({ code: 'code' })); },
    request: options => queueMicrotask(() => {
      if (options.url.endsWith('/api/wx/session')) options.success({ statusCode: 200, data: { token: 'fresh', user: { user_id: 1 } } });
      else if (options.header.authorization === 'Bearer expired') options.success({ statusCode: 401, data: {} });
      else { if (options.url.endsWith('/api/me')) meRequests++; options.success({ statusCode: 200, data: { user_id: 1 } }); }
    }),
  });
  await Promise.all([api.myUsage('day'), api.myRankings('day')]);
  assert.equal(logins, 1);
  await api.ensureLogin(); assert.equal(meRequests, 0);
});

test('重复打开已缓存的首页、个人页、广场和群榜不请求数据，也不切回加载占位', async () => {
  const user = { user_id: 1, nickname: '已接入', avatar_url: 'https://rank.test/avatar.png', last_report_at: Date.now() };
  const cachedBoard = board('cached');
  for (const name of ['index', 'profile', 'square', 'group']) {
    let requests = 0;
    const { p } = page(name, {
      peekMe: () => user, peekUsage: () => usageData(), peekRankings: () => ({ groups: [] }),
      peekGroup: () => ({ name: '本群', joined: true, members: 1, owner_id: 1 }), peekLeaderboard: () => cachedBoard,
      ensureSession: async () => requests++, ensureLogin: async () => { requests++; return user; },
    });
    if (name === 'group') { p.onLoad({ g: 'a', from: 'mine' }); p.buildPoster = () => {}; }
    const states = [];
    const setData = p.setData.bind(p);
    p.setData = patch => { states.push(patch); setData(patch); };
    await p.onShow();
    assert.equal(requests, 0, name); assert.equal(p.data.loading, false, name);
    assert.ok(states.every(patch => patch.loading !== true && patch.usageLoading !== true), name);
  }
});

test('个人页用户资料和用量并行读取，资料较慢不会延后发起用量请求', async () => {
  let finishUser; let usageStarted = false;
  const { p } = page('profile', { ensureLogin: () => new Promise(resolve => finishUser = resolve),
    myUsage: async () => { usageStarted = true; return usageData(); } });
  const load = p.load(); await flush(); assert.equal(usageStarted, true);
  finishUser({ user_id: 1 }); await load;
  assert.equal(p.data.usage.summary.tokens, 12000);
});

test('任何 401 均按状态码重登一次，独立于服务端错误文案', async () => {
  let meRequests = 0; let logins = 0;
  const api = realApi({
    getStorageSync: () => 'expired', setStorageSync() {}, removeStorageSync() {},
    login: options => { logins++; queueMicrotask(() => options.success({ code: 'fresh-code' })); },
    request: options => queueMicrotask(() => {
      if (options.url.endsWith('/api/wx/session')) options.success({ statusCode: 200, data: { token: 'fresh-token', user: {} } });
      else if (++meRequests === 1) options.success({ statusCode: 401, data: { error: '凭证过期，请重新验证' } });
      else options.success({ statusCode: 200, data: { user_id: 1 } });
    }),
  });
  assert.equal((await api.ensureLogin()).user_id, 1);
  assert.equal(meRequests, 2); assert.equal(logins, 1);
});

test('普通网络故障不会被误判成需要重新登录', async () => {
  let logins = 0;
  const api = realApi({ getStorageSync: () => 'valid-session', login: () => logins++,
    request: options => queueMicrotask(() => options.fail({ errMsg: 'request:fail timeout' })),
  });
  await assert.rejects(api.ensureLogin(), /timeout/);
  assert.equal(logins, 0);
});

test('没有群或群列表失败时仍能查看自己的用量，并分享所选周期', async () => {
  const { p, navigation } = page('index', { myRankings: async () => { throw new Error('群列表暂不可用'); } });
  await p.load();
  assert.equal(p.data.usage.exact, '12,000'); assert.match(p.data.error, /群列表/);
  await p.switchPeriod({ currentTarget: { dataset: { key: 'week' } } });
  assert.equal(p.data.usage.periodLabel, '近7天');
  p.goShare(); assert.equal(navigation[0][1], '/pages/share/share?period=week');
});

test('用量加载失败不伪装为零，群列表仍能正常显示', async () => {
  const { p } = page('index', { myUsage: async () => { throw new Error('用量网络失败'); } });
  await p.load(); assert.equal(p.data.usage, null); assert.match(p.data.usageError, /用量网络失败/);
  assert.equal(p.data.error, ''); assert.equal(p.data.loading, false);
});

test('我的用量切换周期后丢弃旧响应，今日零数据保留历史与趋势', async () => {
  const pending = new Map();
  const { p } = page('profile', { myUsage: period => new Promise(resolve => pending.set(period, resolve)) });
  const day = p.load(); await flush();
  const all = p.switchPeriod({ currentTarget: { dataset: { key: 'all' } } }); await flush();
  pending.get('all')(usageData('all', 80000)); await all;
  pending.get('day')(usageData('day', 0)); await day;
  assert.equal(p.data.usage.exact, '80,000'); assert.equal(p.data.usage.period, 'all');
  p.selectDay({ currentTarget: { dataset: { index: 0 } } }); assert.equal(p.data.selectedDay.exact, '80,000');
});

function canvasWx(exports) {
  const ctx = { measureText: str => ({ width: [...str].length * 12 }),
    save() {}, restore() {}, arc() {}, clip() {}, fill() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, drawImage() {} };
  const node = { width: 0, height: 0, getContext: () => ctx };
  const query = { in() { return this; }, select() { return this; }, fields() { return this; }, exec(fn) { fn([{ node }]); } };
  return { createSelectorQuery: () => query, canvasToTempFilePath: options => exports.push({ options, height: node.height }) };
}

test('个人海报顺序导出竖图和5:4封面，转发不包含身份或接入码', async () => {
  const exports = [];
  let shareOptions;
  const { p } = page('share', {}, { ...canvasWx(exports), showShareMenu: options => shareOptions = options });
  p.onLoad({ period: 'week' }); await p.onShow();
  assert.equal(exports.length, 0);
  const build = p.onReady(); await flush();
  assert.equal(exports[0].height, 1400); assert.equal(exports.length, 1);
  exports[0].options.success({ tempFilePath: 'poster.png' }); await flush();
  assert.equal(exports[1].height, 800);
  exports[1].options.success({ tempFilePath: 'cover.png' }); await build;
  assert.equal(p.data.posterPath, 'poster.png'); assert.equal(p.data.coverPath, 'cover.png');
  assert.equal(p.onShareAppMessage().path, '/pages/record/record?id=' + 'a'.repeat(24));
  assert.match(p.onShareAppMessage().title, /近7天/);
  assert.equal(p.onShareAppMessage().imageUrl, 'cover.png');
  assert.equal(shareOptions.withShareTicket, true);
});

test('切换卡片风格时不发布旧图，也不并发调整同一画布', async () => {
  const exports = [];
  const { p } = page('share', {}, canvasWx(exports));
  p.onLoad({}); await p.onShow(); const old = p.onReady(); await flush();
  p.switchTheme({ currentTarget: { dataset: { theme: 'ink' } } });
  assert.equal(exports.length, 1); exports[0].options.success({ tempFilePath: 'old.png' }); await old; await flush();
  assert.equal(p.data.posterPath, ''); assert.equal(exports.length, 2);
  exports[1].options.success({ tempFilePath: 'ink-poster.png' }); await flush();
  exports[2].options.success({ tempFilePath: 'ink-cover.png' }); await flush();
  assert.equal(p.data.posterPath, 'ink-poster.png'); assert.equal(p.data.coverPath, 'ink-cover.png');
});

test('个人海报生成失败可重试；隐藏期间完成的导出不更新图片', async () => {
  const exports = [];
  const { p } = page('share', {}, canvasWx(exports));
  p.onLoad({}); await p.onShow(); const first = p.onReady(); await flush();
  exports[0].options.fail({}); await first; assert.match(p.data.imageError, /生成失败/);
  const retry = p.buildImages(); await flush(); p.onHide();
  exports[1].options.success({ tempFilePath: 'late.png' }); await retry;
  assert.equal(p.data.posterPath, '');
  const resumed = p.onShow(); await flush(); exports[2].options.success({ tempFilePath: 'resumed.png' }); await flush();
  exports[3].options.success({ tempFilePath: 'resumed-cover.png' }); await resumed;
  assert.equal(p.data.posterPath, 'resumed.png');
});

test('保存海报拒绝相册权限时提供设置入口，取消不误报成功', () => {
  const toasts = [], modals = [];
  const { p } = page('share', {}, {
    saveImageToPhotosAlbum: options => { options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }); options.complete(); },
    getSetting: options => options.success({ authSetting: { 'scope.writePhotosAlbum': false } }),
    showModal: options => modals.push(options), showToast: options => toasts.push(options),
  });
  p.data.posterPath = 'poster.png'; p.savePoster();
  assert.equal(p.data.saving, false); assert.equal(modals.length, 1); assert.equal(toasts.length, 0);
});

test('小程序码失败时禁止分享及导出，重试拿到真码后才开放分享菜单', async () => {
  const exports = [], menu = [];
  let fails = true;
  const { p } = page('share', { loadCodeImage: async () => {
    if (fails) throw new Error('小程序码暂时获取失败，请重试');
    return { officialCode: true };
  } }, { ...canvasWx(exports), hideShareMenu: () => menu.push('hide'), showShareMenu: () => menu.push('show') });
  p.onLoad({}); await p.onShow(); await p.onReady();
  assert.match(p.data.imageError, /小程序码/); assert.equal(exports.length, 0);
  assert.equal(p.data.posterPath, ''); assert.equal(p.data.coverPath, '');
  assert.ok(!menu.includes('show'));
  fails = false; const retry = p.buildImages(); await flush();
  exports[0].options.success({ tempFilePath: 'with-code.png' }); await flush();
  exports[1].options.success({ tempFilePath: 'with-code-cover.png' }); await retry;
  assert.equal(menu.at(-1), 'show'); assert.equal(p.data.coverPath, 'with-code-cover.png');
});

test('获取小程序码期间切换主题，迟到结果不得导出旧主题', async () => {
  const exports = [];
  let resolveCode;
  const { p } = page('share', { loadCodeImage: () => new Promise(resolve => resolveCode = resolve) }, canvasWx(exports));
  p.onLoad({}); await p.onShow(); const old = p.onReady(); await flush();
  p.switchTheme({ currentTarget: { dataset: { theme: 'ink' } } });
  resolveCode({ officialCode: true }); await old; await flush();
  assert.equal(exports.length, 0); assert.equal(p.data.coverPath, '');
  resolveCode({ officialCode: true }); await flush();
  exports[0].options.success({ tempFilePath: 'ink.png' }); await flush();
  exports[1].options.success({ tempFilePath: 'ink-cover.png' }); await flush();
  assert.equal(p.data.coverPath, 'ink-cover.png');
});

test('未授权微信昵称只在点击时触发原生授权；同意后启用昵称输入', async () => {
  let requests = 0, grant;
  const { p } = page('profile', {}, { getPrivacySetting: o => o.success({ needAuthorization: true }),
    requirePrivacyAuthorize: o => { requests++; grant = o; } });
  await p.onShow(); assert.equal(requests, 0); assert.equal(p.data.nicknameReady, false);
  p.enableNickname(); p.enableNickname(); assert.equal(requests, 1);
  grant.success(); grant.complete(); assert.equal(p.data.nicknameReady, true); assert.equal(p.data.nicknameFocus, true);
  assert.equal(p.data.privacyBusy, false);
});

test('拒绝昵称授权保留数据面板与草稿，允许稍后重试', async () => {
  let grant;
  const { p } = page('profile', {}, { getPrivacySetting: o => o.success({ needAuthorization: true }),
    requirePrivacyAuthorize: o => { grant = o; } });
  await p.onShow(); p.onNicknameInput({ detail: { value: '草稿' } });
  p.enableNickname(); grant.fail({ errno: 104 }); grant.complete();
  assert.equal(p.data.nicknameReady, false); assert.equal(p.data.privacyBusy, false);
  assert.equal(p.data.nickname, '草稿'); assert.equal(p.data.usage.summary.tokens, 12000);
});

test('已有隐私授权不重复弹窗，迟到检查不能覆盖刚通过的授权', async () => {
  let check, grant;
  const { p } = page('profile', {}, { getPrivacySetting: o => { check = o; }, requirePrivacyAuthorize: o => { grant = o; } });
  await p.onShow(); check.success({ needAuthorization: false }); assert.equal(p.data.nicknameReady, true);
  p.checkNicknamePrivacy(); p.enableNickname(); grant.success(); grant.complete();
  check.success({ needAuthorization: true }); assert.equal(p.data.nicknameReady, true);
  p.checkNicknamePrivacy(); p.onUnload(); check.success({ needAuthorization: true }); assert.equal(p.data.nicknameReady, true);
});

test('微信头像选择的临时文件在返回页面时保留，取消不更改，成功保存使用服务端地址',async()=>{
  const calls=[];const {p}=page('profile',{uploadProfile:async(name,path)=>{calls.push([name,path]);return {nickname:name,avatar_url:'https://rank.test/avatars/saved.png'};}});
  await p.load();p.onHide();p.onChooseAvatar({detail:{avatarUrl:'wxfile://picked'}});await p.onShow();
  assert.equal(p.data.avatarDraft,'wxfile://picked');assert.equal(p.data.avatarUrl,'wxfile://picked');
  p.onChooseAvatar({detail:{}});assert.equal(p.data.avatarDraft,'wxfile://picked');
  await p.save({detail:{value:{nickname:'微信新昵称'}}});assert.deepEqual(calls,[['微信新昵称','wxfile://picked']]);
  assert.equal(p.data.avatarDraft,'');assert.equal(p.data.avatarUrl,'https://rank.test/avatars/saved.png');
});

test('昵称以微信原生表单提交值为准；安全检查清空后不能误用缓存值',async()=>{
  let calls=0;const {p}=page('profile',{setProfile:async()=>{calls++;}});
  await p.load();p.onNicknameInput({detail:{value:'尚未检查'}});
  await p.save({detail:{value:{nickname:''}}});assert.equal(calls,0);assert.equal(p.data.nickname,'');
});

test('未启用昵称输入时只换头像，提交保留已有昵称',async()=>{
  const calls=[];
  const {p}=page('profile',{uploadProfile:async(name,file)=>{calls.push([name,file]);return {nickname:name,avatar_url:'https://rank.test/saved.png'};}},
    {getPrivacySetting:o=>o.success({needAuthorization:true})});
  await p.onShow();p.onChooseAvatar({detail:{avatarUrl:'wxfile://new-avatar'}});
  await p.save({detail:{value:{}}});
  assert.deepEqual(calls,[['测试','wxfile://new-avatar']]);assert.equal(p.data.nickname,'测试');
});

test('启用昵称输入后原生表单缺少昵称不能回退到旧昵称',async()=>{
  let calls=0;const {p}=page('profile',{setProfile:async()=>{calls++;}});
  await p.onShow();p.onNicknameInput({detail:{value:'待检查昵称'}});
  await p.save({detail:{value:{}}});
  assert.equal(calls,0);assert.equal(p.data.nickname,'');
});

test('保存失败保留头像与昵称草稿，允许再次提交',async()=>{
  const {p}=page('profile',{uploadProfile:async()=>{throw new Error('网络失败');}});
  await p.load();p.onChooseAvatar({detail:{avatarUrl:'wxfile://draft'}});
  await p.save({detail:{value:{nickname:'草稿昵称'}}});await p.load();
  assert.equal(p.data.nickname,'草稿昵称');assert.equal(p.data.avatarDraft,'wxfile://draft');assert.equal(p.data.saving,false);
});

test('头像上传压缩后携带会话；401 只重登重试一次，保持昵称和文件',async()=>{
  const uploads=[];let logins=0;
  const api=realApi({getStorageSync:()=> 'expired',setStorageSync(){},removeStorageSync(){},
    compressImage:o=>o.success({tempFilePath:'wxfile://compressed'}),
    uploadFile:o=>{uploads.push(o);o.success({statusCode:uploads.length===1?401:200,data:JSON.stringify(uploads.length===1?{error:'expired'}:{nickname:'微信昵称',avatar_url:'https://image'})});},
    login:o=>{logins++;queueMicrotask(()=>o.success({code:'new'}));},
    request:o=>o.success({statusCode:200,data:{token:'fresh',user:{}}}),
  });
  const result=await api.uploadProfile('微信昵称','wxfile://selected');assert.equal(result.avatar_url,'https://image');
  assert.equal(logins,1);assert.equal(uploads.length,2);assert.equal(uploads[1].filePath,'wxfile://compressed');assert.equal(uploads[1].formData.nickname,'微信昵称');assert.equal(uploads[1].header.authorization,'Bearer fresh');
});

test('保存完成后，返回页面时发起的旧资料请求不能覆盖新头像',async()=>{
  let finishLogin;const {p}=page('profile',{ensureLogin:()=>new Promise(r=>finishLogin=r),uploadProfile:async()=>({nickname:'新昵称',avatar_url:'https://new-avatar'})});
  const loading=p.load();await flush();p.onChooseAvatar({detail:{avatarUrl:'wxfile://new'}});
  await p.save({detail:{value:{nickname:'新昵称'}}});
  finishLogin({nickname:'旧昵称',avatar_url:'https://old-avatar'});await loading;
  assert.equal(p.data.nickname,'新昵称');assert.equal(p.data.avatarUrl,'https://new-avatar');
});

test('个人卡片指向作者记录，小程序码加载不携带作者或主题参数', async () => {
  const exports=[],codes=[],snapshot={...usageData('day',990000000),activity:{active_days:21,current_streak:21,streak_as_of:'2026-09-28'}};
  const {p}=page('share',{createShare:async()=>({id:'b'.repeat(24),user:{nickname:'原昵称'},usage:snapshot}),
    loadCodeImage:async(...args)=>{codes.push(args);return {};}
  },canvasWx(exports));
  p.onLoad({});await p.onShow();const build=p.onReady();await flush();
  exports[0].options.success({tempFilePath:'usage.png'});await flush();
  exports[1].options.success({tempFilePath:'usage-cover.png'});await build;
  const shared=p.onShareAppMessage();
  assert.equal(shared.path,'/pages/record/record?id='+'b'.repeat(24));
  assert.equal(shared.title,'原昵称 · 今日 9.90 亿 Tokens');assert.equal(shared.imageUrl,'usage-cover.png');
  assert.equal(codes[0].length,1);
});

test('没有历史不创建公开记录；重载失败也不能复用上次的分享链接', async () => {
  let created=0,fail=false;
  const {p,api}=page('share',{createShare:async()=>{created++;return {id:'a'.repeat(24),user:{},usage:usageData()};},
    myUsage:async()=>{if(fail)throw new Error('断网');return {...usageData(),has_history:false};}});
  p.onLoad({});await p.onShow();await p.onReady();assert.equal(created,0);assert.equal(p.data.shareId,'');
  api.myUsage=async()=>usageData();p._canvasReady=false;await p.load();assert.ok(p.data.shareId);
  api.myUsage=async()=>{throw new Error('断网');};await p.load();
  assert.equal(p.data.shareId,'');assert.equal(p._snapshot,null);assert.equal(p.onShareAppMessage().path,'/pages/index/index');
});

test('取消公开后返回页面不会重新开放记录，用户明确重新生成后才恢复', async () => {
  let modal,created=0,revoked='';
  const {p}=page('share',{createShare:async()=>{created++;return{id:'c'.repeat(24),user:{},usage:usageData()};},
    revokeShare:async id=>{revoked=id;}},{showModal:o=>modal=o});
  p.onLoad({});await p.onShow();p.revoke();await modal.success({confirm:true});
  assert.equal(revoked,'c'.repeat(24));assert.equal(p.data.shareId,'');assert.equal(p._snapshot,null);
  p.onHide();await p.onShow();assert.equal(created,1);
  await p.load();assert.equal(created,2);assert.ok(p.data.shareId);
});

test('个人卡片及旧码展示作者数据，再次转发保留作者，底部跳转访问者自己的用量', async () => {
  let logins=0,groups=0,reads=0;
  for(const options of [{id:'a'.repeat(24),mode:'streak'},{scene:encodeURIComponent('s='+'a'.repeat(24)+'&m=s')}]){
    const {p,navigation}=page('record',{ensureLogin:async()=>logins++,resolveGroup:async()=>groups++,sharedRecord:async id=>{
      reads++;assert.equal(id,'a'.repeat(24));return{user:{nickname:'作者'},usage:{...usageData(),activity:{current_streak:21,active_days:30,streak_as_of:'2026-09-28'}}};}});
    p.onLoad(options);await p.onShow();assert.equal(p.data.mode,'streak');assert.equal(p.data.story.streakValue,21);
    p.goMine();assert.deepEqual(navigation[0],['tab','/pages/profile/profile']);
    assert.equal(p.data.record.user.nickname,'作者');
    assert.equal(p.onShareAppMessage().path,'/pages/record/record?id='+'a'.repeat(24));
    assert.match(p.onShareAppMessage().title,/^作者 ·/);
  }
  assert.equal(logins,0);assert.equal(groups,0);assert.equal(reads,2);
});

test('无效码不请求摘要；过期与页面离开时不泄漏旧记录', async () => {
  let reads=0,finish;
  const {p}=page('record',{sharedRecord:()=>{reads++;return new Promise(resolve=>finish=resolve);}});
  p.onLoad({scene:'s=1'});await p.onShow();assert.equal(reads,0);assert.match(p.data.error,/无效/);
  p.onLoad({id:'a'.repeat(24)});const load=p.onShow();await flush();p.onHide();
  finish({user:{nickname:'late'},usage:usageData()});await load;assert.equal(p.data.record,null);
  const expired=page('record',{sharedRecord:async()=>{throw new Error('分享记录已失效或已被取消');}}).p;
  expired.onLoad({id:'a'.repeat(24)});await expired.onShow();assert.match(expired.data.error,/已失效/);assert.equal(expired.data.record,null);
});

test('群榜小程序码不可用时不导出无真码海报，保留群内原生卡片入口和重试', async () => {
  const exports=[];
  const {p}=page('group',{loadCodeImage:async()=>{throw new Error('微信小程序码暂时获取失败');}},canvasWx(exports));
  await p.buildPoster();assert.equal(exports.length,0);assert.match(p.data.posterError,/小程序码/);
  assert.equal(p.onShareAppMessage().path,'/pages/group/group?enter=1');
});

test('未授权时点击头像先走官方隐私授权，同意后启用原生头像选择', async () => {
  let requests = 0, grant; const toasts = [];
  const { p } = page('profile', {}, { getPrivacySetting: o => o.success({ needAuthorization: true }),
    requirePrivacyAuthorize: o => { requests++; grant = o; }, showToast: o => toasts.push(o.title), canIUse: () => true });
  await p.onShow(); assert.equal(p.data.nicknameReady, false); assert.equal(p.data.avatarNative, true);
  p.onAvatarTap(); p.onAvatarTap(); assert.equal(requests, 1);
  grant.success(); grant.complete();
  assert.equal(p.data.nicknameReady, true); assert.equal(p.data.nicknameFocus, false);
  assert.deepEqual(toasts, ['已授权，请再点一次头像']);
  p.onAvatarTap(); assert.equal(requests, 1);
});

test('客户端不支持原生头像时从相册选择，取消不提示，权限错误给出明确提示', async () => {
  const media = []; const toasts = [];
  const { p } = page('profile', {}, { getPrivacySetting: o => o.success({ needAuthorization: false }),
    canIUse: () => false, chooseMedia: o => media.push(o), showToast: o => toasts.push(o.title) });
  await p.onShow(); assert.equal(p.data.avatarNative, false);
  p.onAvatarTap(); assert.equal(media[0].count, 1); assert.deepEqual(media[0].mediaType, ['image']);
  media[0].success({ tempFiles: [{ tempFilePath: 'wxfile://album' }] });
  assert.equal(p.data.avatarDraft, 'wxfile://album'); assert.equal(p.data.avatarUrl, 'wxfile://album');
  p.onAvatarTap(); media[1].fail({ errMsg: 'chooseMedia:fail cancel' }); assert.deepEqual(toasts, []);
  p.onChooseAvatar({ detail: { errMsg: 'chooseAvatar:fail api scope is not declared in the privacy agreement' } });
  assert.deepEqual(toasts, ['头像权限未生效，请重启小程序后重试']); assert.equal(p.data.avatarDraft, 'wxfile://album');
});

test('启动时监听新版本，下载完成后提示并应用更新', () => {
  let app, ready, modal, applied = 0, armed = 0;
  const manager = { onUpdateReady: fn => { ready = fn; }, applyUpdate: () => applied++ };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App: v => app = v, wx: { getUpdateManager: () => manager, showModal: o => modal = o },
    require: id => id === './utils/api' ? { accountState: () => '' } : id === './utils/connect-prompt' ? { arm: () => armed++ } : id === './utils/privacy-notice' ? { arm: () => armed++ } : require(id) });
  app.onLaunch.call(app); ready(); assert.equal(modal.showCancel, false);
  modal.complete(); assert.equal(applied, 1);
  app.onShow.call(app); app.onShow.call(app); assert.equal(armed, 4);
});

test('已入群但从未接入电脑：每次进入小程序弹一次接入提示，确认后进入接入页', async () => {
  const prompt = require(path.join(root, 'utils/connect-prompt.js'));
  const modals = [];
  const unreported = { user_id: 1, nickname: '测试', avatar_url: 'https://rank.test/avatar.png', last_report_at: null };
  const { p, navigation } = page('index', { ensureLogin: async () => unreported,
    myRankings: async () => ({ groups: [{ id: 'g1', name: '本群', members: 3, my_rank: null, my_tokens: 0 }] }) },
    { showModal: o => modals.push(o) });
  prompt.arm(); await p.load();
  assert.equal(modals.length, 1); assert.equal(modals[0].title, '还没有接入电脑');
  modals[0].success({ confirm: true }); modals[0].complete();
  assert.deepEqual(navigation.at(-1), ['to', '/pages/connect/connect']);
  await p.load(); assert.equal(modals.length, 1);
  prompt.arm(); await p.load(); assert.equal(modals.length, 2);
  modals[1].success({ confirm: false }); modals[1].complete(); assert.equal(navigation.length, 1);
});

test('接入提示不打扰：未入群、已有用量或弹窗未关闭时不再弹', async () => {
  const prompt = require(path.join(root, 'utils/connect-prompt.js'));
  const modals = [];
  const wx = { showModal: o => modals.push(o) };
  prompt.arm();
  assert.equal(prompt.maybePrompt(wx, { user: { user_id: 1 }, hasReported: false, joined: false }, () => {}), false);
  assert.equal(prompt.maybePrompt(wx, { user: { user_id: 1 }, hasReported: true, joined: true }, () => {}), false);
  assert.equal(prompt.maybePrompt(wx, { user: null, hasReported: false, joined: true }, () => {}), false);
  assert.equal(prompt.maybePrompt(wx, { user: { user_id: 1 }, hasReported: false, joined: true }, () => {}), true);
  prompt.arm();
  assert.equal(prompt.maybePrompt(wx, { user: { user_id: 1 }, hasReported: false, joined: true }, () => {}), false);
  modals[0].complete(); assert.equal(modals.length, 1);
});

test('群榜转发卡片带来源群名；在其他群打开时说明来源，同群打开不提示', async () => {
  const { p } = page('group', { groupInfo: async () => ({ name: 'A群', members: 22, joined: true, owner_id: 2 }) },
    { getGroupEnterInfo: o => o.success({ encryptedData: 'proof', iv: 'iv' }) });
  p.buildPoster = () => {}; p.onLoad({ g: 'a', from: 'mine' }); await p.onShow();
  const shared = p.onShareAppMessage();
  assert.equal(shared.path, '/pages/group/group?enter=1&src=' + encodeURIComponent('A群'));
  const query = Object.fromEntries(new URL(shared.path, 'https://test').searchParams);
  const other = page('group', { resolveGroup: async () => ({ id: '', name: '本群 Token 排名', exists: false, joined: false, members: 0, group_ref: 'b' }) },
    { getGroupEnterInfo: o => o.success({ encryptedData: 'proof', iv: 'iv' }) }).p;
  other.onLoad(query); await other.onShow();
  assert.equal(other.data.enterState, 'confirm'); assert.equal(other.data.sourceName, 'A群'); assert.equal(other.data.groupExists, false);
  const same = page('group', {}, {}).p; same.onLoad({ enter: '1', src: '%E7%BE%A4' + 'x'.repeat(60) });
  assert.equal([...same.data.sourceName].length, 30);
});

test('私聊里打开群榜卡片：不调用群识别，给出看自己用量和广场榜的出口', async () => {
  let resolutions = 0;
  const { p, navigation } = page('group', {}, { getEnterOptionsSync: () => ({ scene: 1007 }), getGroupEnterInfo: () => resolutions++ });
  p.onLoad({ enter: '1', src: encodeURIComponent('A群') }); await p.onShow();
  assert.equal(p.data.enterState, 'private'); assert.equal(resolutions, 0); assert.equal(p.data.sourceName, 'A群');
  p.goMine(); p.goSquare();
  assert.deepEqual(navigation, [['tab', '/pages/profile/profile'], ['tab', '/pages/square/square']]);
  await p.onShow(); assert.equal(p.data.enterState, 'private'); assert.equal(p._entering, false);
});

test('会话仍有效时直接用服务端密钥识别群，不重新登录；解密失败才重登并重取密文', async () => {
  const order = [];
  let fail = false;
  const { p } = page('group', {
    sessionFresh: async () => true,
    relogin: async () => order.push('login'),
    resolveGroup: async () => { order.push('resolve');
      if (fail) { fail = false; const e = new Error('群标识解密失败（会话密钥过期）：请退出小程序后从群卡片重新进入'); e.statusCode = 400; throw e; }
      return { id: 'g', name: '群', joined: true }; },
  }, { getGroupEnterInfo: ({ success }) => { order.push('encrypted'); success({ encryptedData: 'd', iv: 'i' }); } });
  p.buildPoster = () => {};
  p.onLoad({ enter: '1' }); await p.onShow();
  assert.deepEqual(order, ['encrypted', 'resolve']);
  order.length = 0; fail = true; p._needsResolve = true; await p.tryEnterGroup();
  assert.deepEqual(order, ['encrypted', 'resolve', 'login', 'encrypted', 'resolve']); assert.equal(p.data.enterState, 'ready');
});

test('卡片确认是成员后，榜单与用户、群信息并行请求', async () => {
  const started = []; let release;
  const gate = new Promise(r => release = r);
  const { p } = page('group', {
    resolveGroup: async () => ({ id: 'g', name: '群', joined: true }),
    ensureLogin: async () => { started.push('me'); await gate; return { user_id: 1, nickname: '测试', avatar_url: 'https://rank.test/a.png', last_report_at: 1 }; },
    groupInfo: async () => { started.push('info'); await gate; return { name: '群', members: 2, joined: true, owner_id: 1 }; },
    fetchLeaderboard: async () => { started.push('board'); return board('x'); },
  }, { getGroupEnterInfo: o => o.success({ encryptedData: 'd', iv: 'i' }) });
  p.buildPoster = () => {};
  p.onLoad({ enter: '1' }); const done = p.onShow(); await flush(); await flush();
  assert.deepEqual([...started].sort(), ['board', 'info', 'me']);
  release(); await done; assert.equal(p.data.entries.length, 1);
});

test('新群确认页可顺带起名并随加入提交；群名不合规时停留在确认页', async () => {
  const bodies = []; let reject = true; const toasts = [];
  const { p } = page('group', {
    resolveGroup: async body => { bodies.push(body);
      if (!body.confirm) return { id: '', name: '本群 Token 排名', exists: false, joined: false, members: 0, group_ref: 'r' };
      if (reject) { reject = false; const e = new Error('群名不可用：1-100 个字，且不含链接、@、敏感词'); e.statusCode = 400; throw e; }
      return { id: 'g', name: body.name, joined: true }; },
  }, { getGroupEnterInfo: o => o.success({ encryptedData: 'd', iv: 'i' }), showToast: o => toasts.push(o.title) });
  p.buildPoster = () => {};
  p.onLoad({ enter: '1' }); await p.onShow(); assert.equal(p.data.enterState, 'confirm');
  p.onDraftName({ detail: { value: ' 看 x.cn ' } }); await p.confirmJoin();
  assert.equal(bodies.at(-1).name, '看 x.cn'); assert.equal(p.data.enterState, 'confirm'); assert.match(toasts[0], /群名不可用/);
  p.onDraftName({ detail: { value: 'Vibe Coding 交流群' } }); await p.confirmJoin();
  assert.equal(bodies.at(-1).name, 'Vibe Coding 交流群'); assert.equal(p.data.enterState, 'ready');
});

test('默认名群榜提示起名；成员可起名，已起名后按服务端权限隐藏改名', async () => {
  const modals = []; const renames = [];
  let info = { name: '本群 Token 排名', members: 3, joined: true, owner_id: 9, named: false, can_rename: true };
  const { p } = page('group', { groupInfo: async () => info, renameGroup: async (id, name) => renames.push([id, name]) },
    { showModal: o => modals.push(o) });
  p.buildPoster = () => {}; p.onLoad({ g: 'g', from: 'mine' }); await p.onShow();
  assert.equal(p.data.named, false); assert.equal(p.data.canRename, true);
  p.rename(); assert.equal(modals[0].title, '给群榜起个名字'); assert.equal(modals[0].content, '');
  await modals[0].success({ confirm: true, content: '  新名字 ' }); assert.deepEqual(renames[0], ['g', '新名字']);
  info = { name: '新名字', members: 3, joined: true, owner_id: 9, named: true, can_rename: false };
  await p.init({ force: true }); assert.equal(p.data.named, true); assert.equal(p.data.canRename, false);
  p.rename(); await modals[1].success({ confirm: true, content: '群'.repeat(101) }); assert.equal(renames.length, 1);
});

test('广场榜首屏 50 人，触底按快照续页；排名变化时从首屏重新加载', async () => {
  const page50 = (offset, total, snap) => ({ entries: Array.from({ length: Math.min(50, total - offset) }, (_, i) => ({ rank: offset + i + 1, nickname: `u${offset + i + 1}`, tokens: 10, requests: 1 })),
    total, snapshot: snap, has_more: offset + 50 < total, next_offset: offset + 50 < total ? offset + 50 : null, updated_at: Date.now() });
  const calls = []; let snap = 's1';
  const toasts = [];
  const { p } = page('square', { fetchLeaderboard: async q => { calls.push(q);
    if (q.offset && q.snapshot !== snap) { const e = new Error('榜单已有更新'); e.statusCode = 409; throw e; }
    return page50(q.offset || 0, 123, snap); } }, { showToast: o => toasts.push(o.title) });
  await p.onShow();
  assert.equal(p.data.entries.length, 50); assert.equal(p.data.hasMore, true); assert.equal(calls[0].offset, undefined);
  await p.onReachBottom(); assert.equal(p.data.entries.length, 100); assert.equal(calls.at(-1).offset, 50); assert.equal(calls.at(-1).snapshot, 's1');
  await p.loadMore(); assert.equal(p.data.entries.length, 123); assert.equal(p.data.hasMore, false);
  assert.deepEqual(p.data.entries.map(e => e.rank), Array.from({ length: 123 }, (_, i) => i + 1));
  await p.loadMore(); assert.equal(calls.length, 3);
  await p.load({ force: true }); snap = 's2';
  await p.loadMore(); assert.equal(p.data.entries.length, 50); assert.equal(p.data.snapshot, 's2'); assert.equal(toasts.at(-1), '榜单有更新，已刷新');
});

test('手动检查同步状态总是给出结果提示，未接入与已接入分别说明', async () => {
  const toasts = []; let state = { token: 't', connected: true, last_report_at: null };
  const { p } = page('connect', { getConnect: async () => state }, { showToast: o => toasts.push(o.title), setClipboardData() {} });
  p.onLoad({}); await p.onShow();
  await p.checkNow(); assert.equal(toasts.at(-1), '还没收到用量，确认电脑上的命令已运行完成');
  state = { token: 't', connected: true, last_report_at: Date.now() - 60000 };
  await p.checkNow(); assert.match(toasts.at(-1), /运行状态未知/);
  p.onHide();
});

test('我的页关闭排名：调用接口、更新开关状态并提示；失败时开关回到原状态', async () => {
  const calls = []; const toasts = []; let fail = false;
  const { p } = page('profile', { setRanking: async hidden => { calls.push(hidden); if (fail) throw new Error('网络错误'); return { rank_hidden: hidden }; } },
    { showToast: o => toasts.push(o.title) });
  await p.onShow();
  await p.toggleRanking({ detail: { value: false } });
  assert.deepEqual(calls, [true]); assert.equal(p.data.user.rank_hidden, true); assert.equal(toasts.at(-1), '已关闭排名'); assert.equal(p.data.rankingSaving, false);
  fail = true; await p.toggleRanking({ detail: { value: true } });
  assert.equal(p.data.user.rank_hidden, true); assert.equal(toasts.at(-1), '网络错误');
});

test('群页按群隐藏排名：调用接口、更新开关并刷新本群榜单；失败时保持原状态', async () => {
  const calls = []; const toasts = []; let fail = false, infos = 0;
  const { p } = page('group', {
    groupInfo: async () => { infos++; return { name: '群', members: 3, joined: true, owner_id: 1, my_hidden: calls.at(-1)?.[1] === true }; },
    setGroupVisibility: async (id, hidden) => { calls.push([id, hidden]); if (fail) throw new Error('网络错误'); return { my_hidden: hidden }; },
  }, { showToast: o => toasts.push(o.title) });
  p.buildPoster = () => {}; p.onLoad({ g: 'g1', from: 'mine' }); await p.onShow();
  assert.equal(p.data.myHidden, false);
  await p.toggleGroupVisibility({ detail: { value: false } });
  assert.deepEqual(calls[0], ['g1', true]); assert.equal(p.data.myHidden, true); assert.equal(toasts.at(-1), '已在本群隐藏'); assert.ok(infos >= 2);
  fail = true; await p.toggleGroupVisibility({ detail: { value: true } });
  assert.equal(p.data.myHidden, true); assert.equal(toasts.at(-1), '网络错误'); assert.equal(p.data.visibilitySaving, false);
});

test('首次复制接入命令先说明上传内容与开源；确认后复制并不再弹，选看源码复制仓库地址', async () => {
  const modals = [], clips = [];
  const { p } = page('connect', { getConnect: async () => ({ token: 'a'.repeat(32), connected: true, last_report_at: null }) },
    { showModal: o => modals.push(o), setClipboardData: o => clips.push(o.data) });
  p.onLoad({}); await p.onShow();
  p.copyCommand(); assert.equal(modals.length, 1); assert.match(modals[0].content, /不会收集上传/); assert.match(modals[0].content, /开源/); assert.equal(clips.length, 0);
  modals[0].success({ cancel: true }); assert.equal(clips.at(-1), 'https://github.com/xmasdong/tokenrank');
  p.copyCommand(); modals[1].success({ confirm: true }); assert.match(clips.at(-1), /install\.sh/);
  p.copyCommand(); assert.equal(modals.length, 2); assert.match(clips.at(-1), /install\.sh/);
  p.onHide();
});

test('打开小程序就弹自定义隐私与开源说明，可复制仓库地址；接入提醒等它关闭后再弹；不再提示后不弹', async () => {
  require(path.join(root, 'utils/modal-queue.js'))._reset();
  require(path.join(root, 'utils/connect-prompt.js'))._reset();
  const notice = require(path.join(root, 'utils/privacy-notice.js'));
  const prompt = require(path.join(root, 'utils/connect-prompt.js'));
  const store = new Map(), modals = [], clips = [], toasts = [];
  const wx = { getStorageSync: k => store.get(k) || '', setStorageSync: (k, v) => store.set(k, v), showModal: o => modals.push(o),
    setClipboardData: o => { clips.push(o.data); o.success && o.success(); }, showToast: o => toasts.push(o.title) };
  let def; vm.runInNewContext(fs.readFileSync(path.join(root, 'components/privacy-notice/index.js'), 'utf8'),
    { Component: d => def = d, wx, require: id => require(path.join(root, 'components/privacy-notice', id)) });
  const c = { ...def, ...def.methods, data: { ...def.data }, setData(p) { Object.assign(this.data, p); } };
  const wxml = fs.readFileSync(path.join(root, 'components/privacy-notice/index.wxml'), 'utf8');
  assert.match(wxml, /不会收集上传/); assert.match(wxml, /不再提示/); assert.equal(c.data.repo, 'github.com/xmasdong/tokenrank');
  notice.arm(); def.pageLifetimes.show.call(c); assert.equal(c.data.visible, true);
  def.pageLifetimes.show.call(c); // same launch: not claimed twice
  c.copyRepo(); assert.equal(clips.at(-1), 'https://github.com/xmasdong/tokenrank'); assert.match(toasts.at(-1), /已复制/);
  prompt.arm(); prompt.maybePrompt(wx, { user: { user_id: 1 }, hasReported: false, joined: true }, () => {});
  assert.equal(modals.length, 0);
  c.close({ currentTarget: { dataset: { never: '0' } } }); assert.equal(c.data.visible, false);
  assert.equal(modals.length, 1); assert.equal(modals[0].title, '还没有接入电脑'); modals[0].complete({});
  notice.arm(); def.pageLifetimes.show.call(c); assert.equal(c.data.visible, true);
  c.close({ currentTarget: { dataset: { never: '1' } } });
  notice.arm(); def.pageLifetimes.show.call(c); assert.equal(c.data.visible, false);
});

test('所有弹窗按钮文字不超过 4 个字（微信 showModal 超长会直接不弹）', () => {
  const files = ['app.js', ...fs.readdirSync(path.join(root, 'pages')).map(d => `pages/${d}/${d}.js`), ...fs.readdirSync(path.join(root, 'utils')).map(f => `utils/${f}`)];
  const long = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/(confirmText|cancelText):\s*'([^']*)'/g)) if ([...m[2]].length > 4) long.push(`${f} ${m[1]} ${m[2]}`);
  }
  assert.deepEqual(long, []);
});
