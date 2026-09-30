const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(initial = [['session_token', 'old-session'], ['account_known', true]]) {
  const store = new Map(initial), requests = [], logins = [], uploads = [], navigation = [];
  const wx = { getStorageSync: k => store.get(k), setStorageSync: (k,v) => store.set(k,v), removeStorageSync: k => store.delete(k), clearStorageSync: () => store.clear(),
    request: o => requests.push(o), login: o => logins.push(o), uploadFile: o => uploads.push(o), reLaunch: o => navigation.push(o.url) };
  const module = { exports:{} };
  vm.runInNewContext(fs.readFileSync(path.join(root,'utils/api.js'),'utf8'), { wx, module,
    require: id => require(path.join(root,'utils',path.basename(id))) });
  return { api:module.exports,store,requests,logins,uploads,wx,navigation };
}
const reply = (req,data,statusCode=200) => req.success({statusCode,data});

test('注销清空本地数据，阻止迟到的成功/401响应和所有静默重登',async()=>{
  const f=fixture(); f.store.set('cached-user','private');
  const late=f.api.myUsage('day'); const lateResult=assert.rejects(late,/重新登录/);
  const upload=f.api.uploadProfile('旧昵称','old.png'); const uploadResult=assert.rejects(upload,/重新登录/);
  await flush();
  const deletion=f.api.deleteAccount(); await flush();
  assert.equal(f.api.accountState(),'pending'); assert.equal(f.requests.at(-1).method,'DELETE');
  assert.equal(f.requests.at(-1).header.authorization,'Bearer old-session');
  const duplicate=f.api.deleteAccount(); assert.equal(deletion,duplicate);
  reply(f.requests.at(-1),{deleted:true}); await deletion;
  assert.equal(f.api.accountState(),'deleted');
  assert.deepEqual([...f.store],[['account_state','deleted']]);
  reply(f.requests[0],{error:'unauthorized'},401);
  f.uploads[0].success({statusCode:200,data:JSON.stringify({nickname:'旧昵称'})});
  await lateResult; await uploadResult;
  await assert.rejects(f.api.ensureSession(),/重新登录/); await assert.rejects(f.api.relogin(),/重新登录/);
  assert.equal(f.logins.length,0); assert.equal(f.api.peekUsage('day'),null); assert.equal(f.api.peekMe(),null);
  const restarted=fixture([...f.store]); await assert.rejects(restarted.api.ensureLogin(),/重新登录/);
  assert.equal(restarted.logins.length,0);
  // Public records still work without signing up.
  const shared=f.api.sharedRecord('abc'); reply(f.requests.at(-1),{public:true}); assert.equal((await shared).public,true);
});

test('注销等待正在进行的会话刷新，删除使用新凭证；成功后必须主动登录才能新建账号',async()=>{
  const f=fixture();
  const login=f.api.relogin(); f.logins[0].success({code:'fresh-code'});
  assert.equal(f.requests[0].data.existing_only,true);
  const deletion=f.api.deleteAccount(); await flush();
  assert.equal(f.requests.length,1);
  reply(f.requests[0],{token:'fresh-session',user:{user_id:1}}); await login; await flush();
  assert.equal(f.requests[1].header.authorization,'Bearer fresh-session');
  reply(f.requests[1],{deleted:true}); await deletion;
  const fresh=f.api.startNewAccount(); f.logins[1].success({code:'new-code'});
  assert.equal(f.requests[2].data.existing_only,false);
  reply(f.requests[2],{token:'new-session',user:{user_id:2}}); await fresh;
  assert.equal(f.api.accountState(),''); assert.equal(f.store.get('session_token'),'new-session'); assert.equal(f.api.peekMe().user_id,2);
});

test('旧手机的401刷新只查现有账号，收到注销状态后清理并跳转',async()=>{
  const f=fixture(); const req=f.api.myUsage(); const rejected=assert.rejects(req,/账号已注销/);
  reply(f.requests[0],{},401); await flush(); f.logins[0].success({code:'old-phone'});
  assert.equal(f.requests[1].data.existing_only,true);
  reply(f.requests[1],{error:'账号已注销',code:'ACCOUNT_DELETED'},410); await rejected;
  assert.equal(f.api.accountState(),'deleted'); assert.equal(f.store.has('session_token'),false);
  assert.deepEqual(f.navigation,['/pages/account/account']); assert.equal(f.requests.length,2);
});

