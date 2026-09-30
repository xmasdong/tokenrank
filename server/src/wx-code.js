import { jsonError } from './lib.js';

// Official codes carry only a random share ID, never a user ID or credential.
const PAGE = 'pages/index/index';
const SCENE = 'usage_share';
const CODE_TTL = 7 * 86400;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TOKEN_EXPIRED = new Set([40001, 40014, 42001]);

function error(message) { return new Error(message); }
function upstreamMessage(code) {
  if (code === 41030) return '小程序码暂不可用，请先发布小程序对应页面';
  if (code === 40164) return '小程序码服务需配置微信接口 IP 白名单';
  if (code === 45009) return '小程序码请求达到微信限额，请稍后重试';
  return '微信小程序码暂时获取失败，请稍后重试';
}
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function imageType(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return null;
}

/** Isolated service state also lets tests exercise caching and token expiry. */
export function createWxCodeService({ fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const tokens = new Map(), codes = new Map(), pending = new Map();
  async function accessToken(env, refreshLocal = false) {
    const saved = tokens.get(env.WX_APPID);
    if (!refreshLocal && saved && saved.secret === env.WX_APPSECRET && saved.expires > now()) return saved.token;
    let response;
    try {
      response = await fetcher('https://api.weixin.qq.com/cgi-bin/stable_token', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        // Re-read the stable token on expiry without invalidating tokens held by other workers.
        body: JSON.stringify({ grant_type: 'client_credential', appid: env.WX_APPID, secret: env.WX_APPSECRET, force_refresh: false }),
      });
    } catch { throw error('连接微信服务超时，请稍后重试'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) throw error(upstreamMessage(data.errcode));
    tokens.set(env.WX_APPID, { token: data.access_token, secret: env.WX_APPSECRET,
      expires: now() + Math.max(0, (Number(data.expires_in) || 7200) - 120) * 1000 });
    return data.access_token;
  }
  async function generate(env, version, shareId, mode) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(env, attempt > 0);
      let response;
      try {
        response = await fetcher(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ scene: shareId ? `s=${shareId}&m=${mode[0]}` : SCENE, page: shareId ? 'pages/record/record' : PAGE, env_version: version, check_path: version === 'release',
            width: 430, auto_color: false, line_color: { r: 0, g: 0, b: 0 }, is_hyaline: false }),
        });
      } catch { throw error('连接微信服务超时，请稍后重试'); }
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw error('微信小程序码图片异常，请重试');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw error('微信小程序码图片异常，请重试');
      const type = imageType(bytes);
      if (response.ok && type) return { image_base64: base64(bytes), mime_type: type, page: shareId ? 'pages/record/record' : PAGE, env_version: version };
      let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { data = {}; }
      if (attempt === 0 && TOKEN_EXPIRED.has(data.errcode)) continue;
      throw error(upstreamMessage(data.errcode));
    }
  }
  const success = data => Response.json(data, { headers: { 'cache-control': `public, max-age=${CODE_TTL}` } });
  return async function shareCode(env, origin, cache, shareId = null, mode = 'achievement') {
    if (shareId && !/^[0-9a-f]{24}$/.test(shareId)) return jsonError(400, '分享记录标识无效');
    if (!['achievement', 'streak', 'tool'].includes(mode)) return jsonError(400, '分享主题无效');
    if (!env.WX_APPID || !env.WX_APPSECRET) return jsonError(503, '小程序码服务未配置，请配置微信 AppID 和 AppSecret');
    const version = env.WX_CODE_ENV_VERSION || 'release';
    if (!['release', 'trial', 'develop'].includes(version)) return jsonError(503, '小程序码版本配置无效');
    const key = `${env.WX_APPID}/${version}/usage-v3/${shareId ? shareId + '/' + mode : 'home'}`;
    const request = new Request(`${origin}/.cache/wx-code/${encodeURIComponent(key)}`);
    try {
      const local = codes.get(key);
      if (local && local.expires > now()) return success(local.data);
      if (cache) {
        const stored = await cache.match(request).catch(() => null);
        if (stored && stored.ok) return stored;
      }
      let work = pending.get(key);
      if (!work) {
        work = generate(env, version, shareId, mode).then(async data => {
          if (codes.size >= 128) codes.delete(codes.keys().next().value);
          codes.set(key, { data, expires: now() + CODE_TTL * 1000 });
          if (cache) await cache.put(request, success(data)).catch(() => {});
          return data;
        });
        pending.set(key, work);
        work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
      }
      return success(await work);
    } catch (err) {
      // Only our fixed messages cross the boundary, never upstream URLs or secrets.
      return jsonError(502, err.message.startsWith('微信') || err.message.startsWith('小程序码') || err.message.startsWith('连接微信')
        ? err.message : '小程序码暂时不可用，请稍后重试');
    }
  };
}
export const shareCode = createWxCodeService();
