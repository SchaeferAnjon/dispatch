// The in-app chat protocol as the page sees it. Mirror of app/cli/chat_protocol.py: the names here
// (commands, events, lifecycles, error codes) must stay equal to the Python side; both test files
// pin them. Dispatch IDE's bridge extension only forwards lines: each command goes to chatd, and
// chatd's lines come back to the webview (idechat/bridge.ts).
//
// The reducer at the bottom (`reduceChatEvent`) is the one place live events become page state,
// so the store hook (chatStore.ts) and the chat page agree on what a turn, a tool chip, a
// permission card and the queue look like.

export const PROTOCOL_VERSION = 1;
export const EVENT_ALL = "chat://all";
export const eventChannel = (session: string) => `chat://${session}`;

export const AGENTS = ["claude-code", "codex", "opencode"] as const;
export type ChatAgent = (typeof AGENTS)[number];
export const LIFECYCLES = ["starting", "idle", "running", "waiting_permission", "waiting_input", "stopping", "stopped", "error"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DECISIONS = ["allow", "allow_session", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];
export const PERMISSION_KINDS = ["command", "edit", "read", "fetch", "permission", "question", "other"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];
export const TOOL_KINDS = ["shell", "edit", "read", "search", "agent", "web", "question", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export const TURN_STATUSES = ["success", "interrupted", "error"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];
export const CLOSE_REASONS = ["requested", "idle", "exited", "error", "shutdown"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];
export const SEND_MODES = ["queue", "interrupt"] as const;
export type SendMode = (typeof SEND_MODES)[number];
export const ERROR_CODES = ["bad_request", "unsupported_version", "agent_missing", "spawn_failed", "daemon_down", "no_such_session", "session_busy", "writer_conflict", "moved_away", "owner_elsewhere", "not_running", "too_large", "invalid_model", "process_exited", "queue_full", "unsupported"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const CAPABILITIES = ["allow_session", "set_model", "set_permission_mode", "effort", "thinking_text", "diff_events", "images_base64", "images_path", "queue", "commands"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const COMMAND_NAMES = ["hello", "open", "send", "withdraw", "interrupt", "permission", "answer", "set_model", "set_permission_mode", "commands", "replay", "note", "close", "list", "shutdown"] as const;
export const EVENT_NAMES = ["hello", "chatd", "attention", "opened", "state", "turn_started", "text_delta", "text_done", "thinking_delta", "thinking_done", "tool_start", "tool_end", "permission_request", "permission_resolved", "queued", "queue", "diff_updated", "turn_done", "rate_limit", "system", "life_usage", "error", "closed", "sessions", "commands"] as const;

export const TEXT_LIMIT = 16000;
export const OUTPUT_LIMIT = 16000;
export const QUEUE_LIMIT = 20;

const TOOL_KIND_RULES: [ToolKind, string[]][] = [
  ["shell", ["Bash", "bash", "commandExecution", "exec_command", "shell", "run_command", "PowerShell"]],
  ["edit", ["Edit", "Write", "MultiEdit", "NotebookEdit", "fileChange", "apply_patch", "applyPatch"]],
  ["read", ["Read", "read_file", "fileRead"]],
  ["search", ["Grep", "Glob", "LS", "grep", "glob"]],
  ["agent", ["Agent", "Task", "agent", "task", "subAgent"]],
  ["web", ["WebFetch", "WebSearch", "webSearch", "web_search", "fetch"]],
  ["question", ["AskUserQuestion", "requestUserInput"]],
];
export function toolKind(name: string): ToolKind {
  for (const [kind, names] of TOOL_KIND_RULES) if (names.includes(name)) return kind;
  return "other";
}
/** Codex (app-server items and transcript function names) calls its tools by protocol names; on screen
 *  they read as Claude Code's, so a call looks the same whichever agent made it. */
const TOOL_LABELS: Record<string, string> = {
  commandExecution: "Bash", exec_command: "Bash", shell: "Bash", local_shell: "Bash", run_command: "Bash", bash: "Bash",
  fileChange: "Edit", apply_patch: "Edit", applyPatch: "Edit",
  read_file: "Read", fileRead: "Read", imageView: "Read", view_image: "Read",
  grep: "Grep", glob: "Glob",
  webSearch: "WebSearch", web_search: "WebSearch", fetch: "WebFetch",
  subAgent: "Agent", agent: "Agent", task: "Task",
  requestUserInput: "AskUserQuestion", update_plan: "TodoWrite",
};
export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name;

// ---- what a tool call is doing, in plain words. Mirror of step_phrase in chat_protocol.py; both
// tests read stepPhrase.cases.json, so the two sides say the same sentence for the same call.
const PHRASE_ARG_MAX = 32;
const SYMBOL_RE = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:pub(?:\([a-z]+\))?[ \t]+)?(?:async[ \t]+)?(class|def|function|interface|struct|fn|func)[ \t]+([A-Za-z_$][\w$]*)/m;
const SYMBOL_WORD: Record<string, string> = { class: "class", struct: "struct", interface: "interface", def: "function", function: "function", fn: "function", func: "function" };
const shortArg = (text: unknown, n = PHRASE_ARG_MAX) => { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length <= n ? s : `${s.slice(0, n - 1)}…`; };
const baseName = (p: unknown) => { const s = String(p ?? "").replace(/[/\\]+$/, ""); return s ? s.split(/[/\\]/).pop() ?? "" : ""; };
/** The part of a shell command a person reads: first line, without a leading `cd <dir> &&`. */
export function commandBrief(command: unknown): string {
  let text = Array.isArray(command) ? command.map(String).join(" ") : String(command ?? "");
  if (Array.isArray(command)) { const m = /^(?:\/bin\/)?(?:ba|z)?sh -l?c ([\s\S]*)$/.exec(text); if (m) text = m[1]; }
  text = text.trim().split("\n")[0].replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
  return shortArg(text);
}
/** One short sentence for a tool call: Edit/Write → 在改 X（的 Y 函数）, Read → 在看 X, Bash → 在跑 <命令>, Grep/Glob → 在找 …, Agent → Delegated to a subagent. */
export function stepPhrase(name: string, input?: Record<string, unknown> | null): string {
  const inp = input && typeof input === "object" ? input : {};
  const kind = toolKind(name);
  let path = String(inp.file_path || inp.path || inp.notebook_path || "");
  if (kind === "shell") { const b = commandBrief(inp.command || inp.cmd || ""); return b ? `Running ${b}` : "Running a command"; }
  if (kind === "edit") {
    const changes = inp.changes;
    if (!path && Array.isArray(changes) && changes.length) {
      const first = changes[0] && typeof changes[0] === "object" ? changes[0] as Record<string, unknown> : {};
      path = String(first.path || "");
      if (changes.length > 1) return `Editing ${changes.length} files, including ${baseName(path)}`;
    }
    const nm = baseName(path) || "a file";
    for (const key of ["old_string", "new_string", "content"]) {
      const m = SYMBOL_RE.exec(String(inp[key] ?? ""));
      if (m) return `Editing ${SYMBOL_WORD[m[1]]} ${m[2]} in ${nm}`;
    }
    return `Editing ${nm}`;
  }
  if (kind === "read") return path ? `Reading ${baseName(path)}` : "Reading a file";
  if (kind === "search") {
    if (name === "LS") return `Listing ${baseName(path) || "a folder"}`;
    const pattern = inp.pattern || inp.query || "";
    if (!pattern) return "Finding files";
    const where = baseName(path);
    return `Searching for ${shortArg(pattern, 24)}${where ? ` in ${where}` : ""}`;
  }
  if (kind === "agent") return "Delegated to a subagent";
  if (kind === "web") {
    if (inp.query) return `Searching the web for ${shortArg(inp.query, 24)}`;
    const host = String(inp.url || "").replace(/^[a-z]+:\/\//, "").split("/")[0];
    return host ? `Reading ${host}` : "Reading a web page";
  }
  if (kind === "question") return "Waiting for your answer";
  if (name === "TodoWrite" || name === "update_plan") return "Planning";
  return `Using ${name}`;
}
/** "claude-code:abc" → { agent, id }; null when it is not a chat session key. */
export function splitKey(key: string): { agent: ChatAgent; id: string } | null {
  const m = /^(claude-code|codex|opencode):([A-Za-z0-9][A-Za-z0-9_.:-]{2,120})$/.exec(key);
  return m ? { agent: m[1] as ChatAgent, id: m[2] } : null;
}
export const sessionKey = (agent: ChatAgent, id: string) => `${agent}:${id}`;

// ---------------------------------------------------------------- commands (page → chatd)
export interface ChatImage { media_type?: string; data?: string; path?: string }
export type ChatCommand =
  | { cmd: "hello"; request_id?: string; protocol?: number }
  | { cmd: "open"; request_id: string; agent: ChatAgent; cwd: string; resume?: string; model?: string; permission_mode?: PermissionMode; effort?: string; task?: string; label?: string; moving?: boolean }
  /** `display`: what the bubble and the queue show when the agent gets more than was typed (`@codebase` appends search results to `text`). chatd snapshots the project before the message goes out; turn_started carries that checkpoint's id. */
  | { cmd: "send"; request_id?: string; session: string; message_id: string; text: string; images?: ChatImage[]; mode?: SendMode; display?: string }
  | { cmd: "withdraw"; request_id?: string; session: string; message_id: string }
  | { cmd: "interrupt"; request_id?: string; session: string }
  | { cmd: "permission"; request_id?: string; session: string; permission_id: string; decision: Decision; message?: string; updated_input?: Record<string, unknown> }
  | { cmd: "answer"; request_id?: string; session: string; permission_id: string; answers: Record<string, string[]> }
  | { cmd: "set_model"; request_id?: string; session: string; model: string; effort?: string }
  | { cmd: "set_permission_mode"; request_id?: string; session: string; mode: PermissionMode }
  | { cmd: "commands"; request_id?: string; session: string }
  | { cmd: "replay"; request_id?: string; session: string }
  /** Editor mode: a line for the agent (e.g. 你撤销了 install-device.sh 第 2 处). chatd answers with a `system` notice the page shows, keeps the text, and prepends every pending note as `[system] …` to the next `send` of this session so the agent reads it at the start of its next turn. */
  | { cmd: "note"; request_id?: string; session: string; text: string }
  | { cmd: "close"; request_id?: string; session: string; reason?: CloseReason }
  | { cmd: "list"; request_id?: string }
  | { cmd: "shutdown"; request_id?: string };

// ---------------------------------------------------------------- events (chatd → page)
interface Base { seq: number; ts: number; request_id?: string }
export interface AgentProbe { available: boolean; version: string; supported: boolean; reason: string }
export interface QueueItem { message_id: string; text: string; images_n: number; at: number }
export interface ChatState { session: string; lifecycle: Lifecycle; model: string; permission_mode: string; effort?: string | null; queue: QueueItem[]; pending: string[]; turn_id?: string | null; since: number; pid?: number }
export interface ChatDiff { path: string; kind: "edit" | "write" | "patch"; old: string; new: string }
export interface ChatQuestion { id: string; text: string; options: string[]; multi?: boolean }
export interface ChatUsage { input?: number; output?: number; cache_read?: number; cache_write?: number; context_pct?: number }
export interface SlashCommand { name: string; description: string; kind: "builtin" | "skill" | "command" }
export type ChatEvent = Base & (
  | { ev: "hello"; protocol: number; chatd_version: string; platform: string; agents: Record<string, AgentProbe> }
  | { ev: "chatd"; state: "up" | "down" | "restarting"; pid?: number; reason?: string }
  | { ev: "attention"; host: string; attention?: { approve: number; decide: number; unread: number; only_you: number; total: number; shared: number; as_of: number }; online?: boolean; stream?: string }
  | { ev: "opened"; session: string; agent: ChatAgent; cwd: string; resumed: boolean; model: string; permission_mode: string; transcript_path: string; capabilities: Capability[] }
  | ({ ev: "state" } & ChatState)
  /** `checkpoint`: the snapshot taken before this message went out (`dispatch checkpoint restore --turn <it>`). */
  | { ev: "turn_started"; session: string; turn_id: string; message_id: string; text: string; images_n: number; checkpoint?: string }
  | { ev: "text_delta"; session: string; turn_id: string; text: string }
  | { ev: "text_done"; session: string; turn_id: string; text: string }
  | { ev: "thinking_delta"; session: string; turn_id: string; text: string }
  | { ev: "thinking_done"; session: string; turn_id: string; text: string; tokens?: number; duration_ms: number }
  | { ev: "tool_start"; session: string; turn_id: string; tool_id: string; name: string; kind: ToolKind; input: Record<string, unknown>; summary: string; parent_tool_id?: string }
  | { ev: "tool_end"; session: string; turn_id: string; tool_id: string; ok: boolean; output: string; truncated: boolean; exit_code?: number | null; duration_ms: number; diff?: ChatDiff }
  | { ev: "permission_request"; session: string; turn_id: string; permission_id: string; kind: PermissionKind; tool_id?: string; tool_name: string; input: Record<string, unknown>; summary: string; reason: string; cwd?: string; diff?: ChatDiff; options: Decision[]; questions?: ChatQuestion[] }
  | { ev: "permission_resolved"; session: string; permission_id: string; decision: Decision | "answered"; by: "dispatch" | "elsewhere" }
  | { ev: "queued"; session: string; message_id: string; position: number }
  | { ev: "queue"; session: string; queue: QueueItem[] }
  | { ev: "diff_updated"; session: string; turn_id: string; files: { path: string; add: number; del: number }[]; patch?: string }
  | { ev: "turn_done"; session: string; turn_id: string; status: TurnStatus; error?: string; duration_ms: number; cost_usd?: number; usage?: ChatUsage; num_tools: number }
  | { ev: "rate_limit"; session?: string; agent: ChatAgent; windows: { label: string; used_percent: number | null; resets_at: number | null }[] }
  | { ev: "life_usage"; session: string; usage: ChatUsage; cumulative?: ChatUsage; window?: number }
  | { ev: "system"; session: string; kind: "hook" | "init" | "notice"; text: string }
  | { ev: "error"; session?: string; code: ErrorCode; message: string; fatal: boolean }
  | { ev: "closed"; session: string; reason: CloseReason; exit_code?: number | null }
  | { ev: "sessions"; sessions: ChatState[] }
  | { ev: "commands"; session: string; commands: SlashCommand[] }
);
export type ChatEventOf<K extends ChatEvent["ev"]> = Extract<ChatEvent, { ev: K }>;

// ---------------------------------------------------------------- the Api surface (api.ts implements, the page consumes)
/** Added to `Api` by idechat/bridge.ts. On the phone page and in the fixtures `chatAvailable` is false and
 *  every method rejects with a plain message; the page then shows the terminal path only. */
export interface ChatApi {
  chatAvailable: boolean;
  /** Write one command; resolves once chatd took the line (not when it answered). */
  chatCommand(cmd: ChatCommand): Promise<void>;
  /** Every chatd line, in order. The store keeps one subscription per page. */
  onChatEvent(cb: (e: ChatEvent) => void): Promise<() => void>;
  /** Restart the sidecar after `chatd {state: "down"}`. */
  chatRestart(): Promise<void>;
}

// ---------------------------------------------------------------- page state and the reducer
export interface ToolChip { tool_id: string; name: string; kind: ToolKind; input: Record<string, unknown>; summary: string; parent_tool_id?: string; status: "running" | "done" | "error"; output: string; truncated: boolean; exit_code?: number | null; started: number; duration_ms?: number; diff?: ChatDiff }
export interface PermissionCard { permission_id: string; turn_id: string; kind: PermissionKind; tool_id?: string; tool_name: string; input: Record<string, unknown>; summary: string; reason: string; cwd?: string; diff?: ChatDiff; options: Decision[]; questions?: ChatQuestion[]; at: number; resolved?: { decision: Decision | "answered"; by: "dispatch" | "elsewhere" } }
/** One assistant step in order: text streams into the last "text" step, tools and thinking are their own steps. */
export type TurnStep =
  | { kind: "text"; text: string; done: boolean }
  | { kind: "thinking"; text: string; done: boolean; tokens?: number; duration_ms?: number }
  | { kind: "tool"; tool_id: string }
  | { kind: "permission"; permission_id: string }
  | { kind: "system"; text: string };
export interface LiveTurn { turn_id: string; message_id: string; user_text: string; images_n: number; started: number; checkpoint?: string; steps: TurnStep[]; tools: Record<string, ToolChip>; status?: TurnStatus; error?: string; duration_ms?: number; cost_usd?: number; usage?: ChatUsage; files: { path: string; add: number; del: number }[] }
export interface ChatView {
  session: string;
  agent?: ChatAgent; cwd?: string; transcript_path?: string; capabilities: Capability[];
  lifecycle: Lifecycle; model: string; permission_mode: string; effort?: string | null;
  queue: QueueItem[];
  /** Permission cards not yet answered, oldest first. */
  pending: PermissionCard[];
  permissions: Record<string, PermissionCard>;
  /** Turns chatd streamed since the page opened, oldest first; history before them comes from the transcript. */
  turns: LiveTurn[];
  rateLimit?: ChatEventOf<"rate_limit">["windows"];
  commands?: SlashCommand[];
  /** The last non-fatal error, cleared by the next successful command; fatal ones also flip lifecycle to "error". */
  error?: { code: ErrorCode; message: string; fatal: boolean; request_id?: string; at: number };
  closed?: { reason: CloseReason; exit_code?: number | null };
  seq: number;
}
export function initialChatView(session: string): ChatView {
  return { session, capabilities: [], lifecycle: "starting", model: "", permission_mode: "", queue: [], pending: [], permissions: {}, turns: [], seq: 0 };
}
/** A fresh copy of the turn (or a new one) in `v`. Only the turn object is copied: a case that
 *  changes `steps` replaces the array itself. `tools` is shared with the previous view and written in
 *  place (by id; a chip object is never changed, only replaced): copying it for every event made a
 *  turn with thousands of tool calls quadratic. */
function turnOf(v: ChatView, turn_id: string): LiveTurn {
  const i = v.turns.findIndex((x) => x.turn_id === turn_id);
  if (i < 0) { const t: LiveTurn = { turn_id, message_id: "", user_text: "", images_n: 0, started: Date.now() / 1000, steps: [], tools: {}, files: [] }; v.turns = [...v.turns, t]; return t; }
  const t = { ...v.turns[i] };
  v.turns = v.turns.slice(); v.turns[i] = t;
  return t;
}
const pushStep = (t: LiveTurn, s: TurnStep) => { t.steps = [...t.steps, s]; };
const setLastStep = (t: LiveTurn, s: TurnStep) => { const steps = t.steps.slice(); steps[steps.length - 1] = s; t.steps = steps; };
/** Pure: a new view for an event of this session (events of other sessions are returned untouched).
 *  Replayed events (an older or equal `seq`) are ignored so a `replay` after a remount never doubles a turn. */
export function reduceChatEvent(prev: ChatView, e: ChatEvent): ChatView {
  if ("session" in e && e.session && e.session !== prev.session) return prev;
  if (e.seq <= prev.seq && e.ev !== "hello" && e.ev !== "chatd" && e.ev !== "sessions") return prev;
  const v: ChatView = { ...prev, seq: Math.max(prev.seq, e.seq) };
  switch (e.ev) {
    case "opened": {
      v.agent = e.agent; v.cwd = e.cwd; v.transcript_path = e.transcript_path; v.capabilities = e.capabilities; v.model = e.model; v.permission_mode = e.permission_mode;
      v.lifecycle = "idle"; v.closed = undefined; v.error = undefined;
      return v;
    }
    case "state": {
      v.lifecycle = e.lifecycle; v.model = e.model; v.permission_mode = e.permission_mode; v.effort = e.effort; v.queue = e.queue;
      if (e.lifecycle !== "error") v.error = undefined;
      return v;
    }
    case "turn_started": {
      const t = turnOf(v, e.turn_id);
      // Seen again (a Codex turn that outlived a reconnect): it runs again, and keeps the bubble it had.
      const again = t.steps.length > 0 || !!t.status;
      t.status = undefined; t.error = undefined; t.duration_ms = undefined;
      t.message_id = e.message_id || t.message_id; t.user_text = e.text || t.user_text; t.images_n = e.images_n || t.images_n;
      if (e.checkpoint) t.checkpoint = e.checkpoint;
      if (!again) t.started = e.ts;
      v.lifecycle = "running"; v.error = undefined;
      v.queue = v.queue.filter((q) => q.message_id !== e.message_id);
      return v;
    }
    case "text_delta": case "text_done": {
      const t = turnOf(v, e.turn_id);
      const last = t.steps[t.steps.length - 1];
      if (last && last.kind === "text" && !last.done) setLastStep(t, { kind: "text", text: e.ev === "text_done" ? e.text : last.text + e.text, done: e.ev === "text_done" });
      else pushStep(t, { kind: "text", text: e.text, done: e.ev === "text_done" });
      return v;
    }
    case "thinking_delta": case "thinking_done": {
      const t = turnOf(v, e.turn_id);
      const last = t.steps[t.steps.length - 1];
      const done = e.ev === "thinking_done";
      const extra = done ? { tokens: e.tokens, duration_ms: e.duration_ms } : {};
      if (last && last.kind === "thinking" && !last.done) setLastStep(t, { kind: "thinking", text: done ? (e.text || last.text) : last.text + e.text, done, ...extra });
      else pushStep(t, { kind: "thinking", text: e.text, done, ...extra });
      return v;
    }
    case "tool_start": {
      const t = turnOf(v, e.turn_id);
      t.tools[e.tool_id] = { tool_id: e.tool_id, name: e.name, kind: e.kind, input: e.input, summary: e.summary, parent_tool_id: e.parent_tool_id, status: "running", output: "", truncated: false, started: e.ts };
      pushStep(t, { kind: "tool", tool_id: e.tool_id });
      v.lifecycle = "running";
      return v;
    }
    case "tool_end": {
      const t = turnOf(v, e.turn_id);
      const c = t.tools[e.tool_id];
      if (c) t.tools[e.tool_id] = { ...c, status: e.ok ? "done" : "error", output: e.output, truncated: e.truncated, exit_code: e.exit_code, duration_ms: e.duration_ms, diff: e.diff ?? c.diff };
      return v;
    }
    case "permission_request": {
      const t = turnOf(v, e.turn_id);
      const card: PermissionCard = { permission_id: e.permission_id, turn_id: e.turn_id, kind: e.kind, tool_id: e.tool_id, tool_name: e.tool_name, input: e.input, summary: e.summary, reason: e.reason, cwd: e.cwd, diff: e.diff, options: e.options, questions: e.questions, at: e.ts };
      v.permissions = { ...v.permissions, [e.permission_id]: card };
      v.pending = [...v.pending.filter((p) => p.permission_id !== e.permission_id), card];
      pushStep(t, { kind: "permission", permission_id: e.permission_id });
      v.lifecycle = e.kind === "question" ? "waiting_input" : "waiting_permission";
      return v;
    }
    case "permission_resolved": {
      const c = v.permissions[e.permission_id];
      if (c) v.permissions = { ...v.permissions, [e.permission_id]: { ...c, resolved: { decision: e.decision, by: e.by } } };
      v.pending = v.pending.filter((p) => p.permission_id !== e.permission_id);
      if (!v.pending.length && (v.lifecycle === "waiting_permission" || v.lifecycle === "waiting_input")) v.lifecycle = "running";
      return v;
    }
    case "queued": return v;
    case "queue": { v.queue = e.queue; return v; }
    case "diff_updated": { const t = turnOf(v, e.turn_id); t.files = e.files; return v; }
    case "turn_done": {
      const t = turnOf(v, e.turn_id);
      t.status = e.status; t.error = e.error; t.duration_ms = e.duration_ms; t.cost_usd = e.cost_usd; t.usage = e.usage;
      t.steps = t.steps.map((s) => (s.kind === "text" || s.kind === "thinking") && !s.done ? { ...s, done: true } : s);
      for (const id of Object.keys(t.tools)) if (t.tools[id].status === "running") t.tools[id] = { ...t.tools[id], status: e.status === "success" ? "done" : "error" };
      v.pending = v.pending.filter((p) => p.turn_id !== e.turn_id);
      // A card of a finished turn can no longer be answered: its buttons go (a reconnect asks again with a new card).
      const open = Object.values(v.permissions).filter((c) => c.turn_id === e.turn_id && !c.resolved);
      if (open.length) { v.permissions = { ...v.permissions }; for (const c of open) v.permissions[c.permission_id] = { ...c, resolved: { decision: "deny", by: "elsewhere" } }; }
      v.lifecycle = e.status === "error" && !e.error ? "idle" : "idle";
      return v;
    }
    case "rate_limit": { v.rateLimit = e.windows; return v; }
    case "system": {
      // A hook's run (Codex reports every one: 「sessionStart: …」) is the agent's own bookkeeping, not part of the conversation.
      if (e.kind === "hook") return v;
      if (v.turns.length) { const t = turnOf(v, v.turns[v.turns.length - 1].turn_id); pushStep(t, { kind: "system", text: e.text }); }
      return v;
    }
    case "commands": { v.commands = e.commands; return v; }
    case "error": {
      v.error = { code: e.code, message: e.message, fatal: e.fatal, request_id: e.request_id, at: e.ts };
      if (e.fatal) v.lifecycle = "error";
      return v;
    }
    case "closed": { v.closed = { reason: e.reason, exit_code: e.exit_code }; v.lifecycle = "stopped"; v.pending = []; return v; }
    default: return v;
  }
}
/** Busy = a message would queue rather than start a turn. */
export const isBusy = (v: Pick<ChatView, "lifecycle">) => v.lifecycle === "running" || v.lifecycle === "waiting_permission" || v.lifecycle === "waiting_input";
/** Can take a message at all (open and not dead). */
export const canSend = (v: Pick<ChatView, "lifecycle">) => v.lifecycle === "idle" || isBusy(v);
