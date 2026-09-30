import {
  hexToken, groupId, beijingDay, beijingDaysAgo as daysAgo, sanitizeName, sanitizeGroupName,
  jsonError, bearerToken,
} from './lib.js';
import { storeTotalReport } from './report.js';
import { usageWindow, buildUsage, buildActivity } from './usage.js';
import { shareCode } from './wx-code.js';
import { readShare, createShare } from './shares.js';
import { profileBody, parseAvatar, avatarResponse } from './avatar.js';

/**
 * 「Token 群排名」Cloudflare Worker。
 *
 * 绑定（wrangler.toml）：
 *   DB       — D1（schema.sql）
 * vars：
 *   WX_APPID             — 小程序 appid
 *   ALLOW_DEV_LOGIN      — "1" 时允许开发登录（未配 WX_APPSECRET 的联调模式，上线必须移除）
 * secrets（wrangler secret put）：
 *   WX_APPSECRET         — 小程序密钥；配置后 /api/wx/session 走真实 code2session
 *
 * 安全模型：
 *   - 小程序接口：Bearer = mp_sessions.token（wx.login 换发）
 *   - 采集上报：Bearer = connect_tokens.token（接入码即凭证，可重置）
 *   - 只存聚合数字；原版总量日桶按来源快照更新，允许历史纠正
 */

const MP_SESSION_TTL_MS = 30 * 86_400_000;
const REPORT_MIN_INTERVAL_MS = 20_000;
const MAX_REPORT_BODY = 512 * 1024;
const LEADERBOARD_LIMIT = 50;
// 新建群榜的默认名；仍是默认名时视为“未起名”，所有成员都可以起一次名。
const DEFAULT_GROUP_NAME = '本群 Token 排名';
const completeProfile = user => !!(sanitizeName(user?.nickname) && user?.avatar_path);
const profileRequired = () => Response.json({ error: '请先保存微信头像和昵称，再参与群排名', code: 'PROFILE_REQUIRED' }, { status: 428 });
// Profile completion is an onboarding step, not a filter on existing members' usage.
// Members who hid themselves in this group do not count in its rankings.
const groupMembers = parameter => `SELECT user_id FROM rank_group_members WHERE group_id=${parameter} AND hidden=0`;

// 反代场景下回源 Host 是 workers.dev，request.url 的 origin 不是用户可见域名；
// 用 PUBLIC_BASE_URL 指定正式域名（生成接入命令等用户可见 URL 时优先用它）。
function userOrigin(env, request) {
  return env.PUBLIC_BASE_URL || new URL(request.url).origin;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      return await route(request, env, url, path) ?? jsonError(404, 'not found');
    } catch (err) {
      console.error('unhandled:', err?.message);
      return jsonError(500, 'internal error');
    }
  },
};

