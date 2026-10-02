const api = require('./api');

const PERIODS = [
  { key: 'day', label: '今日' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '近30天' },
];

function connection(user, now = Date.now()) {
  const last = user && user.last_report_at;
  const health = user?.sync_health;
  const supported = !!health?.supported;
  let state = supported ? health.state : 'unknown';
  if (supported && state !== 'stopped' && now - health.last_seen_at > 15 * 60000) state = 'unreachable';
  const errors = { SOURCE_READ_FAILED:'读取本机统计失败，请在电脑运行 tokenrank doctor。',
    COLLECTOR_OUTDATED:'统计内核版本过旧，请在电脑运行更新命令。',
    UPLOAD_FAILED:'上传失败，后台会自动重试。', AUTH_INVALID:'接入码已失效，请重新运行本页接入命令。',
    ACCOUNT_DISABLED:'账号已停用。', SYNC_CONFLICT:'有其他数据重建任务，请等待其完成。',
    UPGRADE_REQUIRED:'同步程序版本过旧，请重新运行本页接入命令。',
    RATE_LIMITED:'请求较频繁，后台会自动重试。', CHECK_TIMEOUT:'本次检查超时，后台会重新尝试。',
    PROCESS_EXIT:'本次检查意外退出，后台会重新尝试。' };
  const labels = { online:'同步程序在线', checking:'正在检查本机用量', error:'同步检查失败',
    stopped:health?.error_code==='SERVICE_STOPPED'?'同步服务已停止':'已主动关闭同步', unreachable:'暂时联系不到电脑' };
  const hints = { online:health?.result==='idle'?'已检查，无新增用量。':'每 5 分钟自动检查；用量变化后上传。',
    checking:'正在读取或上传本机统计，完成后自动更新。', error:errors[health?.error_code] || '同步失败，请检查电脑上的同步程序。',
    stopped:'需要恢复时，在电脑重新运行本页接入命令。',
    unreachable:'已超过 15 分钟未收到心跳。电脑可能休眠、断网或同步程序未运行。',
    unknown:last?'当前客户端未上报运行状态。重新运行本页接入命令即可升级。':'运行接入命令后，这里会显示电脑运行状态。' };
  const connState = state==='unknown' ? last?'unknown':'pending' : {online:'live',checking:'live',unreachable:'stale',error:'error',stopped:'stopped'}[state];
  return {
    connState,
    hasReported: !!last,
    connText: labels[state] || (last?'运行状态未知 · 上次上传 '+api.fmtRelTime(last):'等待电脑接入'),
    connHint: hints[state],
    syncTimes: [
      { label:'最近联系', value:health?.last_seen_at ? api.fmtRelTime(health.last_seen_at) : '尚无心跳' },
      { label:'最近检查', value:health?.last_check_at ? api.fmtRelTime(health.last_check_at) : '暂无记录' },
      { label:'最近上传', value:last ? api.fmtRelTime(last) : '尚无用量上传' },
    ],
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
