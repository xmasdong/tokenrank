export function validateCost(cost, tokens) {
  if (cost == null) return;
  if (cost.basis !== 'token_watcher_api_estimate' || cost.currency !== 'USD'
    || !Number.isSafeInteger(cost.usd_micros) || cost.usd_micros < 0 || cost.usd_micros > 1e14
    || !Number.isSafeInteger(cost.unpriced_tokens) || cost.unpriced_tokens < 0 || cost.unpriced_tokens > tokens
    || !Array.isArray(cost.models) || cost.models.length > 128
    || !Array.isArray(cost.unpriced_models) || cost.unpriced_models.length > 128
    || Object.keys(cost).some(k => !['basis','currency','usd_micros','models','unpriced_models','unpriced_tokens'].includes(k))) throw new Error('invalid cost');
  const names = new Set(); let total = 0;
  const nameValid = s => typeof s === 'string' && s.length > 0 && s.length <= 60 && !names.has(s);
  for (const pair of cost.models) {
    if (!Array.isArray(pair) || pair.length !== 2 || !nameValid(pair[0])
      || !Number.isSafeInteger(pair[1]) || pair[1] < 0 || pair[1] > cost.usd_micros) throw new Error('invalid cost model');
    names.add(pair[0]); total += pair[1];
  }
  if (total !== cost.usd_micros) throw new Error('invalid cost total');
  for (const name of cost.unpriced_models) { if (!nameValid(name)) throw new Error('invalid unpriced model'); names.add(name); }
}

export function buildCosts(rows) {
  let total = 0, missing = 0, unpricedTokens = 0;
  const models = new Map(), unpriced = new Set();
  for (const row of rows) {
    if (!row.tokens && !row.requests) continue;
    let cost;
    try { cost = JSON.parse(row.cost_json || 'null'); validateCost(cost, row.tokens); } catch { cost = null; }
    if (!cost) { missing++; continue; }
    total += cost.usd_micros; unpricedTokens += cost.unpriced_tokens;
    for (const [name, amount] of cost.models) models.set(name, (models.get(name) || 0) + amount);
    for (const name of cost.unpriced_models) unpriced.add(name);
  }
  const available = models.size > 0 && Number.isSafeInteger(total);
  return { basis: 'token_watcher_api_estimate', currency: 'USD',
    status: !available ? 'unavailable' : missing || unpriced.size ? 'partial' : 'complete',
    usd_micros: available ? total : null, missing_days: missing, unpriced_tokens: unpricedTokens,
    models: [...models].map(([name, usd_micros]) => ({ name, usd_micros })).sort((a,b) => b.usd_micros-a.usd_micros || a.name.localeCompare(b.name)),
    unpriced_models: [...unpriced].sort() };
}
