import { jsonError } from './lib.js';
export const INSIGHT_FEATURES = ['community_audience'];
export function insightPolicy(env, feature) {
  const configured = env.INSIGHTS_AUDIENCE_ACCESS || 'free';
  return { feature, mode: ['free','rewarded'].includes(configured) ? configured : 'unavailable' };
}
export function requireInsightAccess(env, feature) {
  if (!INSIGHT_FEATURES.includes(feature)) return jsonError(400, '数据入口无效');
  if (insightPolicy(env, feature).mode === 'free') return null;
  // A future reward provider must verify a server-side grant here. A client
  // callback, URL flag or local-storage value must never unlock the API.
  return Response.json({ error: '该数据入口暂未开放', code: 'INSIGHT_ACCESS_REQUIRED', feature }, { status: 403 });
}
