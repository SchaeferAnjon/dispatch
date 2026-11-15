import type { ActivitySnapshot, Comment, GraphData, HistoryEntry, Host, Info, Issue, Memory, NewIssue, Presence, Quota, RulesStatus, SessionDetail, SessionRef, Skill, Stats, UpdateFields, SkillImprove, EnvVar, Insights, InsightAlert, InsightReport, InsightReportList } from "./types";
import { fixtureApi } from "./fixtures";
import { t } from "./i18n";
import type { Interaction } from "./derive";
import type { ChatApi } from "./chatProtocol";

export interface AgentStartInput { kind: string; host?: string; cwd?: string; model?: string; task?: string; prompt?: string; label?: string; timeout?: number }
export interface AgentStartResult { host: string; session?: string; pane_id: string; tab_id: string; name: string; kind: string; actor: string; cwd: string; status: string; task: string; output: string; warning?: string; prompt_sent?: boolean }

/** Everything the page asks of its host. The chat half (ChatApi) only works inside Dispatch IDE's webview. */
export interface Api extends ChatApi {
  info(): Promise<Info>;
  list(): Promise<Issue[]>;
  show(id: string): Promise<Issue | null>;
  comments(id: string): Promise<Comment[]>;
  history(id: string): Promise<HistoryEntry[]>;
  interactions(id: string): Promise<Interaction[]>;
  claim(id: string): Promise<void>;
  setStatus(id: string, status: string): Promise<void>;
  close(id: string, reason: string): Promise<void>;
  reopen(id: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  labels(id: string, add: string[], remove: string[]): Promise<void>;
  update(id: string, fields: UpdateFields): Promise<void>;
  create(input: NewIssue): Promise<Issue>;
  presence(): Promise<Presence>;
  taskSessions(id: string): Promise<SessionRef[]>;
  sessionActivity(): Promise<ActivitySnapshot>;
  sessionSeen(host: string, key: string, reply: string): Promise<void>;
  sessionList(): Promise<SessionRef[]>;
  sessionDetail(id: string, brief?: boolean): Promise<SessionDetail>;
  resumeCmd(agent: string, sessionId: string, cwd: string): Promise<string>;
  skills(): Promise<Skill[]>;
  skillToggle(name: string, agent: string, on: boolean): Promise<string>;
  skillRead(name: string): Promise<string>;
  skillWrite(name: string, content: string): Promise<string>;
  skillOpen(name: string): Promise<void>;
  skillImprove(days: number): Promise<SkillImprove>;
  quota(): Promise<Quota[]>;
  stats(agent: string, days: number): Promise<Stats | null>;
  hosts(): Promise<Host[]>;
  on(host: string, args: string[], stdin?: string): Promise<string>;
  graph(): Promise<GraphData>;
  openPath(path: string): Promise<void>;
  rulesRead(): Promise<string>;
  rulesWrite(content: string): Promise<void>;
  rulesStatus(): Promise<RulesStatus>;
  rulesSync(): Promise<void>;
  insights(days: number): Promise<Insights | null>;
  insightAlerts(days: number): Promise<InsightAlert[]>;
  insightsAck(days: number): Promise<void>;
  insightReports(): Promise<InsightReportList>;
  insightReport(id: string): Promise<InsightReport | null>;
  insightGenerate(days: number): Promise<void>;
  insightSchedule(every: number): Promise<void>;
  insightDue(): Promise<void>;
  profileDue(): Promise<void>;
  envList(): Promise<EnvVar[]>;
  envGet(name: string): Promise<string>;
  envSet(name: string, value: string, note: string): Promise<void>;
  envUnset(name: string): Promise<void>;
  memories(): Promise<Memory[]>;
  remember(key: string, value: string): Promise<void>;
  forget(key: string): Promise<void>;
  agentStart(input: AgentStartInput): Promise<AgentStartResult | null>;
  copy(text: string): Promise<void>;
  /** Another browser tab opened at a hash route, e.g. `#/sessions/<id>`. */
  openWindow(hash: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  onChange(cb: () => void): Promise<() => void>;
}

export async function copyFallback(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* HTTP mobile pages and embedded browsers may deny this API. */ }
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;left:0;top:0;opacity:0;font-size:16px";
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error(t("浏览器未允许复制，请显示内容后长按复制"));
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
  }
}

