// dispatch.history: the pure part. The Agents window's History tab (Dispatch IDE patches/450-history.patch)
// lists every agent session on this Mac (`dispatch sessions history --json`) without importing any. Only these
// read-only argument shapes reach the CLI; continuing a session runs the agent's own resume line in a terminal.

export interface HistoryRequest {
  scope?: unknown;
  folder?: unknown;
  query?: unknown;
  agents?: unknown;
  sort?: unknown;
  limit?: unknown;
  showEmpty?: unknown;
  machine?: unknown;
}

const SCOPES = new Set(["all", "project", "workspace"]);
const AGENT = /^[a-z][a-z0-9-]{1,30}$/;
const MACHINE = /^[A-Za-z0-9][\w.-]{0,63}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function folderPath(v: unknown): string {
  let s = str(v);
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      return "";
    }
  }
  return s.startsWith("/") && !/[\n\r\0]/.test(s) ? s : "";
}

/** The `dispatch` argv for a list request, or undefined when it is not one the window can send. */
export function historyArgs(req: HistoryRequest | undefined, userData = ""): string[] | undefined {
  if (!req || typeof req !== "object") return undefined;
  const scope = str(req.scope) || "all";
  if (!SCOPES.has(scope)) return undefined;
  const args = ["sessions", "history", "--json", "--scope", scope];
  const folder = folderPath(req.folder);
  if (str(req.folder) && !folder) return undefined;
  if (folder) args.push("--folder", folder);
  const query = str(req.query).replace(/[\n\r\0]/g, " ").slice(0, 200);
  if (query) args.push("--query", query);
  if (req.agents !== undefined) {
    if (!Array.isArray(req.agents) || !req.agents.every((a) => typeof a === "string" && AGENT.test(a))) return undefined;
    if (req.agents.length) args.push("--agents", req.agents.join(","));
  }
  const sort = str(req.sort) || "updated";
  if (sort !== "updated" && sort !== "created") return undefined;
  args.push("--sort", sort);
  if (req.limit !== undefined) {
    const n = Number(req.limit);
    if (!Number.isInteger(n) || n < 1 || n > 5000) return undefined;
    args.push("--limit", String(n));
  }
  if (req.showEmpty === true) args.push("--show-empty");
  const machine = str(req.machine);
  if (machine && machine !== "local") {
    if (!MACHINE.test(machine)) return undefined;
    args.push("--machine", machine);
  }
  if (userData.startsWith("/")) args.push("--user-data", userData);
  return args;
}

/** One question at a time per shape: the tab polls and typing asks again. */
export function historyKey(args: string[]): string {
  return args.join("\u0000");
}

/** The Agents window's user data folder, from the extension's global storage (<userData>/User/globalStorage/<id>). */
export function userDataOf(globalStoragePath: string): string {
  const parts = globalStoragePath.split("/");
  const i = parts.lastIndexOf("globalStorage");
  return i >= 2 && parts[i - 1] === "User" ? parts.slice(0, i - 1).join("/") : "";
}

export interface OpenWindowRequest {
  root: string;
  command: string;
  name: string;
  at: number;
}

/** A request for the new window (it runs `command` in a terminal in `root`), or undefined when it is not one. */
export function openWindowRequest(v: unknown, now: number): OpenWindowRequest | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { cwd?: unknown; command?: unknown; name?: unknown };
  const root = folderPath(o.cwd);
  const command = str(o.command);
  if (!root || !command || /[\n\r\0]/.test(command) || command.length > 2000) return undefined;
  const name = str(o.name).replace(/[\n\r\0]/g, " ").slice(0, 80) || "Agent";
  return { root, command, name, at: now };
}

const FRESH_S = 120;

/** The request this window takes: one for its own folder, made in the last two minutes. */
export function takesRequest(rec: unknown, root: string, nowS: number, same: (a: string, b: string) => boolean): OpenWindowRequest | undefined {
  const o = rec && typeof rec === "object" ? (rec as { root?: unknown; command?: unknown; name?: unknown }) : {};
  const r = openWindowRequest({ cwd: o.root, command: o.command, name: o.name }, 0);
  const at = rec && typeof rec === "object" ? (rec as { at?: unknown }).at : undefined;
  if (!r || typeof at !== "number" || nowS - at > FRESH_S || !root || !same(r.root, root)) return undefined;
  return { ...r, at };
}

// ---- continuing in the chat ------------------------------------------------------------------------------

/** The agents whose own conversations the Agents window can take in and go on with in the chat
 *  (Dispatch IDE AgentService.dispatchContinueChat), by their Agent Host provider. */
export const CHAT_PROVIDER: Readonly<Record<string, string>> = { "claude-code": "claude", codex: "codex", opencode: "opencode" };
const NATIVE_ID = /^[\w.-]{4,120}$/;

export interface ContinueRequest {
  provider: string;
  id: string;
}

/** A request for the Agent Host to take a conversation in, or undefined when it is not one. */
export function continueRequest(v: unknown): ContinueRequest | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const provider = typeof o.agent === "string" ? CHAT_PROVIDER[o.agent] : undefined;
  const id = str(o.id);
  return provider && NATIVE_ID.test(id) ? { provider, id } : undefined;
}

/** The Agent Host's answer file, read: {ok, session} or {ok: false, error}. */
export function continueAnswer(text: string): { ok: boolean; session?: string; error?: string } | undefined {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v.ok !== "boolean") return undefined;
    return v.ok ? { ok: true, session: typeof v.session === "string" ? v.session : undefined } : { ok: false, error: typeof v.error === "string" ? v.error.slice(0, 300) : "" };
  } catch {
    return undefined;
  }
}
