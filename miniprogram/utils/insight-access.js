// All insight entries are free today. A future rewarded-ad adapter can supply
// an opaque grant, which the data API must independently verify on the server.
let provider = null;
function setInsightAccessProvider(value) { provider = typeof value === 'function' ? value : null; }
async function openInsight({ policy, feature, context, current = () => true }, open) {
  if (!policy || policy.feature !== feature) throw new Error('数据入口暂不可用，请刷新后重试');
  if (!current()) return false;
  if (policy.mode === 'free') { await open(null); return true; }
  if (policy.mode !== 'rewarded' || !provider) throw new Error('该数据入口暂未开放');
  const result = await provider({ feature, context });
  if (!current() || result?.completed !== true || typeof result.grant !== 'string' || !result.grant) return false;
  await open(result.grant); return true;
}
module.exports = { openInsight, setInsightAccessProvider };
