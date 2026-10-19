import { hexToken, jsonError } from './lib.js';

// Registration is not a verified address or permission to start sending mail.
export const EMAIL_CONSENT_VERSION = 'email-daily-registration-v1';
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (email.length > 254 || !/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(email)) return null;
  const [local, domain] = email.split('@');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.split('.').some(part => part.length > 63)) return null;
  return local + '@' + domain.toLowerCase();
}
export function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  return local.slice(0, 1) + '***@' + domain;
}
export async function emailRegistrationStatus(env, userId) {
  const row = await env.DB.prepare('SELECT email,consent_at,revision,updated_at FROM email_registrations WHERE user_id=?1').bind(userId).first();
  return { phase: 'registration', delivery_enabled: false, verified: false,
    registered: !!row?.email, email: row?.email || null, masked_email: maskEmail(row?.email),
    revision: row?.revision || null, saved_at: row?.email ? row.updated_at : null,
    consent_version: EMAIL_CONSENT_VERSION };
}
const revisionValid = body => body && Object.hasOwn(body, 'expected_revision') &&
  (body.expected_revision === null || (typeof body.expected_revision === 'string' && /^[a-f0-9]{32}$/.test(body.expected_revision)));
const conflict = () => Response.json({ error: '邮箱登记已变化，请刷新后重试', code: 'EMAIL_REGISTRATION_CHANGED' }, { status: 409 });
export async function saveEmailRegistration(env, userId, body, now = Date.now()) {
  const email = normalizeEmail(body?.email);
  if (!email) return jsonError(400, '请填写有效的邮箱地址');
  if (!revisionValid(body)) return jsonError(400, '请先读取邮箱登记状态');
  if (body.consent !== true || body.consent_version !== EMAIL_CONSENT_VERSION) return jsonError(400, '请先同意邮箱登记说明');
  const revision = hexToken();
  const result = await env.DB.prepare(`INSERT INTO email_registrations(user_id,email,consent_at,consent_version,revision,created_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,?3,?3 FROM users WHERE id=?1 AND disabled_at IS NULL
      AND (?6 IS NULL OR EXISTS(SELECT 1 FROM email_registrations WHERE user_id=?1 AND revision=?6))
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,consent_at=excluded.consent_at,
      consent_version=excluded.consent_version,revision=excluded.revision,updated_at=excluded.updated_at
    WHERE email_registrations.revision=?6`)
    .bind(userId,email,now,EMAIL_CONSENT_VERSION,revision,body.expected_revision).run();
  if (!result.meta?.changes) return conflict();
  return Response.json(await emailRegistrationStatus(env,userId));
}
export async function removeEmailRegistration(env, userId, body, now = Date.now()) {
  if (!revisionValid(body)) return jsonError(400, '请先读取邮箱登记状态');
  const result = await env.DB.prepare(`UPDATE email_registrations SET email=NULL,consent_at=NULL,consent_version=NULL,revision=?3,updated_at=?4
    WHERE user_id=?1 AND revision=?2 AND EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)`)
    .bind(userId,body.expected_revision,hexToken(),now).run();
  if (!result.meta?.changes) return conflict();
  return Response.json(await emailRegistrationStatus(env,userId));
}
