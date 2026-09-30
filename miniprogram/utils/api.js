/**
 * 「Token 群排名」API 封装。
 *
 * BASE_URL 部署后改成你的备案域名（微信后台「request 合法域名」同时要配它）。
 * 本地联调：BASE_URL = 'http://127.0.0.1:8799'，开发者工具勾选
 * 「详情 → 本地设置 → 不校验合法域名」。
 */
const BASE_URL = 'https://tokenrank.xmasdong.cn';
const { formatTokens: fmtTokens } = require('./usage');

const KEY = 'session_token';
const ACCOUNT_STATE_KEY = 'account_state';
const KNOWN_ACCOUNT_KEY = 'account_known';
let sessionToken = wx.getStorageSync(KEY) || '';
let knownAccount = !!sessionToken || wx.getStorageSync(KNOWN_ACCOUNT_KEY) === true;
let accountState = ['pending', 'deleted'].includes(wx.getStorageSync(ACCOUNT_STATE_KEY)) ? wx.getStorageSync(ACCOUNT_STATE_KEY) : '';
let authEpoch = 0;
let loginPromise = null;
let deletionPromise = null;
const READ_TTL = 60_000;
const readCache = new Map();
const pendingReads = new Map();
let readEpoch = 0;
let readDay = '';

function invalidateReads() { readEpoch++; readCache.clear(); pendingReads.clear(); }
function authError() { const error = new Error('请重新登录后使用'); error.code = 'ACCOUNT_INACTIVE'; return error; }
function assertActive(epoch = authEpoch) { if (accountState || epoch !== authEpoch) throw authError(); }
function clearAvatarFiles() {
  if (!wx.getFileSystemManager || !wx.env?.USER_DATA_PATH) return;
  const fs = wx.getFileSystemManager(), root = wx.env.USER_DATA_PATH;
  try {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('tokenrank-card-avatar-')) {
        try { fs.unlinkSync(root + '/' + name); } catch { /* Retry on next launch. */ }
      }
    }
  } catch { /* No avatar files may have been written yet. */ }
}
function markDeleted(redirect = false) {
  authEpoch++;
  sessionToken = '';
  knownAccount = false;
  accountState = 'deleted';
  invalidateReads();
  // This only clears this mini-program's storage, not WeChat or computer files.
  wx.clearStorageSync();
  wx.setStorageSync(ACCOUNT_STATE_KEY, accountState);
  clearAvatarFiles();
  if (redirect && wx.reLaunch) wx.reLaunch({ url: '/pages/account/account' });
}
function cacheKey(path) {
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (day !== readDay) { readDay = day; invalidateReads(); }
  return sessionToken + ':' + path;
}
function peek(path) {
  const item = readCache.get(cacheKey(path));
  return item && Date.now() - item.at < READ_TTL ? item.value : null;
}
function read(path, options = {}) {
  const key = cacheKey(path);
  if (options.force !== true) {
    const value = peek(path);
    if (value) return Promise.resolve(value);
  } else readCache.delete(key);
  if (pendingReads.has(key)) return pendingReads.get(key);
  const epoch = readEpoch;
  const task = request(path).then(value => {
    const currentKey = cacheKey(path);
    if (epoch === readEpoch && key === currentKey) {
      // Bound memory when a user opens many groups in one session.
      if (readCache.size >= 100) readCache.delete(readCache.keys().next().value);
      readCache.set(key, { value, at: Date.now() });
    }
    return value;
  }).finally(() => { if (pendingReads.get(key) === task) pendingReads.delete(key); });
  pendingReads.set(key, task);
  return task;
}
async function mutate(path, options) {
  const result = await request(path, options);
  invalidateReads();
  return result;
}
const usagePath = period => `/api/my/usage?period=${encodeURIComponent(period || 'day')}`;
const rankingsPath = period => `/api/my/rankings?period=${encodeURIComponent(period || 'day')}`;
const groupPath = id => `/api/groups/${encodeURIComponent(id)}`;
const boardPath = ({ scope = 'global', id = '', period = 'day', offset = 0, snapshot = '' } = {}) =>
  `/api/leaderboard?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ''}&period=${period}` +
  (offset ? `&offset=${encodeURIComponent(offset)}&snapshot=${encodeURIComponent(snapshot)}` : '');

