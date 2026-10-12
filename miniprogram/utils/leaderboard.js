const { compact, formatTokens, integer } = require('./usage');

// The API's own rank identifies the current row, including ties and duplicate
// nicknames. Never infer identity from a name or avatar.
function presentEntry(entry, ownRank) {
  const amount = compact(entry.tokens);
  return { ...entry, tokens_fmt: formatTokens(entry.tokens), tokens_value: amount.value, tokens_unit: amount.unit,
    requests_text: integer(entry.requests), initial: [...String(entry.nickname || '').trim()][0] || '?',
    rk: { label: String(entry.rank), top3: entry.rank >= 1 && entry.rank <= 3 },
    isMe: ownRank != null && entry.rank === ownRank };
}
function presentEntries(entries, me) {
  return entries.map(entry => presentEntry(entry, me?.rank));
}
function presentMe(me) {
  return me ? presentEntry(me, me.rank) : null;
}
module.exports = { presentEntries, presentMe };
