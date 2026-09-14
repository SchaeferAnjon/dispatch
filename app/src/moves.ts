// After a hand-over (`dispatch move`) the same conversation id exists on two Macs: the original is
// marked moved_to, the copy that took over is not. Once both are in a list, keep only the one that
// lives on — every list then shows the conversation where it is now. A lone original stays (the other
// Mac is offline), still tagged 已迁往.
export function dropMovedOriginals<T extends { session_id: string; moved_to?: string }>(rows: T[]): T[] {
  const current = new Set(rows.filter((r) => !r.moved_to).map((r) => r.session_id));
  return rows.filter((r) => !r.moved_to || !current.has(r.session_id));
}