// Set by cli/serve.py when the built page is served over HTTP (phone / browser).
export const isServed = typeof window !== "undefined" && Boolean((window as unknown as { __DISPATCH_SERVE__?: number }).__DISPATCH_SERVE__);

function parse<T>(s: string, fallback: T): T {
  const t = s.trim();
  if (!t) return fallback;
  try {
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

// A macOS-only feature asked for on Windows: the CLI answers {"unsupported": true, "message": …}
// (--json) or prints 「Windows 版暂不支持…」 and exits 2. Either way it is a note, not a failure.
export const UNSUPPORTED_PREFIX = "Windows 版暂不支持";
/** The user-facing message when `e` is an "unsupported on Windows" answer, else null. */
export function unsupportedMessage(e: unknown): string | null {
  const s = e instanceof Error ? e.message : typeof e === "string" ? e : e && typeof e === "object" ? JSON.stringify(e) : "";
  if (!s) return null;
  const i = s.indexOf("{");
  if (i >= 0) {
    try { const j = JSON.parse(s.slice(i)) as { unsupported?: boolean; message?: string; error?: string }; if (j && j.unsupported === true) return String(j.message || j.error || UNSUPPORTED_PREFIX); } catch { /* not JSON */ }
  }
  const k = s.indexOf(UNSUPPORTED_PREFIX);
  return k >= 0 ? s.slice(k).split("\n")[0].trim() : null;
}

type Call = (cmd: string, args?: Record<string, unknown>) => Promise<string>;
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

// Everything that is "run a command, parse its JSON" is the same on every transport.
function coreApi(call: Call, invoke: Invoke): Omit<Api, "copy" | "openWindow" | "notify" | "onChange" | keyof ChatApi> {
  return {
    info: () => invoke<Info>("bd_info"),
    list: async () => parse<Issue[]>(await call("bd_list"), []),
    show: async (id) => parse<Issue[]>(await call("bd_show", { id }), [])[0] ?? null,
    comments: async (id) => parse<Comment[]>(await call("bd_comments", { id }), []),
    history: async (id) => parse<HistoryEntry[]>(await call("bd_history", { id }), []),
    interactions: async (id) => parse<Interaction[]>(await call("bd_interactions", { id }), []),
    claim: async (id) => void (await call("bd_claim", { id })),
    setStatus: async (id, status) => void (await call("bd_set_status", { id, status })),
    close: async (id, reason) => void (await call("bd_close", { id, reason })),
    reopen: async (id) => void (await call("bd_reopen", { id })),
    comment: async (id, text) => void (await call("bd_comment", { id, text })),
    labels: async (id, add, remove) => void (await call("bd_labels", { id, add, remove })),
    update: async (id, fields) => void (await call("bd_update", { id, fields })),
    create: async (input) => {
      const r = parse<Issue | Issue[]>(await call("bd_create", { input }), [] as Issue[]);
      return Array.isArray(r) ? r[0] : r;
    },
    presence: async () => ({ sessions: parse(await call("sessions"), []), apps: [] }),
    taskSessions: async (id) => parse<SessionRef[]>(await call("task_sessions", { id }), []),
    sessionActivity: async () => { const r = parse<ActivitySnapshot | null>(await call("session_activity"), null); if (!r?.sessions) throw new Error(t("活动更新不可用")); return r; },
    sessionSeen: async (host, key, reply) => void (await call("session_seen", { host, key, reply })),
    sessionList: async () => parse<SessionRef[]>(await call("session_list"), []),
    sessionDetail: async (id, brief) => { const d = parse<SessionDetail | null>(await call("session_detail", brief ? { id, brief: true } : { id }), null); if (!d) throw new Error(t("读不到这个会话")); return d; },
    resumeCmd: (agent, sessionId, cwd) => invoke<string>("resume_cmd", { agent, sessionId, cwd }),
    skills: async () => parse<Skill[]>(await call("skills_list"), []),
    skillToggle: (name, agent, on) => call("skill_toggle", { name, agent, on }),
    skillRead: (name) => call("skill_read", { name }),
    skillWrite: (name, content) => call("skill_write", { name, content }),
    skillOpen: async (name) => void (await call("skill_open", { name })),
    skillImprove: async (days) => parse<SkillImprove>(await call("skills_improve", { days }), { prompt: "", command: "", top: [] }),
    quota: async () => parse<Quota[]>(await call("quota"), []),
    stats: async (agent, days) => parse<Stats | null>(await call("stats", { agent, days }), null),
    hosts: async () => parse<Host[]>(await call("hosts"), []),
    on: (host, args, stdin) => call("dispatch_on", { host: host === "local" ? null : host, args, stdin: stdin ?? null }),
    graph: async () => parse<GraphData>(await call("graph"), { nodes: [], edges: [] }),
    openPath: async (path) => void (await invoke("open_path", { path })),
    rulesRead: () => call("rules_read"),
    rulesWrite: async (content) => void (await call("rules_write", { content })),
    rulesStatus: async () => parse<RulesStatus>(await call("rules_status"), { hash: "", source: "", targets: [] }),
    rulesSync: async () => void (await call("rules_sync")),
    insights: async (days) => parse<Insights | null>(await call("insights", { days }), null),
    // The proactive half: per-session alerts nobody has acknowledged yet; ack marks the current set seen.
    insightAlerts: async (days) => parse<InsightAlert[]>(await call("dispatch_on", { host: null, args: ["insights", "--days", String(days), "--alerts", "--json"], stdin: null }), []),
    insightsAck: async (days) => { await call("dispatch_on", { host: null, args: ["insights", "--days", String(days), "--ack", "--alerts", "--json"], stdin: null }); },
    // The model-written report: dated runs, a cadence, and Claude Code's own /insights files next to ours.
    insightReports: async () => parse<InsightReportList>(await call("dispatch_on", { host: null, args: ["insights", "list", "--json"], stdin: null }), { running: null, schedule: { every_days: 0 }, reports: [] }),
    insightReport: async (id) => parse<InsightReport | null>(await call("dispatch_on", { host: null, args: ["insights", "show", id || "latest", "--json"], stdin: null }), null),
    insightGenerate: async (days) => { await call("dispatch_on", { host: null, args: ["insights", "report", "--days", String(days), "--json"], stdin: null }); },
    insightSchedule: async (every) => { await call("dispatch_on", { host: null, args: ["insights", "schedule", "--every", String(every), "--json"], stdin: null }); },
    insightDue: async () => { await call("dispatch_on", { host: null, args: ["insights", "due", "--json"], stdin: null }); },
    profileDue: async () => { await call("dispatch_on", { host: null, args: ["profile", "inventory", "--due", "--json"], stdin: null }); },
    // GLOBAL/FACTS/PROFILE/artifact.md are one shared copy across every Mac (task-yvse); this Mac's
    // Dispatch also fires a sync right after saving any of them, so this timer only catches what a
    // peer changed while this Mac was asleep or offline.
    envList: async () => parse<EnvVar[]>(await call("env_list"), []),
    envGet: (name) => call("env_get", { name }),
    envSet: async (name, value, note) => void (await call("env_set", { name, value, note })),
    envUnset: async (name) => void (await call("env_unset", { name })),
    memories: () => invoke<Memory[]>("memories_list"),
    remember: async (key, value) => void (await call("memory_set", { key, value })),
    forget: async (key) => void (await call("memory_forget", { key })),
    // Older servers read the struct under `input`, cli/serve.py reads the flat keys: send both shapes.
    agentStart: async (input) => parse<AgentStartResult | null>(await call("agent_start", { input, ...input }), null),
  };
}

/** Chat on the phone, the browser and the fixtures: says so instead of trying. */
export function chatUnavailable(): ChatApi {
  const no = () => Promise.reject(new Error(t("应用内聊天只在电脑上的 Dispatch 里可用")));
  return { chatAvailable: false, chatCommand: no, onChatEvent: no, chatRestart: no };
}

// Served by cli/serve.py: one POST per command, the cookie set by /?token=… carries auth.
function httpApi(): Api {
  const post = async (cmd: string, args?: Record<string, unknown>) => {
    // A request that never answers (the Mac went to sleep mid-call, a dead Tailscale route) must end:
    // polls are 20 s, commands that do real work on the Mac get 30 minutes.
    const slow = cmd === "dispatch_on" || cmd === "agent_start" || cmd === "skills_improve" || cmd === "insights" || cmd === "rules_sync";
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), slow ? 30 * 60_000 : 20_000);
    const r = await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd, args: args ?? {} }), credentials: "same-origin", signal: ctl.signal })
      .catch(() => { throw new Error(ctl.signal.aborted ? t("电脑太久没有回应，已放弃这次请求；稍后会自动重试。") : t("与电脑的连接暂时中断，请检查网络或电脑是否在线。")); })
      .finally(() => window.clearTimeout(timer));
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body as { result?: string; value?: unknown };
  };
  const call: Call = async (cmd, args) => { const b = await post(cmd, args); return typeof b.result === "string" ? b.result : JSON.stringify(b.value ?? ""); };
  const invoke: Invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => { const b = await post(cmd, args); return (b.value !== undefined ? b.value : b.result) as T; };
  return {
    ...coreApi(call, invoke),
    copy: copyFallback,
    openWindow: async (hash) => { window.open(location.pathname + location.search + hash, "_blank"); },
    notify: async (title, body) => {
      if (!("Notification" in window)) return;
      if (Notification.permission === "default") await Notification.requestPermission().catch(() => {});
      if (Notification.permission === "granted") new Notification(title, { body });
    },
    onChange: async () => () => {},
    ...chatUnavailable(),
  };
}

