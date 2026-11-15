// After a hand-over (`dispatch move`) the same conversation id exists on two Macs: the original is
// marked moved_to on its Mac, the copy that took over moved_from on the other. Lists show it once,
// where it lives now; the other copy folds under that row (`copies`) and can still be opened read-only.

/** The folded-away copy of a conversation on another Mac. */
export type HostCopy = { host: string; host_name?: string; last_at: number; moved_to_name?: string };
type CopyRow = {
  session_id: string; agent?: string; host?: string; host_name?: string; remote?: boolean; last_at?: number; last_ts?: string; unread?: boolean;
  moved_to?: string; moved_to_name?: string; moved_from?: string; moved_from_name?: string; moved_at?: number;
};
/** `copies`: the other Macs' copies folded under this row. `twin_live`: the other Macs where the same
 *  conversation is running too. `forked`: the other Macs whose copy went on after the move too. In
 *  both cases the rows stay apart, with a warning: they write two different endings. */
export type Folded<T> = T & { copies?: HostCopy[]; twin_live?: string[]; forked?: string[] };

/** Seconds a copy must go on past the move (or past the other copy) before it counts as "went on". */
export const MOVE_GAP = 120;

const hostOf = (r: { host?: string }) => r.host ?? 'local';
const nameOf = (r: { host?: string; host_name?: string }) => r.host_name ?? hostOf(r);
/** When the conversation last said something: the transcript's own last timestamp, else the row's time. */
export const contentAt = (r: { last_at?: number; last_ts?: string }) => {
  const t = r.last_ts ? Date.parse(r.last_ts) / 1000 : NaN;
  return Number.isFinite(t) ? t : r.last_at ?? 0;
};

/** One row per conversation across Macs. Only rows of the same id are touched:
 *  - a lone original (moved_to, the other Mac's copy not listed) is hidden, unless it runs or went on
 *    after the move;
 *  - when two records both say moved_to, the newer one counts: the older one is from an earlier move
 *    (A to B and back to A with the second record missing on A);
 *  - running on two Macs, or the original went on after the move: both stay, each names the other;
 *  - no records, nothing running and neither copy went on past the other: both stay, nothing says
 *    which one took over;
 *  - otherwise the running copy wins, else the one not marked moved_to (preferring moved_from), else
 *    the newest. The others fold into its `copies`; with no record it says 迁移自 <the other Mac>.
 *  Wherever rows stay apart, `unread` shows on one of them at most.
 *  `isLive` says whether a row's process runs now; `lastAt` how recent it is (seconds). */
