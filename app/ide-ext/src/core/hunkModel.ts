// Agent hunks (`dispatch editor hunks`, app/src/editor/CONTRACT.md 三): which session owns a file,
// what to paint, which hunk the cursor means.

export interface AgentHunk {
  id: string;
  index: number;
  kind: "add" | "del" | "mod";
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  old_text: string;
  new_text: string;
}

export interface SessionIndex {
  sid: string;
  /** the session's working folder (index.json "root") */
  root: string;
  files: Record<string, { captured_at?: number }>;
  /** index.json mtime, ms */
  mtime: number;
}

/** "claude-code__abc" (folder name) → "claude-code:abc" (session key). */
export function sidFromDir(name: string): string {
  const i = name.indexOf("__");
  return i < 0 ? name : name.slice(0, i) + ":" + name.slice(i + 2);
}

function under(file: string, root: string): string | undefined {
  const r = root.endsWith("/") ? root : root + "/";
  if (!file.startsWith(r)) return undefined;
  return file.slice(r.length);
}

/**
 * The session whose agent edited `file` (absolute, forward slashes): the index that has a baseline
 * for it, the most recently captured one when several sessions touched it. `preferred` (the
 * session the IDE was opened for) wins when it has the file.
 */
export function pickSession(indexes: SessionIndex[], file: string, preferred = ""): { sid: string; root: string; key: string } | undefined {
  let best: { sid: string; root: string; key: string; at: number } | undefined;
  for (const ix of indexes) {
    const key = under(file, ix.root);
    if (!key || !(key in ix.files)) continue;
    const at = ix.sid === preferred ? Number.MAX_SAFE_INTEGER : Math.max(ix.files[key]?.captured_at || 0, ix.mtime / 1000);
    if (!best || at > best.at) best = { sid: ix.sid, root: ix.root, key, at };
  }
  return best && { sid: best.sid, root: best.root, key: best.key };
}

/**
 * The session the IDE was opened for in the folder that holds `file`: `dispatch ide start` writes
 * ide/sessions.json ({root: {sid, at}}) on every open. The code-server process is shared by every
 * later folder and session, so its DISPATCH_IDE_SID (the first open's) is only the fallback when
 * sessions.json names no folder around the file.
 */
export function preferredSid(sessions: unknown, file: string, fallback = ""): string {
  if (!sessions || typeof sessions !== "object") return fallback;
  let best: { len: number; sid: string } | undefined;
  for (const [root, v] of Object.entries(sessions as Record<string, unknown>)) {
    if (!under(file, root.replace(/\\/g, "/")) && file !== root) continue;
    const sid = v && typeof v === "object" && typeof (v as { sid?: unknown }).sid === "string" ? (v as { sid: string }).sid : "";
    if (!best || root.length > best.len) best = { len: root.length, sid };
  }
  return best ? best.sid : fallback;
}

export interface Paint {
  /** 0-based lines, inclusive, shown as added / changed */
  added: Array<[number, number]>;
  /** 0-based line under which deleted lines were (a hunk that only removed) */
  removedAt: number[];
  /** 0-based line where each hunk's CodeLens sits, same order as the hunks */
  lens: number[];
}

export function paint(hunks: AgentHunk[], lineCount: number): Paint {
  const out: Paint = { added: [], removedAt: [], lens: [] };
  const last = Math.max(0, lineCount - 1);
  for (const h of hunks) {
    const first = Math.min(Math.max(0, h.new_start - 1), last);
    if (h.new_lines > 0) out.added.push([first, Math.min(first + h.new_lines - 1, last)]);
    else out.removedAt.push(first);
    out.lens.push(first);
  }
  return out;
}

/** The hunk the cursor (0-based line) is in; else the next one below; else the first. */
export function hunkAt(hunks: AgentHunk[], line: number): AgentHunk | undefined {
  const l = line + 1;
  const inside = hunks.find((h) => l >= h.new_start && l < h.new_start + Math.max(1, h.new_lines));
  if (inside) return inside;
  return hunks.find((h) => h.new_start >= l) ?? hunks[0];
}

export function nextHunk(hunks: AgentHunk[], line: number, dir: 1 | -1): AgentHunk | undefined {
  if (!hunks.length) return undefined;
  const l = line + 1;
  if (dir > 0) return hunks.find((h) => h.new_start > l) ?? hunks[0];
  const before = hunks.filter((h) => h.new_start < l);
  return before.length ? before[before.length - 1] : hunks[hunks.length - 1];
}

/** What the removed / replaced lines were, for the hover. */
export function oldPreview(h: AgentHunk, max = 30): string {
  const lines = h.old_text.replace(/\n$/, "").split("\n");
  const cut = lines.length > max ? [...lines.slice(0, max), `… (+${lines.length - max})`] : lines;
  return cut.join("\n");
}