let apiPromise: Promise<Api> | null = null;
export function getApi(): Promise<Api> {
  if (!apiPromise) apiPromise = Promise.resolve(isServed ? httpApi() : fixtureApi());
  return apiPromise;
}

// ---- 脉络: `dispatch thread` (cli/thread.py). The CLI works out every record's kind and folding;
// the page only draws. Sentences are built on the page so they translate.
export type ThreadState = "run" | "wait" | "open" | "done";
export interface ThreadRow { root: string; title: string; short: string; project: string; state: ThreadState; open_count: number; task_count: number; closed_count: number; last_at: number; single: boolean }
export interface ThreadList { project: string; everywhere: boolean; threads: ThreadRow[]; singles?: ThreadRow[]; counts: { moving: number; done: number; today: number; singles: number; recent_days: number } }
export interface ThreadMember { ts: number; who: string; model: string; text: string; full: string }
export interface ThreadBeat {
  kind: "ask" | "discuss" | "decide" | "claim" | "did" | "done" | "fork" | "open" | "gap" | "created" | "verify";
  ts: number; task?: string; who?: string; text?: string; full?: string;
  /** ask/created: the root's first row */ opening?: boolean; discussion?: boolean; host?: string;
  /** discuss */ members?: ThreadMember[];
  /** decide: 结论 / 决定 / 分工 / 拍板 */ tag?: string;
  /** claim */ routed?: boolean; routed_by?: string;
  /** did (fold) */ fold?: boolean; count?: number; from_ts?: number; to_ts?: number; summary?: string[];
  /** done / did / fork */ commits?: string[]; verified?: boolean | null;
  /** fork / open */ title?: string; status?: string; state?: ThreadState; closed_at?: number; open_after?: number; tasks?: number; assignee?: string; from?: string; from_title?: string;
  /** fork / folded did: what opening the row shows */ beats?: ThreadBeat[];
  /** gap */ days?: number;
  /** verify: the checker's 【验收】 run */ verify?: { ok: number; ask: number; fail: number; model?: string; secs?: number; error?: string; items?: { n: number; state: string; text: string }[] };
}
export interface ThreadDay { date: string; weekday: number; today: boolean; beats: ThreadBeat[] }
export interface ThreadOpen { id: string; title: string; short?: string; state: ThreadState; status: string; assignee: string; from: string; from_title: string }
export interface ThreadData {
  root: string; selected: string; project: string; title: string; short: string; state: ThreadState;
  /** The selected task's own project ("" when it has none) and the chapter holding it there. */
  home_project?: string; home_root?: string;
  task_count: number; closed_count: number; open_count: number; session_count: number; last_at: number;
  ask: { text: string; at: number; source: "description" | "session"; session_id: string } | null;
  now: { main: { closed_at: number; text: string } | null; latest: { at: number; text: string; kind: string; task: string } | null; branches: { total: number; closed: number }; last_at: number };
  left: ThreadOpen[];
  line: { tasks: number; closed: number; decisions: number; commits: number; agents: string[] };
  days: ThreadDay[];
  tail: ThreadBeat[];
}

