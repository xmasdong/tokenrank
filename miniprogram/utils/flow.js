const api = require('./api');

const PERIODS = [
  { key: 'day', label: '今日' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '近30天' },
];

function connection(user, now = Date.now()) {
  const last = user && user.last_report_at;
  const connState = !last ? 'pending' : now - last > 3 * 3600000 ? 'stale' : 'live';
  return {
    connState,
    hasReported: !!last,
    connText: !last ? '还没有收到用量'
      : `${connState === 'stale' ? '较久未同步' : '已接入'} · 更新于 ${api.fmtRelTime(last)}`,
  };
}

function connectUrl(id = '') {
  return '/pages/connect/connect' + (id ? `?g=${encodeURIComponent(id)}` : '');
}
function groupUrl(id, from = 'mine') {
  return `/pages/group/group?g=${encodeURIComponent(id)}&from=${from}`;
}
function hasProfile(user) {
  const nickname = String(user?.nickname || '').trim();
  return !!(nickname && [...nickname].length <= 16 && user?.avatar_url);
}
function shareCard() {
  return {
    title: '微信群 Token 用量排名',
    path: '/pages/group/group?enter=1',
    imageUrl: '/assets/share-cover.png',
  };
}
async function resolveCurrentGroup(options = {}, isCurrent = () => true) {
  if (typeof wx.getGroupEnterInfo !== 'function') throw new Error('微信版本过低，无法识别群，请升级微信。');
  const enterInfo = () => new Promise((resolve, reject) => wx.getGroupEnterInfo({ success: resolve,
    fail: () => reject(new Error('没有识别到微信群，请从群里的卡片打开。')) }));
  const resolveWith = async () => {
    if (!isCurrent()) throw new Error('已离开当前页面');
    const info = await enterInfo();
    if (!isCurrent()) throw new Error('已离开当前页面');
    return api.resolveGroup({ ...options, encrypted_data: info.encryptedData, iv: info.iv });
  };
  // A still-valid WeChat session means the server's stored session_key decrypts the ciphertext;
  // skip wx.login + code2session. Otherwise (or if decryption fails) refresh and fetch new ciphertext.
  const fresh = await api.sessionFresh();
  if (!fresh) { await api.relogin(); return resolveWith(); }
  try { return await resolveWith(); }
  catch (err) {
    if (err.statusCode !== 400 || !/解密失败|会话密钥/.test(err.message || '')) throw err;
    await api.relogin();
    return resolveWith();
  }
}
// Scene 1007: card opened from a one-to-one chat, which has no group identity.
function enteredFromPrivateChat() {
  try {
    const entry = typeof wx.getEnterOptionsSync === 'function' ? wx.getEnterOptionsSync() : null;
    return entry?.scene === 1007;
  } catch { return false; }
}
/** Name of the group a card was shared from; display only, never used for binding. */
function sourceName(options = {}) {
  let value = String(options.src || '');
  try { value = decodeURIComponent(value); } catch {}
  return [...value.trim()].slice(0, 30).join('');
}
function enteredFromGroup() {
  try {
    const entry = typeof wx.getEnterOptionsSync === 'function' ? wx.getEnterOptionsSync() : null;
    return entry?.scene === 1044 || !!entry?.shareTicket;
  } catch { return false; }
}
module.exports = { PERIODS, connection, connectUrl, groupUrl, hasProfile, shareCard, resolveCurrentGroup, enteredFromGroup, enteredFromPrivateChat, sourceName };