function rawRequest(path, { method = 'GET', data = null, auth = true, header = {}, timeout = 15000, deleting = false } = {}) {
  const epoch = authEpoch;
  if (auth && !deleting) { try { assertActive(); } catch (err) { return Promise.reject(err); } }
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      timeout,
      data: data ?? undefined,
      header: {
        'content-type': 'application/json',
        ...(auth && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...header,
      },
      success: (res) => {
        if (auth && !deleting && (accountState || epoch !== authEpoch)) { reject(authError()); return; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else {
          const error = new Error((res.data && res.data.error) || `HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.code = res.data && res.data.code;
          reject(error);
        }
      },
      fail: (err) => reject(new Error(err.errMsg || '网络请求失败')),
    });
  });
}

/** wx.login → code2session 换会话 token（静默，无授权弹窗） */
function login() {
  try { assertActive(); } catch (err) { return Promise.reject(err); }
  if (loginPromise) return loginPromise;
  const epoch = authEpoch;
  loginPromise = new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (accountState || epoch !== authEpoch) { reject(authError()); return; }
        rawRequest('/api/wx/session', { method: 'POST', data: { code: res.code, existing_only: knownAccount }, auth: false })
          .then((data) => {
            assertActive(epoch);
            sessionToken = data.token;
            knownAccount = true;
            invalidateReads();
            wx.setStorageSync(KEY, sessionToken);
            wx.setStorageSync(KNOWN_ACCOUNT_KEY, true);
            readCache.set(cacheKey('/api/me'), { value: data.user, at: Date.now() });
            loginPromise = null;
            resolve(data.user);
          })
          .catch((err) => { if (err.code === 'ACCOUNT_DELETED' && !accountState) markDeleted(true); loginPromise = null; reject(err); });
      },
      fail: (err) => { loginPromise = null; reject(new Error(err.errMsg || 'wx.login 失败')); },
    });
  });
  return loginPromise;
}

/** 强制重登：刷新 session_key（服务端解密群身份需要新鲜密钥） */
function relogin() {
  try { assertActive(); } catch (err) { return Promise.reject(err); }
  invalidateReads();
  if (knownAccount) wx.setStorageSync(KNOWN_ACCOUNT_KEY, true);
  sessionToken = '';
  wx.removeStorageSync(KEY);
  return login();
}

/** 本地会话仍有效（有 token 且微信登录态未过期）时，服务端保存的 session_key 可直接解密群信息，省去重登 */
function sessionFresh() {
  if (!sessionToken || typeof wx.checkSession !== 'function') return Promise.resolve(false);
  return new Promise(resolve => wx.checkSession({ success: () => resolve(true), fail: () => resolve(false) }));
}

/** 带 401 自动重登一次的请求 */
async function request(path, options = {}) {
  const epoch = authEpoch;
  const sentWith = sessionToken;
  try {
    return await rawRequest(path, options);
  } catch (err) {
    if (options.auth !== false) assertActive(epoch);
    if (options.auth !== false && err.code === 'ACCOUNT_DELETED') { markDeleted(true); throw err; }
    if (options.auth !== false && err.statusCode === 401) {
      if (sessionToken === sentWith) await relogin();
      else await ensureSession();
      return rawRequest(path, options);
    }
    throw err;
  }
}

/** 页面入口统一调用：拿到会话与用户资料 */
async function ensureSession() {
  assertActive();
  if (!sessionToken) await login();
}
async function ensureLogin(options = {}) {
  await ensureSession();
  return read('/api/me', options);
}

function rawUploadProfile(nickname, filePath) {
  const epoch = authEpoch;
  try { assertActive(); } catch (err) { return Promise.reject(err); }
  return new Promise((resolve, reject) => {
    wx.uploadFile({ url: BASE_URL + '/api/profile', filePath, name: 'avatar',
      formData: { nickname }, timeout: 30000,
      header: { authorization: `Bearer ${sessionToken}` },
      success(res) {
        if (accountState || epoch !== authEpoch) { reject(authError()); return; }
        let body;
        try { body = JSON.parse(res.data); } catch { reject(new Error('资料保存响应异常，请重试')); return; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else { const err = new Error(body.error || `HTTP ${res.statusCode}`); err.statusCode = res.statusCode; reject(err); }
      },
      fail: err => reject(new Error(err.errMsg || '头像上传失败，请重试')),
    });
  });
}

async function uploadProfile(nickname, filePath) {
  const epoch = authEpoch;
  assertActive();
  // Native avatar selection returns a temporary local file, never a durable avatar URL.
  const compressed = await new Promise(resolve => {
    if (!wx.compressImage) { resolve(filePath); return; }
    wx.compressImage({ src: filePath, quality: 75, compressedWidth: 256, compressedHeight: 256,
      success: res => resolve(res.tempFilePath || filePath), fail: () => resolve(filePath) });
  });
  assertActive(epoch);
  try { const user = await rawUploadProfile(nickname, compressed); invalidateReads(); return user; }
  catch (err) {
    assertActive(epoch);
    if (err.statusCode !== 401) throw err;
    await relogin();
    const user = await rawUploadProfile(nickname, compressed);
    invalidateReads();
    return user;
  }
}

/** Freeze automatic login while deletion is in flight, including uncertain network results. */
function deleteAccount() {
  if (deletionPromise) return deletionPromise;
  if (accountState === 'deleted') return Promise.resolve({ deleted: true });
  const task = (async () => {
    if (accountState !== 'pending') {
      if (loginPromise) await loginPromise;
      await ensureSession();
      authEpoch++;
      accountState = 'pending';
      wx.setStorageSync(ACCOUNT_STATE_KEY, accountState);
      invalidateReads();
    }
    try {
      // Never refresh credentials and silently sign up while retrying a deletion.
      const result = await rawRequest('/api/account', { method: 'DELETE', data: { confirm: 'DELETE_ACCOUNT' }, deleting: true, timeout: 30000 });
      if (result.deleted !== true) throw new Error('未收到注销确认，请重试');
      markDeleted();
      return result;
    } catch (err) {
      // A definite rejection leaves the account usable; network failures may have committed.
      if ([400, 403, 409, 500, 503].includes(err.statusCode)) {
        accountState = '';
        wx.removeStorageSync(ACCOUNT_STATE_KEY);
      }
      throw err;
    }
  })();
  deletionPromise = task;
  task.then(() => { deletionPromise = null; }, () => { deletionPromise = null; });
  return task;
}

/** Only an explicit user action may create a new account after deletion. */
async function startNewAccount() {
  if (deletionPromise) throw new Error('正在注销，请稍候');
  const previousState = accountState;
  authEpoch++;
  accountState = '';
  // An uncertain deletion is checked using an existing-only login; never create
  // a replacement account merely to find out whether the old one was deleted.
  knownAccount = previousState === 'pending';
  sessionToken = '';
  loginPromise = null;
  invalidateReads();
  wx.removeStorageSync(KEY);
  wx.removeStorageSync(KNOWN_ACCOUNT_KEY);
  // Keep the persisted deletion state until login succeeds, even if the app
  // closes while checking an uncertain deletion.
  try {
    const user = await login();
    wx.removeStorageSync(ACCOUNT_STATE_KEY);
    return user;
  }
  catch (err) {
    accountState = err.code === 'ACCOUNT_DELETED' ? 'deleted' : previousState;
    wx.setStorageSync(ACCOUNT_STATE_KEY, accountState);
    throw err;
  }
}

/** 相对时间：榜单「更新于 x 前」 */
function fmtRelTime(ts) {
  if (!ts) return '';
  const d = Date.now() - Number(ts);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前';
  const days = Math.floor(d / 86_400_000);
  if (days === 1) return '昨天';
  if (days < 7) return days + ' 天前';
  return new Date(ts).toISOString().slice(5, 10);
}

/** 排名序号统一用阿拉伯数字；前三名保留印章徽记样式 */
/** 昵称首字，用作无头像时的占位 */
function initialOf(name) { return [...String(name || '').trim()][0] || '?'; }

function cnRank(n) {
  return { label: String(n), top3: n >= 1 && n <= 3 };
}

module.exports = {
  BASE_URL,
  fmtTokens,
  fmtRelTime,
  cnRank,
  initialOf,
  ensureLogin,
  ensureSession,
  relogin,
  sessionFresh,
  accountState: () => accountState,
  accountEpoch: () => authEpoch,
  clearAvatarFiles,
  deleteAccount,
  startNewAccount,
  peekMe: () => peek('/api/me'),
  peekUsage: period => peek(usagePath(period)),
  peekRankings: period => peek(rankingsPath(period)),
  peekGroup: id => peek(groupPath(id)),
  peekLeaderboard: query => peek(boardPath(query)),
  createShare: period => request('/api/shares', { method: 'POST', data: { period } }),
  sharedRecord: id => request('/api/shares/' + encodeURIComponent(id), { auth: false }),
  revokeShare: id => request('/api/shares/' + encodeURIComponent(id) + '/revoke', { method: 'POST' }),

  /** 个人用量：不依赖群成员身份或榜单名次。 */
  myUsage: (period = 'day', options) => read(usagePath(period), options),

  /** 我的全部群排名 + 广场对照（每群：群内名次/广场名次/更新时间） */
  myRankings: (period = 'day', options) => read(rankingsPath(period), options),

  /** 全局/群榜单：scope=global|group, period=day|week|month|all */
  fetchLeaderboard: (query, options) => read(boardPath(query), options),

  /** 资料完善（昵称填写能力：input type=nickname 快捷填入微信昵称） */
  setProfile: (nickname) => mutate('/api/profile', { method: 'POST', data: { nickname } }),
  /** 关闭或恢复排名：只影响榜单展示，自己的用量照常可见 */
  setRanking: (hidden) => mutate('/api/profile/ranking', { method: 'POST', data: { hidden } }),
  /** 只在某个群隐藏或显示自己的排名 */
  setGroupVisibility: (id, hidden) => mutate(`/api/groups/${encodeURIComponent(id)}/visibility`, { method: 'POST', data: { hidden } }),
  uploadProfile,

  /** 接入码：GET 查看（不轮换）/ POST 重置（作废旧码） */
  getConnect: async () => {
    const state = await request('/api/connect/token');
    const user = peek('/api/me');
    if (user && user.last_report_at !== state.last_report_at) invalidateReads();
    return state;
  },
  rotateConnect: () => mutate('/api/connect/token', { method: 'POST' }),

  /** 群 */
  /** 先识别群并预览；用户确认后携带 confirm 和 expected_group_ref 加入。 */
  resolveGroup: (payload) => (payload.confirm ? mutate : request)('/api/groups/resolve', { method: 'POST', data: payload }),
  /** 发起者改名 */
  renameGroup: (id, name) => mutate(`/api/groups/${id}/rename`, { method: 'POST', data: { name } }),
  groupInfo: (id, options) => read(groupPath(id), options),
  myGroups: () => request('/api/groups/mine'),
};