async function route(request, env, url, path) {
  const method = request.method;
  const withCors = (res) => new Response(res.body, { status: res.status, headers: { ...CORS, ...Object.fromEntries(res.headers) } });

  if (method === 'GET' && path === '/healthz') {
    await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    return withCors(Response.json({ ok: true, day: beijingDay() }));
  }

  // ---- 小程序身份 ----
  if (method === 'POST' && path === '/api/wx/session') return withCors(await wxSession(request, env));
  if (method === 'GET' && path === '/api/wx/share-code') {
    const id = url.searchParams.get('share');
    if (id && !await readShare(env, id)) return withCors(jsonError(404, '分享记录已失效或已被取消'));
    return withCors(await shareCode(env, url.origin, typeof caches === 'undefined' ? null : caches.default, id || null, url.searchParams.get('mode') || 'achievement'));
  }
  if (method === 'POST' && path === '/api/shares') {
    const user = await sessionUser(request, env);
    if (!user) return withCors(jsonError(401, '请先登录'));
    const body = await readJson(request);
    const usageUrl = new URL(request.url); usageUrl.searchParams.set('period', body?.period || 'day');
    const result = await myUsage(request, env, usageUrl);
    if (!result.ok) return withCors(result);
    const usage = await result.json();
    if (!usage.has_history) return withCors(jsonError(400, '先同步一份用量，再生成分享记录'));
    return withCors(await createShare(env, await publicUser(env, user.id, userOrigin(env, request)), usage));
  }
  if (method === 'GET' && path.startsWith('/api/shares/')) {
    const shared = await readShare(env, path.slice('/api/shares/'.length));
    return withCors(shared ? Response.json(shared) : jsonError(404, '分享记录已失效或已被取消'));
  }
  if (method === 'POST' && /^\/api\/shares\/[0-9a-f]{24}\/revoke$/.test(path)) {
    const user = await sessionUser(request, env);
    if (!user) return withCors(jsonError(401, '请先登录'));
    const id = path.split('/')[3];
    const row = await env.DB.prepare('SELECT user_id FROM usage_shares WHERE id=?1').bind(id).first();
    if (!row || row.user_id !== user.id) return withCors(jsonError(404, '分享记录不存在'));
    await env.DB.prepare('UPDATE usage_shares SET revoked_at=?1 WHERE id=?2').bind(Date.now(), id).run();
    return withCors(Response.json({ ok: true }));
  }
  if (method === 'GET' && path === '/api/me') return withCors(await me(request, env));
  if (method === 'POST' && path === '/api/profile') return withCors(await setProfile(request, env));
  if (method === 'POST' && path === '/api/profile/ranking') return withCors(await setRanking(request, env));
  if (method === 'GET' && path.startsWith('/avatars/')) return withCors(await avatarResponse(env, path.slice('/avatars/'.length)));

  // ---- 采集接入 ----
  if (method === 'GET' && path === '/api/connect/token') return withCors(await getConnectToken(request, env));
  if (method === 'POST' && path === '/api/connect/token') return withCors(await createConnectToken(request, env));
  if (method === 'GET' && path === '/report/capabilities') return withCors(Response.json({ atomic_replace: 1 }));
  if (method === 'POST' && path === '/report') return withCors(await report(request, env));

  // ---- 群 ----
  if (method === 'POST' && path === '/api/groups') return withCors(await createGroup(request, env));
  if (method === 'POST' && path === '/api/groups/resolve') return withCors(await resolveGroup(request, env));
  if (method === 'POST' && path === '/api/groups/join') return withCors(await joinGroup(request, env));
  if (method === 'POST' && /^\/api\/groups\/[a-z0-9]+\/rename$/.test(path)) return withCors(await renameGroup(request, env, path));
  if (method === 'POST' && /^\/api\/groups\/[a-z0-9]+\/visibility$/.test(path)) return withCors(await setGroupVisibility(request, env, path));
  if (method === 'GET' && path === '/api/groups/mine') return withCors(await myGroups(request, env));
  if (method === 'GET' && path.startsWith('/api/groups/')) return withCors(await groupInfo(request, env, path));

  // ---- 榜单 ----
  if (method === 'GET' && path === '/api/my/usage') return withCors(await myUsage(request, env, url));
  if (method === 'GET' && path === '/api/my/rankings') return withCors(await myRankings(request, env, url));
  if (method === 'GET' && path === '/api/leaderboard') return withCors(await leaderboard(request, env, url));

  return null;
}

// ================= 小程序身份 =================

async function wxSession(request, env) {
  const body = await readJson(request);
  if (!body) return jsonError(400, 'invalid json');
  const code = String(body.code ?? '').trim();
  if (!code || code.length > 256) return jsonError(400, 'code required');

  let openid;
  let sessionKey = null;
  if (env.WX_APPID && env.WX_APPSECRET) {
    const api = new URL('https://api.weixin.qq.com/sns/jscode2session');
    api.searchParams.set('appid', env.WX_APPID);
    api.searchParams.set('secret', env.WX_APPSECRET);
    api.searchParams.set('js_code', code);
    api.searchParams.set('grant_type', 'authorization_code');
    const res = await fetch(api);
    const data = await res.json().catch(() => ({}));
    if (!data.openid) return jsonError(401, `微信登录失败：${data.errcode ?? ''} ${data.errmsg ?? 'unknown'}`);
    openid = data.openid;
    sessionKey = data.session_key ?? null;
  } else if (env.ALLOW_DEV_LOGIN === '1') {
    // 联调模式：code 即 openid（上线前必须配置 WX_APPSECRET 并移除 ALLOW_DEV_LOGIN）
    openid = 'dev:' + code.replace(/[^\w-]/g, '').slice(0, 64);
    if (!openid.slice(4)) return jsonError(400, 'code required');
  } else {
    return jsonError(503, '登录服务未配置（缺少 WX_APPID/WX_APPSECRET）');
  }

  const now = Date.now();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE openid = ?1').bind(openid).first();
  let userId;
  if (existing) {
    userId = existing.id;
    await env.DB.prepare('UPDATE users SET updated_at = ?1, session_key = ?2 WHERE id = ?3').bind(now, sessionKey, userId).run();
  } else {
    // ⚠️ D1 把每个 ?N 占位符当独立参数：复用 ?1 必须 bind 对应个数的值，
    // 否则 openid 列会被写入时间戳（真实事故：每次登录都新建用户）
    const ins = await env.DB.prepare('INSERT INTO users (openid, session_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)').bind(openid, sessionKey, now).run();
    userId = ins.meta.last_row_id;
  }

  // 登录即发放采集接入码（幂等）：用户不该有任何"手动获取接入码"的动作
  await ensureConnectToken(env, userId);

  const token = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO mp_sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(token, userId, now + MP_SESSION_TTL_MS).run();
  return Response.json({ token, user: await publicUser(env, userId, userOrigin(env, request)) });
}

async function sessionUser(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.* FROM mp_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1 AND s.expires_at > ?2')
    .bind(token, Date.now()).first();
  return row ?? null;
}

