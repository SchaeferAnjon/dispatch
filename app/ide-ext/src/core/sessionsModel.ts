// `dispatch sessions --json` rows, as the status bar and the Sessions view need them.

export interface SessionRow {
  agent?: string;
  session_id?: string;
  cwd?: string;
  project?: string;
  title?: string | null;
  state?: string;
  alive?: boolean;
  herdr?: { title?: string } | null;
}

export interface SessionItem {
  key: string;
  label: string;
  agent: string;
  state: string;
  cwd: string;
  here: boolean;
}

function inside(cwd: string, root: string): boolean {
  if (!cwd || !root) return false;
  const r = root.replace(/\/+$/, "");
  return cwd === r || cwd.startsWith(r + "/");
}

/** Live sessions, the ones working in `root` first, then busy before idle. */
export function sessionItems(rows: unknown, root: string): SessionItem[] {
  if (!Array.isArray(rows)) return [];
  const out: SessionItem[] = [];
  for (const r of rows as SessionRow[]) {
    if (!r || r.alive === false || !r.session_id) continue;
    const agent = r.agent || "agent";
    const title = (r.title || r.herdr?.title || "").replace(/^[^\p{L}\p{N}]+\s*/u, "").trim();
    out.push({
      key: `${agent}:${r.session_id}`,
      label: title || `${agent} · ${r.project || r.cwd || ""}`,
      agent,
      state: r.state || "unknown",
      cwd: r.cwd || "",
      here: inside(r.cwd || "", root),
    });
  }
  const rank = (s: SessionItem) => (s.here ? 0 : 2) + (s.state === "working" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function sessionSummary(items: SessionItem[]): { total: number; here: number; working: number } {
  return { total: items.length, here: items.filter((s) => s.here).length, working: items.filter((s) => s.state === "working").length };
}
