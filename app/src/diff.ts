// Minimal line diff (LCS) for rendering Edit old/new pairs. Inputs are small
// (a single tool call), so O(n·m) is fine; very large inputs fall back to a
// plain replace view.
export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((t) => ({ kind: "del" as const, text: t })), ...b.map((t) => ({ kind: "add" as const, text: t }))];
  }
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: "del", text: a[i] }); i++; }
    else { out.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

// Collapse long runs of unchanged lines, keeping `ctx` lines around changes.
export function withContext(lines: DiffLine[], ctx = 2): (DiffLine | { kind: "skip"; count: number })[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.kind !== "same") for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true; });
  const out: (DiffLine | { kind: "skip"; count: number })[] = [];
  let skip = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (skip) { out.push({ kind: "skip", count: skip }); skip = 0; } out.push(l); }
    else skip++;
  });
  if (skip) out.push({ kind: "skip", count: skip });
  return out;
}

// ---- intra-line highlight: which words changed between a removed line and the added
// line that replaced it. Tokens are words / whitespace / single punctuation; an LCS over
// tokens marks the rest as changed. Pairs are only formed inside one replace block
// (a run of "del" followed by a run of "add"), i-th del with i-th add.
export type Seg = { text: string; changed: boolean };

const tokens = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

export function inlineDiff(a: string, b: string): { a: Seg[]; b: Seg[] } {
  const ta = tokens(a), tb = tokens(b);
  const n = ta.length, m = tb.length;
  if (n * m > 40_000 || n === 0 || m === 0) return { a: [{ text: a, changed: a !== "" }], b: [{ text: b, changed: b !== "" }] };
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const sa: Seg[] = [], sb: Seg[] = [];
  const push = (arr: Seg[], text: string, changed: boolean) => { const last = arr[arr.length - 1]; if (last && last.changed === changed) last.text += text; else arr.push({ text, changed }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push(sa, ta[i], false); push(sb, tb[j], false); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(sa, ta[i], true); i++; }
    else { push(sb, tb[j], true); j++; }
  }
  while (i < n) push(sa, ta[i++], true);
  while (j < m) push(sb, tb[j++], true);
  // A line where almost everything changed reads better as a plain replace than as confetti.
  const ratio = (s: Seg[], len: number) => s.filter((x) => x.changed).reduce((t, x) => t + x.text.length, 0) / Math.max(1, len);
  if (ratio(sa, a.length) > 0.7 && ratio(sb, b.length) > 0.7) return { a: [{ text: a, changed: false }], b: [{ text: b, changed: false }] };
  return { a: sa, b: sb };
}

// ---- rows for rendering: line numbers on both sides, skip markers, word segments.
export type DiffRow =
  | { kind: "same" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null; segs?: Seg[] }
  | { kind: "skip"; count: number; start: number }
  | { kind: "hunk"; text: string };

// From an old/new pair (Edit / Write tool input): every line, numbered on both sides. Line
// numbers are relative to the snippet unless `oldStart`/`newStart` are given.
export function pairRows(oldText: string, newText: string, oldStart = 1, newStart = 1): DiffRow[] {
  let o = oldStart, nn = newStart;
  const rows: Exclude<DiffRow, { kind: "skip" | "hunk" }>[] = lineDiff(oldText, newText).map((l) => (
    l.kind === "same" ? { kind: "same", text: l.text, oldNo: o++, newNo: nn++ } : l.kind === "del" ? { kind: "del", text: l.text, oldNo: o++, newNo: null } : { kind: "add", text: l.text, oldNo: null, newNo: nn++ }
  ));
  markPairs(rows);
  return rows;
}

// Hide long runs of unchanged lines, keeping `ctx` around each change. `open` holds the
// start indexes (into `rows`) of runs the reader has expanded.
export function collapse(rows: DiffRow[], ctx = 3, open: ReadonlySet<number> = new Set()): DiffRow[] {
  const keep = rows.map((r) => r.kind !== "same");
  rows.forEach((r, i) => { if (r.kind !== "same") for (let k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) keep[k] = true; });
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) { out.push(rows[i++]); continue; }
    let j = i; while (j < rows.length && !keep[j]) j++;
    if (j - i <= 2 || open.has(i)) out.push(...rows.slice(i, j));
    else out.push({ kind: "skip", count: j - i, start: i });
    i = j;
  }
  return out;
}

// Pair each "del" with the "add" at the same offset inside a replace block and attach segments.
function markPairs(rows: Exclude<DiffRow, { kind: "skip" | "hunk" }>[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") { i++; continue; }
    let j = i; while (j < rows.length && rows[j].kind === "del") j++;
    let k = j; while (k < rows.length && rows[k].kind === "add") k++;
    const dels = rows.slice(i, j), adds = rows.slice(j, k);
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const d = inlineDiff(dels[p].text, adds[p].text);
      if (d.a.some((s) => s.changed) || d.b.some((s) => s.changed)) { dels[p].segs = d.a; adds[p].segs = d.b; }
    }
    i = k;
  }
}