async function publicUser(env, userId, origin = '') {
  const u = await env.DB.prepare(`SELECT u.id, u.nickname, u.avatar_path, u.rank_hidden,
    c.user_id AS connected_user_id, c.last_report_at FROM users u
    LEFT JOIN connect_tokens c ON c.user_id=u.id WHERE u.id=?1`).bind(userId).first();
  return {
    user_id: u.id,
    nickname: u.nickname,
    avatar_url: u.avatar_path ? `${origin}/avatars/${u.avatar_path}` : null,
    profile_complete: completeProfile(u),
    connected: !!u.connected_user_id,
    // 接入状态三态的依据：connected=有码；last_report_at=数据确实到达过
    last_report_at: u.last_report_at ?? null,
    rank_hidden: !!u.rank_hidden,
  };
}

/** 关闭或恢复排名：只影响榜单展示，不删任何用量。 */
async function setRanking(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const body = await readJson(request);
  if (typeof body?.hidden !== 'boolean') return jsonError(400, 'hidden 必须是布尔值');
  await env.DB.prepare('UPDATE users SET rank_hidden = ?1, updated_at = ?2 WHERE id = ?3').bind(body.hidden ? 1 : 0, Date.now(), user.id).run();
  return Response.json(await publicUser(env, user.id, userOrigin(env, request)));
}

async function me(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  return Response.json(await publicUser(env, user.id, userOrigin(env, request)));
}