/** A line as a chapter of its project's 脉络: its row, when it began, its last word; `days` only
 *  when the CLI opened it (the page reads the others with `loadThread` when they are opened). */
export interface ThreadChapter extends ThreadRow {
  first_at: number;
  gist: { kind: "done" | "note"; text: string; task: string; at: number } | null;
  shown: boolean; expanded: boolean; days?: ThreadDay[];
}
export interface ThreadProjectOpen extends ThreadOpen { root: string; root_title: string }
export interface ThreadProject {
  kind: "project"; project: string; focus: string; focus_root: string; state: ThreadState; last_at: number;
  task_count: number; closed_count: number; open_count: number; session_count: number;
  now: { closes: { task: string; title: string; root: string; text: string; at: number }[]; latest: { kind: string; text: string; task: string; at: number } | null; last_at: number; lines: { total: number; moving: number; closed: number } };
  left: ThreadProjectOpen[];
  stats: { lines: number; tasks: number; closed: number; decisions: number; commits: number; agents: string[] };
  /** Oldest move first; the newest sits at the bottom next to 现在. */
  chapters: ThreadChapter[];
  hidden: number;
  tail: (ThreadBeat & { root?: string; root_title?: string })[];
}
export interface ThreadProjectRow { name: string; state: ThreadState; lines: number; moving: number; tasks: number; closed: number; open: number; run: number; wait: number; last_at: number }
export interface ThreadProjects { projects: ThreadProjectRow[]; counts: { moving: number; today: number; recent_days: number } }

