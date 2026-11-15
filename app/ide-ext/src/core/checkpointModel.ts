// Checkpoints (`dispatch checkpoint list`, PLAN.md §3.5): one per agent turn. The CLI arrives with
// P4; until then it answers {ok: false, error: "unsupported"} and the view says so.

export interface Turn {
  id: string;
  messageId: string;
  sid: string;
  ts: number;
  files: string[];
  text: string;
}

export type CheckpointList = { available: false; reason: string } | { available: true; turns: Turn[] };

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function num(v: unknown): number {
  if (typeof v === "number" && isFinite(v)) return v > 1e12 ? v / 1000 : v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (isFinite(n)) return n > 1e12 ? n / 1000 : n;
    const d = Date.parse(v);
    if (!isNaN(d)) return d / 1000;
  }
  return 0;
}

function files(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((f) => (typeof f === "string" ? f : f && typeof f === "object" ? str((f as { path?: unknown }).path) : "")).filter(Boolean);
}

/** Read whatever `checkpoint list --json` printed: {turns: [...]}, {checkpoints: [...]} or a bare list. */
export function parseCheckpoints(ans: unknown): CheckpointList {
  if (ans && typeof ans === "object" && !Array.isArray(ans)) {
    const a = ans as Record<string, unknown>;
    if (a.ok === false) return { available: false, reason: str(a.error) || "unsupported" };
  }
  const rows = Array.isArray(ans)
    ? ans
    : ans && typeof ans === "object"
      ? ((ans as Record<string, unknown>).turns ?? (ans as Record<string, unknown>).checkpoints)
      : undefined;
  if (!Array.isArray(rows)) return { available: false, reason: "unsupported" };
  const turns: Turn[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = str(o.turn_id ?? o.turn ?? o.id);
    if (!id) continue;
    turns.push({
      id,
      messageId: str(o.message_id),
      sid: str(o.sid ?? o.session),
      ts: num(o.ts ?? o.at ?? o.created_at),
      files: files(o.files_changed ?? o.files),
      text: str(o.text ?? o.prompt ?? o.message ?? o.title),
    });
  }
  turns.sort((a, b) => b.ts - a.ts);
  return { available: true, turns };
}

/** Restore answer: done, or the files that changed after the turn (conflict). */
export function parseRestore(ans: unknown): { ok: true; files: string[] } | { ok: false; conflict: boolean; files: string[]; message: string } {
  const a = (ans || {}) as Record<string, unknown>;
  if (a.ok === false) {
    return { ok: false, conflict: a.error === "conflict", files: files(a.files), message: str(a.message) || str(a.error) };
  }
  return { ok: true, files: files(a.restored ?? a.files) };
}

export type PlanAction = "restore" | "delete" | "create";
export interface PlanRow {
  path: string;
  action: PlanAction;
  /** changed after the agents finished, or a new file no agent edit tool wrote */
  conflict: boolean;
  /** a new file no agent edit tool wrote (maybe the user's) */
  unsure: boolean;
}
export type RestorePlan = { ok: true; rows: PlanRow[]; conflicts: number; running: string[] } | { ok: false; message: string };

/** `checkpoint restore --dry-run`: every file the restore touches (later turns included), conflicts first. */
export function parsePlan(ans: unknown): RestorePlan {
  const a = (ans || {}) as Record<string, unknown>;
  if (a.ok === false) return { ok: false, message: str(a.message) || str(a.error) || "failed" };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const conflicts = new Set(list(a.conflicts));
  const unsure = new Set(list(a.unsure));
  const rows: PlanRow[] = [];
  for (const f of Array.isArray(a.files) ? a.files : []) {
    const o = (f || {}) as Record<string, unknown>;
    const p = str(o.path);
    if (!p) continue;
    const action: PlanAction = o.action === "delete" || o.action === "create" ? o.action : "restore";
    rows.push({ path: p, action, conflict: conflicts.has(p), unsure: unsure.has(p) });
  }
  rows.sort((x, y) => Number(y.conflict) - Number(x.conflict) || x.path.localeCompare(y.path));
  return { ok: true, rows, conflicts: rows.filter((r) => r.conflict).length, running: list(a.running) };
}