async function setProfile(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  let body, avatar;
  try {
    body = await profileBody(request);
    if (body?.avatar) avatar = await parseAvatar(body.avatar);
  } catch (err) { return jsonError(400, err.message || '资料格式无效'); }
  if (!body) return jsonError(400, '资料不能为空');
  const nickname = sanitizeName(body.nickname);
  if (!nickname) return jsonError(400, '昵称不可用：1-16 个字，且不含链接、@、敏感词');
  const now = Date.now();
  if (avatar) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user_avatars (user_id, content, mime_type, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(user_id) DO UPDATE SET content=excluded.content, mime_type=excluded.mime_type, updated_at=excluded.updated_at`)
        .bind(user.id, avatar.data, avatar.type, now),
      env.DB.prepare('UPDATE users SET nickname = ?1, avatar_path = ?2, updated_at = ?3 WHERE id = ?4')
        .bind(nickname, avatar.path, now, user.id),
    ]);
  } else {
    await env.DB.prepare('UPDATE users SET nickname = ?1, updated_at = ?2 WHERE id = ?3').bind(nickname, now, user.id).run();
  }
  return Response.json(await publicUser(env, user.id, userOrigin(env, request)));
}


// ================= 采集接入 =================

/** 确保用户有接入码（幂等）：登录即发放，老用户缺码自愈 */
async function ensureConnectToken(env, userId) {
  const existing = await env.DB.prepare('SELECT token FROM connect_tokens WHERE user_id = ?1').bind(userId).first();
  if (existing) return existing.token;
  const token = hexToken(16);
  await env.DB.prepare('INSERT INTO connect_tokens (token, user_id, created_at) VALUES (?1, ?2, ?3)')
    .bind(token, userId, Date.now()).run();
  return token;
}

/** 查看当前接入码；不存在则自动补发（GET 永远有码可复制） */
async function getConnectToken(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const token = await ensureConnectToken(env, user.id);
  const row = await env.DB.prepare('SELECT last_report_at FROM connect_tokens WHERE user_id = ?1').bind(user.id).first();
  return Response.json({
    connected: true,
    token,
    last_report_at: row?.last_report_at ?? null,
    install_command: `npx tokenrank-client@latest connect ${userOrigin(env, request)} ${token}`,
  });
}

/** 创建/重置接入码（每用户一个活跃码；重置即作废旧码） */
async function createConnectToken(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const token = hexToken(16);
  const now = Date.now();
  const batch = [
    env.DB.prepare('DELETE FROM connect_tokens WHERE user_id = ?1').bind(user.id),
    env.DB.prepare('INSERT INTO connect_tokens (token, user_id, created_at) VALUES (?1, ?2, ?3)').bind(token, user.id, now),
  ];
  await env.DB.batch(batch);
  return Response.json({ token, install_command: `npx tokenrank-client@latest connect ${userOrigin(env, request)} ${token}` });
}

/** 采集端 v2：原版 total_tokens，北京时间日桶，输入/输出/缓存分别保留。 */
async function report(request, env) {
  const token = bearerToken(request);
  if (!token) return jsonError(401, 'missing bearer token');
  const conn = await env.DB.prepare('SELECT * FROM connect_tokens WHERE token = ?1').bind(token).first();
  if (!conn) return jsonError(401, 'invalid connect token');
  // Accounts disabled in the admin database keep their data but can no longer upload.
  const owner = await env.DB.prepare('SELECT disabled_at FROM users WHERE id = ?1').bind(conn.user_id).first();
  if (owner?.disabled_at) return jsonError(403, '账号已停用');
  const now = Date.now();
  if (conn.last_report_at && now - conn.last_report_at < REPORT_MIN_INTERVAL_MS) {
    return Response.json({ error: '上报过于频繁，请稍后重试' }, { status: 429,
      headers: { 'retry-after': String(Math.ceil((REPORT_MIN_INTERVAL_MS - (now - conn.last_report_at)) / 1000)) } });
  }

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_REPORT_BODY) return jsonError(413, 'report too large');
  const body = await readJson(request);
  return storeTotalReport(env, conn, body, now);
}

// ================= 群 =================

// ═══ 群身份识别：预览后明确确认加入，一群一榜 ═══

async function decryptWechatData(sessionKeyB64, encryptedB64, ivB64) {
  const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', dec(sessionKeyB64), { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: dec(ivB64) }, key, dec(encryptedB64));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 卡片进入时的群身份解析：
 * 1. 解密 getGroupEnterInfo → opengid（每小程序群匿名标识）→ 哈希
 * 2. 默认仅查询本群信息，不创建榜单、不加入成员。
 * 3. 用户确认后再次验证群身份，与预览的群一致才加入或创建唯一榜单。
 * 分享卡片的 g 仅是历史链接信息，不能用于决定群归属。
 */
async function resolveGroup(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const body = await readJson(request);
  if (!body || !body.encrypted_data || !body.iv) return jsonError(400, '缺少加密数据');

  const skRow = await env.DB.prepare('SELECT session_key FROM users WHERE id = ?1').bind(user.id).first();
  if (!skRow?.session_key) return jsonError(400, '缺少会话密钥：请从群聊分享卡片进入小程序');
  let groupOpenId;
  try {
    const data = await decryptWechatData(skRow.session_key, body.encrypted_data, body.iv);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return jsonError(400, '群身份数据格式无效，请重新从群卡片进入');
    }
    // getGroupEnterInfo 的官方开放数据结构包含 opengid，未要求 watermark。
    // 密文仍必须由当前用户在本小程序的 session_key 解密；有水印时严格验证，
    // 不把“未返回水印”误判为“属于其他小程序”。旧字段仍要求有效水印。
    const hasWatermark = Object.prototype.hasOwnProperty.call(data, 'watermark');
    const hasOpenGid = typeof data.opengid === 'string' && !!data.opengid.trim();
    if (hasWatermark && env.WX_APPID && data.watermark?.appid !== env.WX_APPID) {
      return jsonError(400, '群身份不属于当前小程序，请重新从群卡片进入');
    }
    // chat_type 1/2 是单聊（open_single_roomid），没有群身份可绑定。
    if (!hasOpenGid && ([1, 2].includes(Number(data.chat_type)) || data.open_single_roomid)) return jsonError(400, '群榜需要在微信群里打开');
    if (!hasWatermark && !hasOpenGid) return jsonError(400, '群数据缺少有效的群标识，请重新从群卡片进入');
    // getGroupEnterInfo 使用 opengid；旧 getShareInfo 使用 openGId。
    // group_openid 是用户在群内的标识，绝不能据此建群，否则一人一榜。
    const ids = [data.opengid, data.openGId, data.groupOpenId]
      .filter(id => typeof id === 'string' && id.trim());
    if (new Set(ids).size > 1) return jsonError(400, '群身份信息不一致，请重新从群卡片进入');
    groupOpenId = ids[0] || null;
  } catch (e) {
    return jsonError(400, '群标识解密失败（会话密钥过期）：请退出小程序后从群卡片重新进入');
  }
  if (!groupOpenId) return jsonError(400, '未能识别群身份：请从群聊分享卡片进入');
  const hash = await sha256Hex(groupOpenId);

  // 分享路径中的 g/id 不参与绑定；预览和确认必须指向同一个真实群。
  const bound = await env.DB.prepare('SELECT id, name FROM rank_groups WHERE group_openid_hash = ?1 ORDER BY created_at, id LIMIT 1').bind(hash).first();
  if (body.confirm !== true) {
    const member = bound && await env.DB.prepare('SELECT 1 AS joined FROM rank_group_members WHERE group_id=?1 AND user_id=?2').bind(bound.id,user.id).first();
    const count = bound && await env.DB.prepare('SELECT COUNT(*) AS n FROM rank_group_members WHERE group_id=?1').bind(bound.id).first();
    return Response.json({ id: bound?.id || '', name: bound?.name || DEFAULT_GROUP_NAME, exists: !!bound,
      joined: !!member, members: count?.n || 0, group_ref: hash });
  }
  if (body.expected_group_ref !== hash) return jsonError(409, '当前微信群已变化，请重新识别并确认加入');
  if (!completeProfile(user)) return profileRequired();
  if (bound) {
    await env.DB.prepare('INSERT OR IGNORE INTO rank_group_members (group_id, user_id, joined_at) VALUES (?1, ?2, ?3)')
      .bind(bound.id, user.id, Date.now()).run();
    return Response.json({ id: bound.id, name: bound.name, bound: true, joined: true });
  }

  // 建榜时可顺带起名；留空用默认名。名称不合规时不建榜，避免留下半成品。
  let name = DEFAULT_GROUP_NAME;
  if (body.name != null && String(body.name).trim()) {
    name = sanitizeGroupName(body.name);
    if (!name) return jsonError(400, '群名不可用：1-100 个字，且不含链接、@、敏感词');
  }
  // SQLite 的条件 INSERT 是原子的；D1 batch 内再按哈希入群，避免并发首次进入建出两张榜。
  const id = groupId();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO rank_groups (id, name, owner_user_id, created_at, group_openid_hash)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM rank_groups WHERE group_openid_hash = ?5)`)
      .bind(id, name, user.id, Date.now(), hash),
    env.DB.prepare(`INSERT OR IGNORE INTO rank_group_members (group_id, user_id, joined_at)
      SELECT id, ?2, ?3 FROM rank_groups WHERE group_openid_hash = ?1 ORDER BY created_at, id LIMIT 1`)
      .bind(hash, user.id, Date.now()),
  ]);
  const group = await env.DB.prepare('SELECT id, name FROM rank_groups WHERE group_openid_hash = ?1 ORDER BY created_at, id LIMIT 1').bind(hash).first();
  return Response.json({ ...group, created: group.id === id, bound: true, joined: true });
}

