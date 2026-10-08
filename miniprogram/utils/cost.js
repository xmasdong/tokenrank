function money(micros) {
  const units = Math.round(micros / 100);
  const whole = String(Math.floor(units / 10000)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return whole + '.' + String(units % 10000).padStart(4, '0');
}
function presentCost(cost) {
  const available = cost && cost.status !== 'unavailable' && Number.isSafeInteger(cost.usd_micros) && cost.usd_micros >= 0;
  const models = (cost?.models || []).slice(0, 5).map(m => ({ ...m }));
  const otherCount = cost?.other_model_count ?? Math.max(0, (cost?.models || []).length - 5);
  const otherAmount = cost?.other_usd_micros ?? (cost?.models || []).slice(5).reduce((s,m) => s + m.usd_micros, 0);
  if (otherCount) models.push({ name: `其他模型（${otherCount}）`, usd_micros: otherAmount, other: true });
  // Allocate the last displayed decimal so model lines add up exactly to the displayed total.
  const amounts = models.map((m, i) => ({ i, units: Math.floor(m.usd_micros / 100), fraction: m.usd_micros % 100 }));
  let remaining = available ? Math.round(cost.usd_micros / 100) - amounts.reduce((s,m) => s + m.units, 0) : 0;
  for (const item of [...amounts].sort((a,b) => b.fraction-a.fraction || a.i-b.i)) { if (remaining-- > 0) item.units++; }
  models.forEach((m,i) => { m.amount = money(amounts[i].units * 100); });
  const unpriced = cost?.unpriced_count ?? cost?.unpriced_models?.length ?? 0;
  const missing = cost?.missing_days || 0;
  const notes = [unpriced ? `${unpriced} 个模型未计价` : '', missing ? `${missing} 天金额未同步` : ''].filter(Boolean);
  return { available: !!available, amount: available ? money(cost.usd_micros) : '—', models,
    label: cost?.status === 'partial' ? '已计价部分' : '本期估算',
    modelCount: cost?.model_count ?? new Set([...(cost?.models || []).map(m=>m.name), ...(cost?.unpriced_models || [])]).size,
    note: notes.join(' · '), missingDays: missing, unpricedCount: unpriced };
}
const issuedAt = timestamp => Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0,16).replace('T',' ') : '';
function receiptTitle(user, usage) {
  const c = presentCost(usage.cost);
  return `${user.nickname || 'AI 玩家'} · AI 用量账单${c.available ? ` · $${c.amount}` : ''} · API 等值估算`;
}
module.exports = { money, presentCost, issuedAt, receiptTitle };
