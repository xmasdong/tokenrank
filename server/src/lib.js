/**
 * 「Token 群排名」Worker 共用工具：清洗、钳制、id 生成。
 * 纯函数，node:test 可直接测（不依赖 Workers 运行时）。
 */

/** 32 位 hex 接入码 */
export function hexToken(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 8 位群短 id：小写无易混字符（去 0/o/1/l） */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function groupId() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map(b => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function daysAgo(n, now = Date.now()) {
  return new Date(now - n * 86_400_000).toISOString().slice(0, 10);
}

export function beijingDay(now = Date.now()) { return utcDay(now + 8 * 3600000); }
export function beijingDaysAgo(n, now = Date.now()) { return beijingDay(now - n * 86400000); }

/** 昵称黑名单：脏话 + 冒充官方（榜单是公开页，昵称是唯一自由文本字段） */
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'nigg', 'spam',
  'admin', '官方', '管理员', '运营'];

/**
 * 昵称清洗：1-16 码点，去控制符/零宽，压缩空白；链接/@/黑名单词 → null。
 * 与客户端展示端语义保持一致；非法回退由调用方处理。
 */
export function sanitizeName(raw, maxLength = 16) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (/(https?:\/\/|www\.)|(\.(com|cn|net|org|io|dev|app|xyz|me|cc)\b)/i.test(s)) return null;
  if (s.includes('@')) return null;
  const low = s.toLowerCase();
  if (BAD_WORDS.some(w => low.includes(w))) return null;
  const cps = [...s];
  if (cps.length < 1 || cps.length > maxLength) return null;
  return s;
}

/**
 * 日桶钳制（客户端也钳一次，双保险）：
 * 负数归零、上限截断、明细 ≤8 条且单条值 ≤ 天上限。
 */
export function clampDay(day) {
  const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const shares = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 8)
    .filter(p => Array.isArray(p) && typeof p[0] === 'string' && p[0])
    .map(([name, v]) => [String(name).slice(0, 60), int(v, 1e11)]);
  return {
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(day?.day)) ? String(day.day) : null,
    tokens: int(day?.tokens, 1e11),
    cache_read: int(day?.cache_read, 1e12),
    cache_write: int(day?.cache_write, 1e12),
    requests: int(day?.requests, 1e6),
    models: shares(day?.models),
    tools: shares(day?.tools),
  };
}

/** 群名清洗：与昵称同规则（链接/@/敏感词），长度放宽到 1-100 码点 */
export const GROUP_NAME_MAX = 100;
export function sanitizeGroupName(raw) {
  return sanitizeName(raw, GROUP_NAME_MAX);
}

export function jsonError(status, message) {
  return Response.json({ error: message }, { status });
}

/** Bearer 解析；没有返回 null */
export function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}