// From unified-diff text (git diff, apply_patch): real line numbers from the @@ headers.
export function patchRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0, nn = 0, inHunk = false;
  const block: Exclude<DiffRow, { kind: "skip" | "hunk" }>[] = [];
  const flush = () => { if (block.length) { markPairs(block); rows.push(...block); block.length = 0; } };
  for (const ln of text.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(ln);
    if (h) { flush(); o = +h[1]; nn = +h[2]; inHunk = true; rows.push({ kind: "hunk", text: ln }); continue; }
    if (!inHunk) { if (ln.trim()) rows.push({ kind: "hunk", text: ln }); continue; }
    if (ln.startsWith("+")) block.push({ kind: "add", text: ln.slice(1), oldNo: null, newNo: nn++ });
    else if (ln.startsWith("-")) block.push({ kind: "del", text: ln.slice(1), oldNo: o++, newNo: null });
    else if (ln.startsWith("\\")) continue; // "\ No newline at end of file"
    else { flush(); if (ln === "" ) continue; rows.push({ kind: "same", text: ln.slice(1), oldNo: o++, newNo: nn++ }); }
  }
  flush();
  return rows;
}

export const diffStat = (rows: DiffRow[]) => rows.reduce((s, r) => (r.kind === "add" ? { ...s, add: s.add + 1 } : r.kind === "del" ? { ...s, del: s.del + 1 } : s), { add: 0, del: 0 });

// ---- Codex apply_patch: its own tiny patch DSL ("*** Begin Patch / *** Update File: … / @@ … /
// +/-/space lines / *** End Patch"), not a real unified diff — no numbered @@ headers, so
// patchRows (which gates on those) would show it as inert text. Line numbers here are relative to
// the hunk (Codex's patches don't carry real ones either).
export function codexPatchRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const block: Exclude<DiffRow, { kind: "skip" | "hunk" }>[] = [];
  let o = 1, nn = 1;
  const flush = () => { if (block.length) { markPairs(block); rows.push(...block); block.length = 0; } };
  for (const raw of text.split("\n")) {
    if (raw.startsWith("*** ") || raw.startsWith("@@")) {
      flush();
      if (raw !== "*** Begin Patch" && raw !== "*** End Patch") rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) { block.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: nn++ }); continue; }
    if (raw.startsWith("-")) { block.push({ kind: "del", text: raw.slice(1), oldNo: o++, newNo: null }); continue; }
    flush();
    if (raw === "") continue;
    rows.push({ kind: "same", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: o++, newNo: nn++ });
  }
  flush();
  return rows;
}

// ---- turning a tool call's (capped) input into something diffable, the same way across agents:
// Claude Code's Edit/MultiEdit/Write/NotebookEdit, pi's lowercase edit/write, Codex's apply_patch
// and edit_file/write_file (a plain overwrite — no old text to diff against). Field names come
// straight from `_compact_input` in cli/dispatch.py (a cross-end contract); this only reads them.
export type ToolDiff =
  | { kind: "pair"; path: string; old: string; new: string; truncated: boolean }
  | { kind: "edits"; path: string; edits: { old: string; new: string }[]; truncated: boolean }
  | { kind: "write"; path: string; new: string; truncated: boolean }
  | { kind: "patch"; path: string; text: string; truncated: boolean };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function diffOfTool(rawName: string, input: Record<string, unknown>): ToolDiff | null {
  const name = rawName.split(".").pop() || rawName;
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path) || str(input.filePath) || "";
  const truncated = input.truncated === true;
  switch (name) {
    case "Edit":
    case "edit": {
      const old = str(input.old_string ?? input.oldText);
      const next = str(input.new_string ?? input.newText);
      return old || next ? { kind: "pair", path, old, new: next, truncated } : null;
    }
    case "MultiEdit": {
      const list = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      const edits = list.map((e) => ({ old: str(e.old_string), new: str(e.new_string) })).filter((e) => e.old || e.new);
      return edits.length ? { kind: "edits", path, edits, truncated } : null;
    }
    case "Write":
    case "write":
    case "write_file":
    case "edit_file": {
      const next = str(input.content ?? input.newText);
      return { kind: "write", path, new: next, truncated };
    }
    case "NotebookEdit": {
      const next = str(input.new_source);
      return next ? { kind: "write", path, new: next, truncated } : null;
    }
    case "apply_patch":
    case "patch": {
      const text = str(input.input) || str(input.value);
      if (!text) return null;
      const paths = [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
      return { kind: "patch", path: path || paths.join(", "), text, truncated };
    }
    default:
      return null;
  }
}

// Diff rows to render for a ToolDiff, one block per hunk (MultiEdit has one per edit; every other
// kind is a single block) — `label` (when given) heads that block.
export function diffRows(diff: ToolDiff): { label?: string; rows: DiffRow[] }[] {
  if (diff.kind === "patch") return [{ rows: codexPatchRows(diff.text) }];
  if (diff.kind === "write") return [{ rows: pairRows("", diff.new) }];
  if (diff.kind === "pair") return [{ rows: pairRows(diff.old, diff.new) }];
  return diff.edits.map((e, i) => ({ label: `第 ${i + 1} 处`, rows: pairRows(e.old, e.new) }));
}

// A tool call's file_path is absolute; show it relative to the session's cwd when it lives there.
export function relPath(full: string, cwd?: string): string {
  if (!full || !cwd) return full;
  const base = cwd.replace(/\/+$/, "");
  return full === base ? full : full.startsWith(base + "/") ? full.slice(base.length + 1) : full;
}
