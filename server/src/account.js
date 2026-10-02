/** D1 batch is a transaction: ownership, credentials and data disappear together. */
export async function deleteAccount(env, userId) {
  const sql = text => env.DB.prepare(text).bind(userId);
  await env.DB.batch([
    sql(`UPDATE rank_groups SET owner_user_id=(
      SELECT m.user_id FROM rank_group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=rank_groups.id AND m.user_id<>?1 ORDER BY m.joined_at,m.user_id LIMIT 1
    ) WHERE owner_user_id=?1 AND EXISTS(
      SELECT 1 FROM rank_group_members m JOIN users u ON u.id=m.user_id
      WHERE m.group_id=rank_groups.id AND m.user_id<>?1)`),
    sql('DELETE FROM rank_group_members WHERE user_id=?1 OR group_id IN (SELECT id FROM rank_groups WHERE owner_user_id=?1)'),
    sql('DELETE FROM rank_groups WHERE owner_user_id=?1'),
    ...['sync_agents', 'usage_replacement_chunks', 'usage_replacements', 'usage_rebuild_guard',
      'daily_totals', 'daily_stats', 'usage_sync_state', 'usage_shares', 'user_avatars',
      'connect_tokens', 'mp_sessions'].map(table => sql(`DELETE FROM ${table} WHERE user_id=?1`)),
    sql('DELETE FROM users WHERE id=?1'),
  ]);
}
