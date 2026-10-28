// Summarize upstream per-file scan failures by tool and reason. Paths are replaced, since they name the
// user's projects and sessions and this text is often pasted into chats.
export function describeScanErrors(stats) {
  const parts = [];
  let total = 0;
  for (const [tool, item] of Object.entries(stats || {})) {
    if (!item?.parse_errors) continue;
    total += item.parse_errors;
    const reason = String(item.last_error || '').replace(/^\d{4}-\d{2}-\d{2}T\S+\s*/, '')
      .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;)]+/g, '<路径>').trim().slice(0, 120);
    parts.push(`${tool} ${item.parse_errors} 个${reason ? `：${reason}` : ''}`);
  }
  return total ? { total, text: `原版有 ${total} 个文件扫描失败（${parts.join('；')}）` } : null;
}
