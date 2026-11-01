import { analyticsRows, aggregateAnalytics } from './analytics.js';

/** D1 aggregates both classifications in one read transaction, without loading raw lifetime history. */
export async function analyticsBundle(env, query) {
  const rows=await analyticsRows(env,{...query,dimension:'both'}),result={};
  for(const dimension of ['tools','models'])result[dimension]=aggregateAnalytics({...rows,dimension,
    details:rows.details.filter(r=>r.dimension===dimension),dayDetails:rows.dayDetails.filter(r=>r.dimension===dimension)}).data;
  return result;
}
