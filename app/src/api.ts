import type { Comment, Folder, GraphData, HistoryEntry, Info, Issue, Memory, NewIssue, Presence, Quota, RulesStatus, SessionDetail, SessionRef, Skill, Stats, UpdateFields, SkillImprove } from "./types";
import { fixtureApi } from "./fixtures";
import type { Interaction } from "./derive";

export interface Api {
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
  sessionList(): Promise<SessionRef[]>;
  sessionDetail(id: string): Promise<SessionDetail>;
  focusSession(id: string): Promise<string>;
  resumeCmd(agent: string, sessionId: string, cwd: string): Promise<string>;
  skills(): Promise<Skill[]>;
  skillToggle(name: string, agent: string, on: boolean): Promise<string>;
  skillRead(name: string): Promise<string>;
  skillWrite(name: string, content: string): Promise<string>;
  skillOpen(name: string): Promise<void>;
  skillImprove(days: number): Promise<SkillImprove>;
  quota(): Promise<Quota[]>;
  stats(agent: string, days: number): Promise<Stats | null>;
  graph(): Promise<GraphData>;
  folders(): Promise<Folder[]>;
  openPath(path: string): Promise<void>;
  rulesRead(): Promise<string>;
  rulesWrite(content: string): Promise<void>;
  rulesStatus(): Promise<RulesStatus>;
  rulesSync(): Promise<void>;
  memories(): Promise<Memory[]>;
  remember(key: string, value: string): Promise<void>;
  forget(key: string): Promise<void>;
  copy(text: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  tray(title: string, tooltip: string): Promise<void>;
  onChange(cb: () => void): Promise<() => void>;
}

export async function copyFallback(text: string) {
  await navigator.clipboard.writeText(text);
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function parse<T>(s: string, fallback: T): T {
  const t = s.trim();
  if (!t) return fallback;
  try {
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const call = (cmd: string, args?: Record<string, unknown>) => invoke<string>(cmd, args);
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
    sessionList: async () => parse<SessionRef[]>(await call("session_list"), []),
    sessionDetail: async (id) => { const d = parse<SessionDetail | null>(await call("session_detail", { id }), null); if (!d) throw new Error("读不到这个会话"); return d; },
    focusSession: (id) => call("focus_session", { id }),
    resumeCmd: (agent, sessionId, cwd) => invoke<string>("resume_cmd", { agent, sessionId, cwd }),
    skills: async () => parse<Skill[]>(await call("skills_list"), []),
    skillToggle: (name, agent, on) => call("skill_toggle", { name, agent, on }),
    skillRead: (name) => call("skill_read", { name }),
    skillWrite: (name, content) => call("skill_write", { name, content }),
    skillOpen: async (name) => void (await call("skill_open", { name })),
    skillImprove: async (days) => parse<SkillImprove>(await call("skills_improve", { days }), { prompt: "", command: "", top: [] }),
    quota: async () => parse<Quota[]>(await call("quota"), []),
    stats: async (agent, days) => parse<Stats | null>(await call("stats", { agent, days }), null),
    graph: async () => parse<GraphData>(await call("graph"), { nodes: [], edges: [] }),
    folders: async () => parse<Folder[]>(await call("folders"), []),
    openPath: async (path) => void (await invoke("open_path", { path })),
    rulesRead: () => call("rules_read"),
    rulesWrite: async (content) => void (await call("rules_write", { content })),
    rulesStatus: async () => parse<RulesStatus>(await call("rules_status"), { hash: "", source: "", targets: [] }),
    rulesSync: async () => void (await call("rules_sync")),
    memories: () => invoke<Memory[]>("memories_list"),
    remember: async (key, value) => void (await call("memory_set", { key, value })),
    forget: async (key) => void (await call("memory_forget", { key })),
    copy: async (text) => {
      try {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
      } catch {
        await copyFallback(text);
      }
    },
    notify: async (title, body) => {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
    },
    tray: async (title, tooltip) => void (await invoke("tray_update", { title, tooltip })),
    onChange: async (cb) => listen("beads-changed", () => cb()),
  };
}

let apiPromise: Promise<Api> | null = null;
export function getApi(): Promise<Api> {
  if (!apiPromise) apiPromise = isTauri ? tauriApi() : Promise.resolve(fixtureApi());
  return apiPromise;
}
