import { hexToken, jsonError, beijingDay } from './lib.js';
import { CURRENCIES } from './subscriptions.js';

// Prepaid API balances. Each top-up is a row; a "balance" row is the figure the user copied from the
// vendor console and restarts the estimate from that day.
export const TOPUP_LIMIT = 200;
export const TOPUP_VENDORS = ['deepseek'];
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z'))
  && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

export function normalizeTopup(body, today) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '充值内容格式有误' };
  if (!TOPUP_VENDORS.includes(body.vendor)) return { error: '暂不支持这个充值服务' };
  const kind = body.kind ?? 'topup';
  if (!['topup', 'balance'].includes(kind)) return { error: '记录类型有误' };
  const amount = Number(body.amount), minor = Math.round(amount * 100);
  if (typeof body.amount !== 'number' || !Number.isFinite(amount) || minor < (kind === 'topup' ? 1 : 0) || minor > 100_000_000_000)
    return { error: kind === 'topup' ? '请填写有效的充值金额' : '请填写有效的余额' };
  if (!CURRENCIES.includes(body.currency)) return { error: '不支持这个币种' };
  if (!validDay(body.day) || body.day > today) return { error: '日期不能晚于今天' };
  let notes = null;
  if (body.notes != null && body.notes !== '') {
    notes = typeof body.notes === 'string' ? body.notes.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    if (!notes || [...notes].length > 100) return { error: '备注最多 100 字' };
  }
  return { value: { vendor: body.vendor, kind, amount_minor: minor, currency: body.currency, day: body.day, notes } };
}

/**
 * Remaining balance = last calibrated balance (or 0) + later top-ups − estimated spend since.
 * Spend counts days after a calibration day (the copied balance already includes that day so far)
 * and from the first top-up day otherwise. `spend` maps a day to that vendor's API value in USD micros.
 */
export function summarizeTopups(records, spend, fx, today, weekDays) {
  const out = [];
  for (const vendor of TOPUP_VENDORS) {
    const rows = records.filter(r => r.vendor === vendor).sort((a, b) => a.day.localeCompare(b.day) || a.created_at - b.created_at);
    if (!rows.length) continue;
    const currency = rows.at(-1).currency, rate = c => fx.rates[c] || 1;
    const conv = (minor, from) => minor / rate(from) * rate(currency);
    const fromMicros = micros => micros / 10_000 * rate(currency);
    const baseline = rows.filter(r => r.kind === 'balance').at(-1) || null;
    const topups = rows.filter(r => r.kind === 'topup');
    const since = baseline ? baseline.day : topups[0]?.day;
    const start = baseline ? conv(baseline.amount_minor, baseline.currency) : 0;
    const added = topups.filter(r => !baseline || r.day > baseline.day).reduce((a, r) => a + conv(r.amount_minor, r.currency), 0);
    let spentMicros = 0;
    for (const [day, micros] of spend) if (since && (baseline ? day > since : day >= since) && day <= today) spentMicros += micros;
    const spent = fromMicros(spentMicros), remaining = start + added - spent;
    const weekMicros = weekDays.reduce((a, d) => a + (spend.get(d) || 0), 0), avg = fromMicros(weekMicros / weekDays.length);
    const total = topups.reduce((a, r) => a + conv(r.amount_minor, r.currency), 0);
    out.push({ vendor, currency, since, calibrated_day: baseline?.day || null,
      total_minor: Math.round(total), count: topups.length, spent_minor: Math.round(spent),
      remaining_minor: Math.round(remaining), used_percent: start + added > 0 ? Math.min(100, Math.max(0, Math.round(spent / (start + added) * 100))) : null,
      avg_daily_minor: Math.round(avg * 100) / 100, days_left: avg > 0 && remaining > 0 ? Math.floor(remaining / avg) : null,
      today_minor: Math.round(fromMicros(spend.get(today) || 0) * 100) / 100,
      records: rows.slice().reverse().map(r => ({ id: r.id, kind: r.kind, amount_minor: r.amount_minor, currency: r.currency, day: r.day, notes: r.notes })) });
  }
  return out;
}

const notFound = () => Response.json({ error: '这条记录已不存在，请刷新', code: 'TOPUP_NOT_FOUND' }, { status: 404 });

export async function createTopup(env, userId, body, now, list) {
  const { value: v, error } = normalizeTopup(body, beijingDay(now));
  if (error) return jsonError(400, error);
  const result = await env.DB.prepare(`INSERT INTO user_topups(id,user_id,vendor,kind,amount_minor,currency,day,notes,created_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?9 FROM users WHERE id=?2 AND disabled_at IS NULL
      AND (SELECT COUNT(*) FROM user_topups WHERE user_id=?2) < ?10`)
    .bind(hexToken(), userId, v.vendor, v.kind, v.amount_minor, v.currency, v.day, v.notes, now, TOPUP_LIMIT).run();
  if (!result.meta?.changes) return Response.json({ error: `最多记录 ${TOPUP_LIMIT} 笔充值`, code: 'TOPUP_LIMIT' }, { status: 409 });
  return Response.json(await list());
}

export async function updateTopup(env, userId, id, body, now, list) {
  const { value: v, error } = normalizeTopup(body, beijingDay(now));
  if (error) return jsonError(400, error);
  const result = await env.DB.prepare(`UPDATE user_topups SET vendor=?3,kind=?4,amount_minor=?5,currency=?6,day=?7,notes=?8,updated_at=?9
    WHERE id=?1 AND user_id=?2 AND EXISTS(SELECT 1 FROM users WHERE id=?2 AND disabled_at IS NULL)`)
    .bind(id, userId, v.vendor, v.kind, v.amount_minor, v.currency, v.day, v.notes, now).run();
  return result.meta?.changes ? Response.json(await list()) : notFound();
}

export async function deleteTopup(env, userId, id, list) {
  const result = await env.DB.prepare('DELETE FROM user_topups WHERE id=?1 AND user_id=?2').bind(id, userId).run();
  return result.meta?.changes ? Response.json(await list()) : notFound();
}