test('网络中断不宣称注销成功，重试不自动登录；失效凭证可只查现有账号确认结果',async()=>{
  const f=fixture(); const first=f.api.deleteAccount(); const firstRejected=assert.rejects(first,/timeout/); await flush();
  f.requests[0].fail({errMsg:'timeout'}); await firstRejected;
  assert.equal(f.api.accountState(),'pending'); assert.equal(f.store.get('session_token'),'old-session');
  await assert.rejects(f.api.ensureLogin(),/重新登录/);
  const retry=f.api.deleteAccount(); const retryRejected=assert.rejects(retry,/失效/); await flush();
  reply(f.requests[1],{error:'登录已失效'},401); await retryRejected;
  const check=f.api.startNewAccount(); const checkRejected=assert.rejects(check,/账号已注销/);
  f.logins[0].success({code:'check-only'}); assert.equal(f.requests[2].data.existing_only,true);
  reply(f.requests[2],{error:'账号已注销',code:'ACCOUNT_DELETED'},410); await checkRejected;
  assert.equal(f.api.accountState(),'deleted'); assert.equal(f.logins.length,1);
});

test('注销事务明确失败保留登录以便重试，主动登录网络失败不会误报账号已删',async()=>{
  const f=fixture(); const deletion=f.api.deleteAccount(); const rejected=assert.rejects(deletion,/internal error/); await flush();
  reply(f.requests[0],{error:'internal error'},500); await rejected;
  assert.equal(f.api.accountState(),''); assert.equal(f.store.get('session_token'),'old-session');
  const p=fixture([['session_token','old-session'],['account_state','pending']]);
  const login=p.api.startNewAccount(); const failed=assert.rejects(login,/network/); p.logins[0].fail({errMsg:'network'}); await failed;
  assert.equal(p.api.accountState(),'pending');
});

function accountPage(api) {
  let def; const modals=[],navigation=[];
  const wx={showModal:o=>modals.push(o),reLaunch:o=>navigation.push(o.url)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'pages/account/account.js'),'utf8'),{wx,Page:v=>def=v,require:()=>api});
  const p={...def,data:structuredClone(def.data),setData(v){Object.assign(this.data,v);}};
  return {p,modals,navigation};
}
test('注销页取消不请求，重复点击只有一个确认框；成功后重建页面栈',async()=>{
  let deleted=0,state='';
  const {p,modals,navigation}=accountPage({accountState:()=>state,deleteAccount:async()=>{deleted++;state='deleted';}});
  p.onShow(); p.confirmDeletion(); p.confirmDeletion(); assert.equal(modals.length,1);
  modals[0].success({confirm:false}); modals[0].complete(); assert.equal(deleted,0);
  p.confirmDeletion(); modals[1].success({confirm:true}); modals[1].complete(); await flush();
  assert.equal(deleted,1); assert.deepEqual(navigation,['/pages/account/account']);
  p.onShow(); assert.equal(p.data.state,'deleted'); p.confirmDeletion(); assert.equal(modals.length,2);
});

test('注销页失败保持可重试状态，不展示删除成功',async()=>{
  const {p,navigation}=accountPage({accountState:()=> 'pending',deleteAccount:async()=>{throw new Error('timeout');}});
  await p.removeAccount(); assert.equal(p.data.state,'pending'); assert.match(p.data.error,/暂未收到注销结果/);
  assert.equal(p.data.busy,false); assert.equal(navigation.length,0);
});

test('冷启动注销状态只进入结果页，不弹接入或隐私引导，也不自动登录',()=>{
  let app;const navigation=[];
  vm.runInNewContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),{App:v=>app=v,getCurrentPages:()=>[],wx:{reLaunch:o=>navigation.push(o.url)},
    require:id=>id.endsWith('/api')?{accountState:()=> 'deleted',clearAvatarFiles(){}}:{arm:()=>assert.fail('should not prompt')}});
  app.onShow(); assert.deepEqual(navigation,['/pages/account/account']);
  navigation.length=0; app.onShow({path:'pages/record/record'}); assert.deepEqual(navigation,[]);
});

test('注销清理持久化头像文件；迟到的头像下载不能重新留下缓存',async()=>{
  const f=fixture(),removed=[];
  f.wx.env={USER_DATA_PATH:'/sandbox'};
  f.wx.getFileSystemManager=()=>({readdirSync:()=>['tokenrank-card-avatar-private.png','unrelated-file'],unlinkSync:p=>removed.push(p),writeFile:()=>assert.fail('must not save a late avatar')});
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'utils/share-avatar.js'),'utf8'),{wx:f.wx,module,require:()=>f.api});
  const avatar=module.exports.loadAvatarImage({},f.api.BASE_URL+'/avatars/private.png');
  const deletion=f.api.deleteAccount(); await flush(); reply(f.requests[1],{deleted:true});await deletion;
  reply(f.requests[0],new ArrayBuffer(1));assert.equal(await avatar,null);
  assert.deepEqual(removed,['/sandbox/tokenrank-card-avatar-private.png']);
});
