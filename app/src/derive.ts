import type { Column, Comment, HistoryEntry, Issue, Session, SourceKind } from "./types";

export function durSince(epochSec: number): string {
  if (!epochSec) return "";
  const m = Math.max(0, Math.round((Date.now() / 1000 - epochSec) / 60));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天`;
}

export type AgentKind = "claude" | "codex" | "zcode" | "qoder" | "cursor" | "human" | "pi";
export interface Actor { id: string; name: string; kind: AgentKind; glyph: string }

const KNOWN: Record<string, Omit<Actor, "id">> = {
  "claude-code": { name: "Claude Code", kind: "claude", glyph: "C" },
  claude: { name: "Claude Code", kind: "claude", glyph: "C" },
  codex: { name: "Codex", kind: "codex", glyph: "X" },
  zcode: { name: "ZCode", kind: "zcode", glyph: "Z" },
  qoder: { name: "Qoder", kind: "qoder", glyph: "Q" },
  "qoder-ide": { name: "Qoder IDE", kind: "qoder", glyph: "Qi" },
  pi: { name: "pi", kind: "pi", glyph: "π" },
  cursor: { name: "Cursor", kind: "cursor", glyph: "U" },
};
export const DEFAULT_AGENTS = ["claude-code", "codex", "pi", "zcode", "qoder", "qoder-ide"];
// Desktop-only agents: no CLI to resume from, the app has to be brought up instead.
export const NO_RESUME = new Set(["zcode", "qoder", "qoder-ide"]);

// Old records carry the git user.name; treat every human alias as "me" so the
// board shows one person, not one per spelling.
export const HUMAN_ALIASES = new Set(["schaefer", "schaeferanjon", "macbook14", "apple"]);
export function isMe(raw: string | undefined, me: string): boolean {
  if (!raw) return false;
  return raw === me || HUMAN_ALIASES.has(raw.toLowerCase());
}
export function actorOf(raw: string | undefined, me: string): Actor | null {
  if (!raw) return null;
  const k = KNOWN[raw.toLowerCase()];
  if (k) return { id: raw, ...k };
  // The person at the keyboard. The app addresses them as 你, never 我.
  if (isMe(raw, me)) return { id: me, name: "你", kind: "human", glyph: "你" };
  return { id: raw, name: raw, kind: "human", glyph: raw.slice(0, 1).toUpperCase() };
}

export const PROJECT_PREFIX = "project:";
export function projectOf(i: Issue): string {
  const l = (i.labels ?? []).find((x) => x.startsWith(PROJECT_PREFIX));
  return l ? l.slice(PROJECT_PREFIX.length) : "";
}
export function isReviewed(i: Issue): boolean {
  return i.status === "closed" && (i.labels ?? []).includes("reviewed");
}
export function columnOf(i: Issue): Column {
  if (i.status === "closed") return isReviewed(i) ? "reviewed" : "done";
  if (i.status === "in_progress") return "prog";
  return "todo";
}
export const COLUMNS: { key: Column; label: string; cls: string }[] = [
  { key: "todo", label: "待办", cls: "open" },
  { key: "prog", label: "进行中", cls: "prog" },
  { key: "done", label: "已完成 · 待审", cls: "done" },
  { key: "reviewed", label: "已审核", cls: "rev" },
];
export function statusLabel(i: Issue): { text: string; cls: string } {
  if (isReviewed(i)) return { text: "已审核", cls: "rev" };
  switch (i.status) {
    case "closed": return { text: "待审", cls: "done" };
    case "in_progress": return { text: "进行中", cls: "prog" };
    case "blocked": return { text: "阻塞", cls: "block" };
    case "deferred": return { text: "搁置", cls: "open" };
    default: return { text: "待办", cls: "open" };
  }
}

const PALETTE = ["#1D5FD1", "#C28A12", "#2E8B57", "#6E56CF", "#C43D3D", "#2F6F73", "#B5488A", "#7A6A2F"];
export function projectColor(name: string): string {
  if (!name) return "#9B968C";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function relTime(iso?: string): string {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(d / 60_000));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
export function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface AgentPresence {
  actor: Actor;
  online: boolean;
  lastActive?: string;
  current: Issue[];
  sessions: Session[];
  bySource: { kind: SourceKind; label: string; count: number; working: number }[];
}
export const SOURCE_LABEL: Record<SourceKind, string> = { terminal: "终端", desktop: "桌面端", editor: "编辑器", unknown: "未登记" };
const ONLINE_WINDOW_MIN = 30;
export function agentsFrom(issues: Issue[], me: string, sessions: Session[] = []): AgentPresence[] {
  const map = new Map<string, AgentPresence>();
  const ensure = (raw: string) => {
    const a = actorOf(raw, me)!;
    if (!map.has(a.id)) map.set(a.id, { actor: a, online: false, current: [], sessions: [], bySource: [] });
    return map.get(a.id)!;
  };
  // Agents always get a lane; the human only appears if they actually hold or wrote tasks.
  DEFAULT_AGENTS.forEach(ensure);
  for (const i of issues) {
    const seen = new Set<string>();
    for (const raw of [i.assignee, i.created_by]) {
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      // Creating a task from Dispatch shouldn't turn the user into an "agent" lane.
      if (isMe(raw, me) && raw !== i.assignee) continue;
      const p = ensure(raw);
      const ts = raw === i.assignee ? i.updated_at : i.created_at;
      if (!p.lastActive || ts > p.lastActive) p.lastActive = ts;
    }
    if (i.assignee) {
      const p = ensure(i.assignee);
      if (i.status === "in_progress") p.current.push(i);
    }
  }
  for (const s of sessions) {
    if (!s.alive) continue;
    const p = ensure(s.agent);
    p.sessions.push(s);
  }
  for (const p of map.values()) {
    const bs = new Map<string, { kind: SourceKind; label: string; count: number; working: number }>();
    for (const s of p.sessions) {
      const key = `${s.source_kind}:${s.source_app}`;
      const b = bs.get(key) ?? { kind: s.source_kind, label: s.source_app || SOURCE_LABEL[s.source_kind], count: 0, working: 0 };
      b.count++;
      if (s.state === "working") b.working++;
      bs.set(key, b);
    }
    p.bySource = [...bs.values()].sort((a, b) => b.count - a.count);
    p.sessions.sort((a, b) => Number(b.state === "working") - Number(a.state === "working") || b.last_at - a.last_at);
    const recentWrite = !!p.lastActive && Date.now() - new Date(p.lastActive).getTime() < ONLINE_WINDOW_MIN * 60_000;
    // A live process is the truth; bd write recency only covers agents without hooks.
    p.online = p.sessions.length > 0 || (p.actor.kind !== "human" && p.sessions.length === 0 && recentWrite && p.actor.kind === "cursor");
    p.current.sort((a, b) => a.priority - b.priority);
  }
  const order: Record<AgentKind, number> = { claude: 0, codex: 1, pi: 2, zcode: 3, qoder: 4, human: 5, cursor: 6 };
  // The human is not an agent: only list them while they actually hold an in-progress task.
  return [...map.values()]
    .filter((p) => p.actor.kind !== "human" || p.current.length > 0)
    .sort((a, b) => Number(b.online) - Number(a.online) || order[a.actor.kind] - order[b.actor.kind]);
}

export interface Event { ts: string; actor?: string; kind: "created" | "claimed" | "status" | "closed" | "reviewed" | "comment" | "edited"; text: string; cmd?: string }
export interface Interaction { id: string; kind: string; created_at: string; actor: string; issue_id: string; extra?: Record<string, unknown> }
// bd history has no per-commit actor; infer it from the fields that changed,
// then overlay the audit log (interactions.jsonl) which does record the actor.
export function eventsFrom(history: HistoryEntry[], comments: Comment[], audit: Interaction[] = []): Event[] {
  const ev: Event[] = [];
  const auditNear = (ts: string, field?: string) => {
    const t = new Date(ts).getTime();
    return audit.find((a) => Math.abs(new Date(a.created_at).getTime() - t) < 5000 && (!field || a.extra?.field === field));
  };
  const h = [...history].sort((a, b) => a.CommitDate.localeCompare(b.CommitDate));
  let prev: Issue | null = null;
  for (const e of h) {
    const cur = e.Issue;
    const ts = new Date(e.CommitDate).toISOString();
    if (!prev) {
      ev.push({ ts, actor: cur.created_by, kind: "created", text: "创建", cmd: `bd create "${cur.title}"` });
    } else {
      if (cur.assignee !== prev.assignee && cur.assignee) ev.push({ ts, actor: auditNear(ts, "assignee")?.actor ?? cur.assignee, kind: "claimed", text: prev.assignee ? `改派给 ${cur.assignee}` : "认领", cmd: `bd update ${cur.id} --claim` });
      if (cur.status !== prev.status) {
        const who = auditNear(ts, "status")?.actor ?? cur.assignee;
        if (cur.status === "closed") ev.push({ ts, actor: who, kind: "closed", text: "完成", cmd: `bd close ${cur.id}${cur.close_reason ? ` --reason "${cur.close_reason}"` : ""}` });
        else if (!(cur.status === "in_progress" && cur.assignee !== prev.assignee)) ev.push({ ts, actor: who, kind: "status", text: `状态 → ${statusLabel(cur).text}`, cmd: `bd update ${cur.id} --status ${cur.status}` });
      }
      const wasRev = (prev.labels ?? []).includes("reviewed"), isRev = (cur.labels ?? []).includes("reviewed");
      if (isRev && !wasRev) ev.push({ ts, actor: auditNear(ts)?.actor, kind: "reviewed", text: "审核通过", cmd: `bd update ${cur.id} --add-label reviewed` });
      if (cur.title !== prev.title || cur.description !== prev.description || cur.priority !== prev.priority || cur.acceptance_criteria !== prev.acceptance_criteria) ev.push({ ts, actor: auditNear(ts)?.actor, kind: "edited", text: "编辑" });
    }
    prev = cur;
  }
  for (const c of comments) ev.push({ ts: c.created_at, actor: c.author, kind: "comment", text: c.text });
  return ev.sort((a, b) => b.ts.localeCompare(a.ts));
}

export type WikiKind = "pit" | "win" | "retro" | "howto";
// The wiki is ordinary bd memories following one convention: key `<kind>-<slug>`,
// content `<head>text <label>field… #project:<name> #task:<id>`. Four kinds.
export const WIKI_KINDS: Record<WikiKind, { prefix: string; head: string; label: string; fields: { name: string; label: string; hint: string }[] }> = {
  pit: { prefix: "pit-", head: "【坑】", label: "坑", fields: [{ name: "fix", label: "【解法】", hint: "怎么解的" }] },
  win: { prefix: "win-", head: "【做对】", label: "做对", fields: [{ name: "why", label: "【为什么】", hint: "为什么这是对的做法" }] },
  retro: { prefix: "retro-", head: "【复盘】", label: "复盘", fields: [{ name: "tech", label: "【技术】", hint: "用了什么技术 / 工具" }, { name: "good", label: "【做对】", hint: "哪里做对了" }, { name: "bad", label: "【做错】", hint: "哪里做错了、下次怎么避免" }] },
  howto: { prefix: "howto-", head: "【方法】", label: "方法", fields: [] },
};
const ALL_LABELS = [...new Set(Object.values(WIKI_KINDS).flatMap((k) => [k.head, ...k.fields.map((f) => f.label)]))].sort((a, b) => b.length - a.length);
export interface Pitfall { key: string; raw: string; kind: WikiKind | null; text: string; fields: Record<string, string>; trap: string; fix: string; project: string; task: string; isPit: boolean }
export function wikiKindOf(key: string, value: string): WikiKind | null {
  for (const k of Object.keys(WIKI_KINDS) as WikiKind[]) {
    if (key.startsWith(WIKI_KINDS[k].prefix) || value.trimStart().startsWith(WIKI_KINDS[k].head)) return k;
  }
  return null;
}
export function parsePitfall(m: { key: string; value: string }): Pitfall {
  const v = m.value;
  const tag = (name: string) => (v.match(new RegExp(`#${name}:(\\S+)`)) ?? [])[1] ?? "";
  const body = v.replace(/#(project|task):\S+/g, "").trim();
  const kind = wikiKindOf(m.key, v);
  const fields: Record<string, string> = {};
  let text = body;
  if (kind) {
    const re = new RegExp("(" + ALL_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")");
    let cur: string | null = null;
    for (const piece of body.split(re)) {
      if (ALL_LABELS.includes(piece)) { cur = piece; fields[cur] = fields[cur] ?? ""; }
      else if (cur !== null) fields[cur] = (fields[cur] + piece).trim();
    }
    const head = WIKI_KINDS[kind].head;
    if (head in fields) { text = fields[head]; delete fields[head]; }
  }
  return { key: m.key, raw: v, kind, text, fields, trap: text, fix: fields["【解法】"] ?? "", project: tag("project"), task: tag("task"), isPit: kind === "pit" };
}
export function composeWiki(kind: WikiKind, text: string, fields: Record<string, string>, project: string, task: string): string {
  let s = `${WIKI_KINDS[kind].head}${text.trim()}`;
  for (const f of WIKI_KINDS[kind].fields) if (fields[f.name]?.trim()) s += ` ${f.label}${fields[f.name].trim()}`;
  if (project.trim()) s += ` #project:${project.trim()}`;
  if (task.trim()) s += ` #task:${task.trim()}`;
  return s;
}
export function composePitfall(trap: string, fix: string, project: string, task: string): string {
  return composeWiki("pit", trap, { fix }, project, task);
}
export function slugify(s: string): string {
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return ascii || Math.random().toString(36).slice(2, 8);
}

// Root of the thread a task sits on: follow lineage edges (discovered-from,
// parent-child) upstream until nothing else points at it. `blocks` is ordering,
// not lineage, so it is ignored.
export function rootsOf(edges: { from: string; to: string; type: string }[]): Map<string, string> {
  const up = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === "blocks" || e.type === "related" || e.type === "relates_to") continue;
    (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from);
  }
  const memo = new Map<string, string>();
  const root = (id: string, seen: Set<string>): string => {
    if (memo.has(id)) return memo.get(id)!;
    const parents = (up.get(id) ?? []).filter((p) => !seen.has(p));
    if (parents.length === 0) return id;
    seen.add(id);
    const r = root(parents[0], seen);
    memo.set(id, r);
    return r;
  };
  const out = new Map<string, string>();
  for (const id of up.keys()) { const r = root(id, new Set()); if (r !== id) out.set(id, r); }
  return out;
}

export interface AcItem { done: boolean; text: string }
export function parseAcceptance(s?: string): AcItem[] {
  if (!s) return [];
  return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^[-*]\s*(\[( |x|X)\])?\s*(.*)$/);
    if (!m) return { done: false, text: l };
    return { done: (m[2] ?? " ").toLowerCase() === "x", text: m[3] };
  });
}
export function serializeAcceptance(items: AcItem[]): string {
  return items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
}

// Which Mac a task runs on: the explicit host:<name> label (dispatch begin adds it), else the
// most recent session that mentioned the task, else unknown ("").
export function hostOfIssue(i: { labels?: string[]; id: string }, refs: Map<string, { host_name?: string; last_at: number; tasks?: Record<string, number> }>): string {
  const lab = (i.labels ?? []).find((l) => l.startsWith("host:"));
  if (lab) return lab.slice(5);
  let best: { host: string; at: number } | null = null;
  for (const r of refs.values()) {
    if (r.tasks && r.tasks[i.id] && r.host_name && (!best || r.last_at > best.at)) best = { host: r.host_name, at: r.last_at };
  }
  return best?.host ?? "";
}