/** `dispatch thread <project> --lines --json`: the lines of one project; `project` "" lists every project's lines. */
export async function loadThreads(api: Api, project: string): Promise<ThreadList> {
  const args = project ? ["thread", project, "--lines", "--all", "--json"] : ["thread", "--all-projects", "--all", "--json"];
  return parseThread<ThreadList>(await api.on("local", args));
}
/** `dispatch thread --projects --json`: every project with lines, one row each. */
export async function loadThreadProjects(api: Api): Promise<ThreadProjects> {
  return parseThread<ThreadProjects>(await api.on("local", ["thread", "--projects", "--json"]));
}
/** `dispatch thread <project> --json`: the project's 脉络; `task` opens the chapter holding it. */
export async function loadProjectThread(api: Api, project: string, task?: string | null): Promise<ThreadProject> {
  return parseThread<ThreadProject>(await api.on("local", ["thread", project, ...(task ? ["--task", task] : []), "--json"]));
}
/** `dispatch thread <task> --json`; with `project`, the line as a chapter of that project (`--in`). */
export async function loadThread(api: Api, task: string, project?: string): Promise<ThreadData> {
  return parseThread<ThreadData>(await api.on("local", ["thread", task, ...(project ? ["--in", project] : []), "--json"]));
}
// ---- 项目页 v3: `dispatch thread <project> --timeline` (cli/thread.py timeline_report). What was done,
// newest first and already folded by the CLI, plus the open work for the right column.
export type TimelineKind = "done" | "void" | "decide" | "verify" | "commit" | "reply" | "did";
export interface TimelineVerifyItem { n: number; state: "ok" | "ask" | "fail"; text: string; full?: string; task?: string; title?: string; ts?: number }
export interface TimelineVerify { ok: number; ask: number; fail: number; model?: string; secs?: number; error?: string; items?: TimelineVerifyItem[] }
export interface TimelineClose { task: string; title: string; text: string; ts: number; verified?: boolean | null; commits?: string[]; kind?: string }
export interface TimelineEvent {
  id: string; kind: TimelineKind; ts: number; text: string; full?: string; who?: string;
  task?: string; task_title?: string; root?: string; session_id?: string; session_title?: string;
  commits?: string[]; verified?: boolean | null; unchecked?: boolean; tests?: string; merges?: number; tag?: string;
  /** Rows folded into this one (steps, commits, checker runs): opening the row lists them. */
  fold?: { count: number; from_ts: number; to_ts: number; summary: string[]; events: TimelineEvent[] };
  verify?: TimelineVerify;
  /** A close of several tasks together, or the tasks a conclusion closed right after. */
  closes?: TimelineClose[]; group?: boolean; from_ts?: number; tasks?: number;
  /** A close: its task's steps and commits of the 24 hours before it. */
  before?: { steps: number; commits: number; events: TimelineEvent[] };
  /** A reply: what the session left for you to do. */
  needs_you?: string;
}
export interface TimelineDay { date: string; weekday: number; today: boolean; yesterday?: boolean; count: number; events: TimelineEvent[] }
export interface OpenTask { id: string; title: string; status: string; assignee: string; priority: number; acceptance_done: number; acceptance_total: number; last_at: number; created_at: number; from: string; from_title: string; root: string; state: ThreadState; session_id?: string; session_state?: string }
/** An acceptance item the checker left to you: `item` is the checklist line, `text` the checker's why. */
export interface OpenAsk { task: string; title: string; n: number; item?: string; text: string; full?: string; ts: number }
export interface OpenWaitingSession { session_id: string; agent: string; title: string; text: string; ts: number; pane_id?: string }
export interface HereSession { agent: string; session_id: string; title: string; pane_id?: string; cwd?: string; source_app?: string; summary: string; state: string; last_at?: number; tasks: { id: string; title: string; status: string }[]; tasks_all_done: boolean; files_count: number; verdict: string; reason: string; host?: string }
export interface OpenWork {
  asks: OpenAsk[]; waiting_sessions: OpenWaitingSession[]; wait: OpenTask[]; doing: OpenTask[]; unassigned: OpenTask[];
  sessions: HereSession[]; test_cmd: string; counts: { wait: number; doing: number; unassigned: number };
}
export interface ProjectTimelineData {
  kind: "timeline"; project: string; since: number; before: number | null; days_back: number; only: string;
  /** `--days 0`: the whole history in one page. */ all?: boolean;
  /** `--task`: only this task's rows. */ task?: string;
  stats: { lines: number; moving: number; tasks: number; closed: number; open: number; decisions: number; commits: number; agents: string[]; last_at: number };
  last_at: number; days: TimelineDay[]; gaps: { after: number; before: number; days: number }[];
  count: number; folded: { steps: number; commits: number }; older: number; next_before: number | null;
  open?: OpenWork;
}
/** `dispatch thread <project> --timeline --json`: `days` back from today (0: the whole history), or
 *  the `days` (14) before `before`. `task` keeps one task's rows; `open: false` (the 更早 pages) skips
 *  the open work and the live sessions. */
export async function loadProjectTimeline(api: Api, project: string, opts: { days?: number; before?: number | null; only?: boolean; sessions?: boolean; open?: boolean; task?: string | null } = {}): Promise<ProjectTimelineData> {
  const args = ["thread", project, "--timeline", "--days", String(opts.days ?? 7)];
  if (opts.before) args.push("--before", String(opts.before));
  if (opts.only) args.push("--only", "done");
  if (opts.task) args.push("--task", opts.task);
  if (opts.open === false) args.push("--no-open");
  else if (opts.sessions === false) args.push("--no-sessions");
  return parseThread<ProjectTimelineData>(await api.on("local", [...args, "--json"]));
}
function parseThread<T>(text: string): T {
  const d = JSON.parse(text.slice(Math.max(0, text.indexOf("{")))) as T & { error?: string };
  if (d.error) throw new Error(d.error);
  return d;
}