async function createGroup(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  return jsonError(409, '请分享卡片到微信群，再从群卡片进入创建本群榜单');
}

/** 发起者随时可改名；仍是默认名时任何成员可起一次名。名称不影响真实微信群的唯一绑定。 */
async function renameGroup(request, env, path) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const id = path.split('/')[3];
  const body = await readJson(request);
  const name = sanitizeGroupName(body?.name);
  if (!name) return jsonError(400, '群名不可用：1-100 个字，且不含链接、@、敏感词');
  const g = await env.DB.prepare('SELECT owner_user_id, name FROM rank_groups WHERE id = ?1').bind(id).first();
  if (!g) return jsonError(404, '群不存在或已解散');
  if (g.owner_user_id === user.id) {
    await env.DB.prepare('UPDATE rank_groups SET name = ?1 WHERE id = ?2').bind(name, id).run();
    return Response.json({ id, name });
  }
  const member = await env.DB.prepare('SELECT 1 AS x FROM rank_group_members WHERE group_id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!member || g.name !== DEFAULT_GROUP_NAME) return jsonError(403, '群榜已有名字，只有发起者可以修改');
  // 条件更新：两名成员同时起名时只有第一个生效。
  const res = await env.DB.prepare('UPDATE rank_groups SET name = ?1 WHERE id = ?2 AND name = ?3').bind(name, id, DEFAULT_GROUP_NAME).run();
  if (!res.meta?.changes) return jsonError(409, '群榜刚被其他成员起好名字');
  return Response.json({ id, name });
}

/** 成员设置自己在本群是否显示排名；只影响本群榜单。 */
async function setGroupVisibility(request, env, path) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const id = path.split('/')[3];
  const body = await readJson(request);
  if (typeof body?.hidden !== 'boolean') return jsonError(400, 'hidden 必须是布尔值');
  const res = await env.DB.prepare('UPDATE rank_group_members SET hidden = ?1 WHERE group_id = ?2 AND user_id = ?3').bind(body.hidden ? 1 : 0, id, user.id).run();
  if (!res.meta?.changes) return jsonError(403, '你还没有加入这个群');
  return Response.json({ id, my_hidden: body.hidden });
}

