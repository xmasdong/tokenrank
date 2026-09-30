import { jsonError } from './lib.js';
export const MAX_AVATAR_BYTES = 256 * 1024;

// Bound the actual stream, including chunked requests without Content-Length.
export async function profileBody(request) {
  const limit = MAX_AVATAR_BYTES + 16 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new Error('资料不能为空');
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('头像过大，请选择不超过 256 KB 的图片'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Response(new Blob(parts), { headers: { 'content-type': request.headers.get('content-type') || '' } });
  if ((request.headers.get('content-type') || '').startsWith('multipart/form-data')) {
    const form = await body.formData();
    return { nickname: form.get('nickname'), avatar: form.get('avatar') };
  }
  return body.json();
}

export async function parseAvatar(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size || file.size > MAX_AVATAR_BYTES)
    throw new Error('头像需为不超过 256 KB 的 PNG、JPG 或 WebP 图片');
  const data = new Uint8Array(await file.arrayBuffer());
  const starts = bytes => bytes.every((v, i) => data[i] === v);
  let type, ext;
  if (starts([137,80,78,71,13,10,26,10])) { type = 'image/png'; ext = 'png'; }
  else if (starts([255,216,255])) { type = 'image/jpeg'; ext = 'jpg'; }
  else if (starts([82,73,70,70]) && String.fromCharCode(...data.slice(8,12)) === 'WEBP') { type = 'image/webp'; ext = 'webp'; }
  else throw new Error('头像格式不支持，请重新选择 PNG、JPG 或 WebP 图片');
  return { data: data.buffer, type, path: crypto.randomUUID() + '.' + ext };
}

export async function avatarResponse(env, path) {
  if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(path)) return jsonError(404, 'avatar not found');
  const row = await env.DB.prepare(`SELECT a.content, a.mime_type FROM user_avatars a
    JOIN users u ON u.id = a.user_id WHERE u.avatar_path = ?1`).bind(path).first();
  if (!row) return jsonError(404, 'avatar not found');
  // D1 may return a BLOB as a number array; SQLite fixtures use Uint8Array.
  const bytes = Array.isArray(row.content) ? new Uint8Array(row.content) : row.content;
  return new Response(bytes, { headers: { 'content-type': row.mime_type,
    'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
}
