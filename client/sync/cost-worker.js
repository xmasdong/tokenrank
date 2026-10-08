import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readDays } from './source.js';

const [root, path, timestamp] = process.argv.slice(2), now = Number(timestamp);
if (process.env.TOKENMETER_OFFLINE !== '1' || !Number.isSafeInteger(now)) throw new Error('offline pricing required');
const moduleAt = name => import(pathToFileURL(join(root, 'src', name)).href);
const { aggregateCosts, loadPricing, PEAK_SQL } = await moduleAt('pricing.js');
const { ensurePrices } = await moduleAt('litellm.js');
const { ensureFxRate } = await moduleAt('fx.js');
const table = await loadPricing(), fx = await ensureFxRate(table);
if (!(fx.rate > 0) || !Number.isFinite(fx.rate)) throw new Error('invalid exchange rate');
await ensurePrices();

// Compact rows preserve every pricing dimension (tool/model/peak) without copying raw logs.
// Only this in-memory database is writable; the original is held in one read-only snapshot.
const memory = new DatabaseSync(':memory:');
memory.exec('CREATE TABLE events(ts INTEGER,tool TEXT,model TEXT,input_tokens INTEGER,cached_input INTEGER,cache_write INTEGER,output_tokens INTEGER)');
const insert = memory.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)');
try {
  const days = readDays(path, { now, costing(db, from, to) {
    const rows = db.prepare(`SELECT CAST((ts+28800000)/86400000 AS INTEGER) daynum,
      MIN(ts) ts, tool, model, ${PEAK_SQL} peak, SUM(input_tokens) fi, SUM(cached_input) ci,
      SUM(cache_write) cw, SUM(output_tokens) oi, SUM(total_tokens) tokens
      FROM events WHERE ts >= ? AND ts <= ? GROUP BY daynum,tool,model,peak ORDER BY daynum`).all(from, to);
    const groups = new Map(), result = new Map();
    for (const row of rows) { if (!groups.has(row.daynum)) groups.set(row.daynum, []); groups.get(row.daynum).push(row); }
    for (const [day, items] of groups) {
      memory.exec('DELETE FROM events; BEGIN');
      for (const r of items) insert.run(r.ts, r.tool, r.model, r.fi, r.ci, r.cw, r.oi);
      memory.exec('COMMIT');
      const aggregate = aggregateCosts(memory, 0, { rate: fx.rate, table: table.models || {} });
      const priced = new Set(aggregate.by_model.map(m => m.model));
      const models = new Map(), unpriced = new Set();
      let unpricedTokens = 0;
      for (const m of aggregate.by_model) {
        const amount = Math.round(m.cost_cny / fx.rate * 1e6), name = String(m.model || '未知模型').slice(0, 60);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e14) throw new Error('invalid cost');
        models.set(name, (models.get(name) || 0) + amount);
      }
      for (const r of items) if (!priced.has(r.model) && (r.tokens > 0 || r.fi || r.ci || r.cw || r.oi)) {
        unpriced.add(String(r.model || '未知模型').slice(0, 60)); unpricedTokens += r.tokens;
      }
      if (models.size > 128 || unpriced.size > 128) continue;
      const detail = [...models].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
      const total = detail.reduce((sum, m) => sum + m[1], 0);
      if (!Number.isSafeInteger(total) || total > 1e14) throw new Error('invalid total cost');
      result.set(day, { basis: 'token_watcher_api_estimate', currency: 'USD', usd_micros: total,
        models: detail, unpriced_models: [...unpriced].sort(), unpriced_tokens: unpricedTokens });
    }
    return result;
  } });
  process.stdout.write(JSON.stringify(days));
} finally { memory.close(); }