export function foldHostCopies<T extends CopyRow>(rows: T[], isLive: (r: T) => boolean = () => false, lastAt: (r: T) => number = contentAt): Folded<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.session_id || r.session_id.startsWith('pid-')) continue;
    const g = groups.get(r.session_id); if (g) g.push(r); else groups.set(r.session_id, [r]);
  }
  const replace = new Map<T, Folded<T> | null>();
  // Keep unread on exactly one row of those that stay apart: the preferred one when it has it, else the first unread.
  const unreadOnce = (keep: T[], preferred: T) => {
    const holder = preferred.unread ? preferred : keep.find((r) => r.unread);
    for (const r of keep) if (r !== holder && r.unread) replace.set(r, { ...(replace.get(r) ?? r), unread: false });
  };
  for (const g of groups.values()) {
    const hosts = new Set(g.map(hostOf));
    if (hosts.size < 2) {
      // Only this Mac's original is listed (the other Mac is offline or has no row for it).
      for (const r of g) {
        if (!r.moved_to || isLive(r)) continue;
        if (r.moved_at && lastAt(r) - r.moved_at >= MOVE_GAP) replace.set(r, { ...r, forked: [r.moved_to_name ?? r.moved_to] });
        else replace.set(r, null);
      }
      continue;
    }
    // Two copies both say moved_to: the newer record counts, and the older one is from an earlier move
    // (this copy took over since). Without times (a peer on an older CLI) the copy that said something
    // last is the one that took over.
    const tos = g.filter((r) => r.moved_to);
    const source = tos.length < 2 ? tos[0]
      : tos.every((r) => r.moved_at) ? tos.reduce((a, b) => ((b.moved_at ?? 0) > (a.moved_at ?? 0) ? b : a))
      : tos.reduce((a, b) => (lastAt(b) < lastAt(a) ? b : a));
    const superseded = (r: T) => !!r.moved_to && r !== source;
    const movedTo = (r: T) => !!r.moved_to && !superseded(r);
    const movedFrom = (r: T) => !!r.moved_from || superseded(r);
    const moveAt = Math.max(0, ...g.filter((r) => movedTo(r) || r.moved_from).map((r) => r.moved_at ?? 0));
    const anyRecord = g.some((r) => r.moved_to || r.moved_from);
    const rank = (r: T) => [isLive(r) ? 1 : 0, movedTo(r) ? 0 : 1, movedFrom(r) ? 1 : 0, lastAt(r)];
    const sorted = [...g].sort((x, y) => { const a = rank(x), b = rank(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i]; return 0; });
    const winner = sorted[0];
    const fixed = (r: T): T => superseded(r)
      ? { ...r, moved_to: undefined, moved_to_name: undefined, moved_from: r.moved_from ?? r.moved_to, moved_from_name: r.moved_from_name ?? nameOf(source ?? sorted[1]) }
      : r;
    const live = g.filter(isLive);
    if (new Set(live.map(hostOf)).size > 1) {
      for (const r of g) {
        const others = live.filter((x) => hostOf(x) !== hostOf(r)).map(nameOf);
        replace.set(r, { ...fixed(r), ...(others.length ? { twin_live: others } : {}) });
      }
      unreadOnce(g, winner);
      continue;
    }
    const rest = sorted.slice(1);
    // Copies that went on after the move (or, with no record, as late as the winner): not "from before the move".
    const wentOn = rest.filter((r) => (moveAt && lastAt(r) - moveAt >= MOVE_GAP) || (!anyRecord && !isLive(winner) && lastAt(winner) - lastAt(r) < MOVE_GAP));
    if (wentOn.length) {
      const apart = [winner, ...wentOn];
      for (const r of apart) {
        const others = anyRecord ? apart.filter((x) => hostOf(x) !== hostOf(r)).map(nameOf) : [];
        replace.set(r, { ...fixed(r), ...(others.length ? { forked: others } : {}) });
      }
    }
    const folded = rest.filter((r) => !wentOn.includes(r));
    if (folded.length) {
      const copies = folded.map((r) => ({ host: hostOf(r), host_name: r.host_name, last_at: lastAt(r), ...(r.moved_to_name && movedTo(r) ? { moved_to_name: r.moved_to_name } : {}) }));
      const w = replace.get(winner) ?? fixed(winner);
      const from = !anyRecord ? nameOf(folded[0]) : undefined;
      replace.set(winner, { ...w, copies, ...(from && !w.moved_from_name ? { moved_from_name: from } : {}) });
      for (const r of folded) replace.set(r, null);
    } else if (!replace.has(winner) && winner !== fixed(winner)) replace.set(winner, fixed(winner));
    if (wentOn.length) unreadOnce([winner, ...wentOn], winner);
  }
  if (!replace.size) return rows;
  const out: Folded<T>[] = [];
  for (const r of rows) { const x = replace.get(r); if (x === undefined) out.push(r); else if (x) out.push(x); }
  return out;
}

/** Rows by id, this Mac's first: its copy keeps the bare id, another Mac's copy of the same id is id@host. */
export function refMap<T extends { session_id: string; host?: string; remote?: boolean }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of [...rows].sort((a, b) => Number(!!a.remote) - Number(!!b.remote))) m.set(m.has(r.session_id) ? `${r.session_id}@${r.host}` : r.session_id, r);
  return m;
}

export type MigrationCheck = { project: string; host: string; cwd: string; target: string; remoteCwd: string; conflicts: string[] };

export function migrationCheckPrompt(check: MigrationCheck): string {
  return [
    `检查项目 ${check.project} 迁移到 ${check.target} 被拦截的原因。`,
    `来源机器：${check.host}；来源目录：${check.cwd}`,
    `目标机器：${check.target}；目标目录：${check.remoteCwd}`,
    '预检发现：', ...check.conflicts.map(c => `- ${c}`),
    '先只读检查两台机器的 Git 状态、独有提交、未提交及未跟踪文件，列出迁移会覆盖的具体内容，并给出保留两边工作的处理方案。',
    '不要执行迁移、--force、reset、clean、删除或覆盖文件，也不要关闭现有会话。检查结果直接回复，等用户决定如何处理。',
  ].join('\n');
}
