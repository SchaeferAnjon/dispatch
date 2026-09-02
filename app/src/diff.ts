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
