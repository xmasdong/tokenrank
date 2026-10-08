import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCost, buildCosts } from '../src/costs.js';
import { validateTotalReport } from '../src/report.js';
const cost = (extra={}) => ({ basis:'token_watcher_api_estimate',currency:'USD',usd_micros:1500001,
  models:[['model-a',1000001],['model-b',500000]],unpriced_models:[],unpriced_tokens:0,...extra });
test('costs use integer microdollars and exact model totals; reject malformed or leaked fields', () => {
  assert.doesNotThrow(()=>validateCost(cost(),100));
  assert.doesNotThrow(()=>validateCost(null,100));
  for (const invalid of [cost({usd_micros:1}),cost({currency:'CNY'}),cost({usd_micros:NaN}),cost({token:'secret'}),
    cost({models:[['model-a',1500001],['model-a',0]]}),cost({unpriced_tokens:101}),cost({unpriced_models:['model-a']})])
    assert.throws(()=>validateCost(invalid,100));
});
test('missing and unpriced days never look like a complete zero-dollar bill; known zero is valid', () => {
  const row=c=>({tokens:100,requests:1,cost_json:c===undefined?null:JSON.stringify(c)});
  assert.equal(buildCosts([row()]).usd_micros,null);
  assert.equal(buildCosts([row(cost({models:[],usd_micros:0,unpriced_models:['unknown'],unpriced_tokens:100}))]).status,'unavailable');
  const mixed=buildCosts([row(cost()),row(),row(cost({unpriced_models:['unknown'],unpriced_tokens:20}))]);
  assert.equal(mixed.usd_micros,3000002);assert.equal(mixed.status,'partial');assert.equal(mixed.missing_days,1);
  assert.equal(mixed.models[0].usd_micros,2000002);assert.equal(mixed.unpriced_tokens,20);
  const zero=buildCosts([row(cost({usd_micros:0,models:[['free-model',0]]}))]);
  assert.equal(zero.status,'complete');assert.equal(zero.usd_micros,0);
});