async function joinGroup(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const body = await readJson(request);
  if (!body) return jsonError(400, 'invalid json');
  const id = String(body.id ?? '').trim();
  const group = await env.DB.prepare('SELECT id, name FROM rank_groups WHERE id = ?1').bind(id).first();
  if (!group) return jsonError(404, '群不存在或已解散');
  const member = await env.DB.prepare('SELECT 1 AS joined FROM rank_group_members WHERE group_id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!member) return jsonError(403, '请从所在微信群的分享卡片进入，验证群身份并确认加入');
  return Response.json({ id: group.id, name: group.name });
}

async function myGroups(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const rows = await env.DB.prepare(`
    SELECT g.id, g.name, mm.hidden AS my_hidden,
           (SELECT COUNT(*) FROM rank_group_members m WHERE m.group_id = g.id) AS members
    FROM rank_groups g
    JOIN rank_group_members mm ON mm.group_id = g.id AND mm.user_id = ?1
    ORDER BY g.created_at DESC LIMIT 50`).bind(user.id).all();
  return Response.json({ groups: rows.results });
}

async function groupInfo(request, env, path) {
  const id = path.split('/')[3];
  if (!id || path.split('/').length !== 4) return null; // 交给 404
  const user = await sessionUser(request, env);
  const group = await env.DB.prepare('SELECT id, name, owner_user_id, created_at FROM rank_groups WHERE id = ?1').bind(id).first();
  if (!group) return jsonError(404, '群不存在或已解散');
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM rank_group_members WHERE group_id = ?1').bind(id).first();
  let joined = null, myHidden = false;
  if (user) {
    const m = await env.DB.prepare('SELECT hidden FROM rank_group_members WHERE group_id = ?1 AND user_id = ?2').bind(id, user.id).first();
    joined = !!m;
    myHidden = !!m?.hidden;
  }
  const named = group.name !== DEFAULT_GROUP_NAME;
  const canRename = !!user && (group.owner_user_id === user.id || (joined === true && !named));
  return Response.json({ id: group.id, name: group.name, members: cnt.c, created_at: group.created_at, joined,
    owner_id: group.owner_user_id, named, can_rename: canRename, my_hidden: myHidden });
}

// ================= 榜单 =================

/**
 * GET /api/leaderboard?scope=global|group&id=<群id>&period=day|week|month|all
 * 可选 Authorization: Bearer <会话token> → 响应带 me（我的排名，50 名外也能查到）
 * 群榜和广场榜每页 50 人；续页携带 offset 与首屏 snapshot，数据变化返回 409，避免拼接不同排名。
 */
async function leaderboard(request, env, url) {
  const scope = url.searchParams.get('scope') === 'group' ? 'group' : 'global';
  const groupIdParam = String(url.searchParams.get('id') ?? '').trim();
  const period = ['day', 'week', 'month', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';
  const offsetText = url.searchParams.get('offset') || '0';
  const offset = Number(offsetText);
  const previousSnapshot = url.searchParams.get('snapshot') || '';
  if ((!/^\d{1,9}$/.test(offsetText) || !Number.isSafeInteger(offset) ||
    (offset > 0 && !/^[a-f0-9]{64}$/.test(previousSnapshot)))) return jsonError(400, '分页参数无效，请刷新榜单');

  const session = await sessionUser(request, env);
  let group = null;
  if (scope === 'group') {
    if (!groupIdParam) return jsonError(400, 'scope=group 需要 id 参数');
    group = await env.DB.prepare(`SELECT id, name,
      (SELECT COUNT(*) FROM rank_group_members WHERE group_id = ?1) AS members
      FROM rank_groups WHERE id = ?1`).bind(groupIdParam).first();
    if (!group) return jsonError(404, '群不存在或已解散');
    const viewer = session;
    if (!viewer) return jsonError(401, '请先登录');
    const member = await env.DB.prepare('SELECT 1 AS joined FROM rank_group_members WHERE group_id=?1 AND user_id=?2').bind(group.id,viewer.id).first();
    if (!member) return jsonError(403, '请从微信群卡片进入并确认加入后查看本群排名');
    if (!completeProfile(viewer)) return profileRequired();
  }

  const today = beijingDay();
  const [from, to] = period === 'day' ? [today, today]
    : period === 'week' ? [daysAgo(6, Date.now()), today]
    : period === 'month' ? [daysAgo(29, Date.now()), today]
    : ['0000-01-01', '9999-12-31'];

  const memberFilter = scope === 'group' ? ` AND ds.user_id IN (${groupMembers('?3')})` : '';
  // me 查询的占位符不同（?1/?2/?3 已被占用），群过滤落在 ?4
  const memberFilterMe = scope === 'group' ? ` AND ds.user_id IN (${groupMembers('?4')})` : '';
  const binds = scope === 'group' ? [from, to, group.id] : [from, to];

  const rowsTask = env.DB.prepare(`
    SELECT u.id AS uid, u.nickname, u.avatar_path,
           SUM(ds.tokens) AS tokens, SUM(ds.requests) AS requests,
           SUM(ds.cache_read + ds.cache_write) AS cache
    FROM public_usage ds JOIN users u ON u.id = ds.user_id
    WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}
    GROUP BY ds.user_id HAVING tokens > 0
    ORDER BY tokens DESC, uid ASC`).bind(...binds).all();

  const modelTask = env.DB.prepare(`
    SELECT ds.user_id AS uid, json_extract(je.value, '$[0]') AS model,
           SUM(json_extract(je.value, '$[1]')) AS t
    FROM public_usage ds, json_each(ds.models_json) je
    WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}
    GROUP BY ds.user_id, model`).bind(...binds).all();
  // 更新时间：所选范围内最后一次数据写入
  const updateTask = env.DB.prepare(`SELECT MAX(updated_at) AS ts FROM public_usage ds WHERE ds.day >= ?1 AND ds.day <= ?2${memberFilter}`).bind(...binds).first();

  const globalTask = scope === 'group' ? env.DB.prepare(`SELECT ds.user_id AS uid, SUM(ds.tokens) AS t FROM public_usage ds WHERE ds.day >= ?1 AND ds.day <= ?2 GROUP BY ds.user_id HAVING t > 0 ORDER BY t DESC, uid ASC`).bind(from, to).all() : Promise.resolve(null);
  const [rows, modelRows, upRow, allRows] = await Promise.all([rowsTask, modelTask, updateTask, globalTask]);
  const globalRankMap = allRows ? new Map(allRows.results.map((r, i) => [r.uid, i + 1])) : null;
  // Group aggregates also supply the total and a stable fingerprint. Only one
  // page is returned to the phone; raw user IDs never leave the server.
  const snapshot = await sha256Hex(JSON.stringify(group ? [group.id, group.name, group.members, period, today, rows.results]
    : ['global', period, today, rows.results]));
  if (offset > 0 && previousSnapshot !== snapshot) return jsonError(409, '榜单已有更新，请刷新后继续查看');
  const pageRows = rows.results.slice(offset, offset + LEADERBOARD_LIMIT);
  const nextOffset = offset + pageRows.length;

  const topModel = new Map();
  for (const r of modelRows.results) {
    const cur = topModel.get(r.uid);
    if (!cur || r.t > cur.t) topModel.set(r.uid, { model: r.model, t: r.t });
  }

  const origin = userOrigin(env, request);
  const entries = pageRows.map((r, i) => ({
    rank: offset + i + 1,
    nickname: r.nickname || `AI玩家-${String(r.uid).slice(-4).padStart(4, '0')}`,
    avatar_url: r.avatar_path ? `${origin}/avatars/${r.avatar_path}` : null,
    tokens: r.tokens,
    requests: r.requests,
    cache: r.cache || 0,
    top_model: topModel.get(r.uid)?.model ?? null,
    global_rank: globalRankMap ? (globalRankMap.get(r.uid) ?? null) : null,
  }));

  // 我的排名（50 名外也能查）：全量聚合数 + 大于我的人头数
  let me = null;
  if (session) {
    const mine = await env.DB.prepare(`
      SELECT SUM(ds.tokens) AS tokens, SUM(ds.requests) AS requests
      FROM public_usage ds WHERE ds.user_id = ?1 AND ds.day >= ?2 AND ds.day <= ?3${memberFilterMe}`)
      .bind(session.id, from, to, ...(scope === 'group' ? [group.id] : [])).first();
    if (mine && mine.tokens > 0) {
      const ahead = await env.DB.prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT ds.user_id, SUM(ds.tokens) AS t FROM public_usage ds
          WHERE ds.day >= ?2 AND ds.day <= ?3${memberFilterMe}
          GROUP BY ds.user_id HAVING t > ?1 OR (t = ?1 AND ds.user_id < ${scope === 'group' ? '?5' : '?4'}))`)
          .bind(mine.tokens, from, to, ...(scope === 'group' ? [group.id] : []), session.id).first();
      // 群榜时 me.rank 是群内名次，global_rank 是广场名次；全局榜两者相同
      me = { rank: ahead.c + 1, tokens: mine.tokens, requests: mine.requests,
        global_rank: globalRankMap ? (globalRankMap.get(session.id) ?? null) : ahead.c + 1 };
    }
  }

  return Response.json({
    scope, period, day: today,
    group: group ? { id: group.id, name: group.name } : null,
    entries, me,
    ...(group ? { members: group.members } : {}),
    total: rows.results.length, snapshot,
    has_more: nextOffset < rows.results.length,
    next_offset: nextOffset < rows.results.length ? nextOffset : null,
    updated_at: upRow?.ts ?? null,
  });
}

// ================= 杂项 =================

async function myUsage(request, env, url) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const initialized = await env.DB.prepare('SELECT 1 AS ready FROM usage_sync_state WHERE user_id=?1').bind(user.id).first();
  if (!initialized) {
    const legacy = await env.DB.prepare('SELECT 1 AS found FROM daily_stats WHERE user_id=?1 LIMIT 1').bind(user.id).first();
    if (legacy) return jsonError(409, '请到管理电脑接入重新运行安装命令，以同步含缓存的总用量');
  }
  const now = Date.now();
  const range = usageWindow(url.searchParams.get('period'), now);
  // 今日页也返回最近 7 天趋势，趋势范围不改变今日总量。
  const readFrom = range.period === 'day' ? daysAgo(6, now) : range.from;
  const rowsTask = env.DB.prepare(`SELECT day, tokens, input_tokens, output_tokens, requests, cache_read, cache_write,
    models_json, tools_json, updated_at FROM ranked_usage
    WHERE user_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day`).bind(user.id, readFrom, range.to).all();
  const historyTask = env.DB.prepare(`SELECT COUNT(*) AS days, SUM(tokens) AS tokens,
    MIN(day) AS first_day, MAX(updated_at) AS updated_at FROM ranked_usage
    WHERE user_id = ?1 AND day <= ?2 AND (tokens > 0 OR requests > 0)`).bind(user.id, range.to).first();
  const activityTask = env.DB.prepare('SELECT day, tokens, requests FROM ranked_usage WHERE user_id = ?1 AND day <= ?2 ORDER BY day')
    .bind(user.id, range.to).all();
  const [rows, history, activityRows] = await Promise.all([rowsTask, historyTask, activityTask]);
  const usage = buildUsage(rows.results, range.period, now);
  const ranking = await env.DB.prepare(`SELECT COUNT(*) AS participants,
    SUM(CASE WHEN total > ?3 OR (total = ?3 AND user_id < ?4) THEN 1 ELSE 0 END) AS ahead
    FROM (SELECT user_id, SUM(tokens) AS total FROM public_usage WHERE day >= ?1 AND day <= ?2
      GROUP BY user_id HAVING total > 0)`).bind(range.from, range.to, usage.summary.tokens, user.id).first();
  return Response.json({ ...usage, activity: buildActivity(activityRows.results, now),
    standing: { rank: usage.summary.tokens > 0 && !user.rank_hidden ? (ranking.ahead || 0) + 1 : null,
      participants: ranking.participants || 0, hidden: !!user.rank_hidden },
    has_history: history.days > 0, first_day: history.first_day,
    lifetime_tokens: history.tokens || 0, last_report_at: history.updated_at || null });
}

/**
 * 我的全部群排名 + 广场对照：
 * N 个群的群内名次、广场名次、我的 tokens、各群榜单更新时间。
 */
async function myRankings(request, env, url) {
  const user = await sessionUser(request, env);
  if (!user) return jsonError(401, '请先登录');
  const period = ['day', 'week', 'month', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';

  const today = beijingDay();
  const [from, to] = period === 'day' ? [today, today]
    : period === 'week' ? [daysAgo(6, Date.now()), today]
    : period === 'month' ? [daysAgo(29, Date.now()), today]
    : ['0000-01-01', '9999-12-31'];

  const groupsTask = env.DB.prepare(`
    SELECT g.id, g.name, mm.hidden AS my_hidden,
           (SELECT COUNT(*) FROM rank_group_members m WHERE m.group_id = g.id) AS members
    FROM rank_groups g
    JOIN rank_group_members mm ON mm.group_id = g.id AND mm.user_id = ?1
    ORDER BY g.created_at DESC LIMIT 50`).bind(user.id).all();

  // 广场排名：全量有序表（社区规模几百人，一次取齐）
  const allTask = env.DB.prepare(`SELECT ds.user_id AS uid, SUM(ds.tokens) AS t FROM public_usage ds WHERE ds.day >= ?1 AND ds.day <= ?2 GROUP BY ds.user_id HAVING t > 0 ORDER BY t DESC, uid ASC`).bind(from, to).all();
  const mineTask = env.DB.prepare(`SELECT SUM(tokens) AS t FROM ranked_usage WHERE user_id = ?1 AND day >= ?2 AND day <= ?3`).bind(user.id, from, to).first();
  const [groups, allRows, mine] = await Promise.all([groupsTask, allTask, mineTask]);
  const gmap = new Map();
  let grk = 0;
  for (const r of allRows.results) gmap.set(r.uid, ++grk);
  const myTokens = mine?.t || 0;

  const out = [];
  let maxUpd = 0;
  for (let offset = 0; offset < groups.results.length; offset += 5) {
    const chunk = await Promise.all(groups.results.slice(offset, offset + 5).map(async g => {
      const [up, ahead] = await Promise.all([
        env.DB.prepare(`SELECT MAX(updated_at) AS ts FROM public_usage ds WHERE ds.day >= ?2 AND ds.day <= ?3 AND ds.user_id IN (${groupMembers('?1')})`).bind(g.id, from, to).first(),
        env.DB.prepare(`SELECT COUNT(*) AS c FROM (SELECT ds.user_id, SUM(ds.tokens) AS t FROM public_usage ds WHERE ds.day >= ?2 AND ds.day <= ?3 AND ds.user_id IN (${groupMembers('?1')}) GROUP BY ds.user_id HAVING t > ?4 OR (t = ?4 AND ds.user_id < ?5))`).bind(g.id, from, to, myTokens, user.id).first(),
      ]);
      return { id: g.id, name: g.name, members: g.members,
        profile_required: !completeProfile(user),
        my_rank: myTokens > 0 && !user.rank_hidden && !g.my_hidden ? ahead.c + 1 : null, my_tokens: myTokens,
        rank_hidden: !!user.rank_hidden, group_hidden: !!g.my_hidden,
        global_rank: gmap.get(user.id) ?? null, updated_at: up.ts };
    }));
    out.push(...chunk);
    for (const g of chunk) if (g.updated_at > maxUpd) maxUpd = g.updated_at;
  }
  return Response.json({
    period,
    groups: out,
    global: { rank: gmap.get(user.id) ?? null, tokens: myTokens },
    updated_at: maxUpd || null,
  });
}

async function readJson(request, maxBytes = MAX_REPORT_BODY) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return null;
  try { return await request.json(); } catch { return null; }
}
