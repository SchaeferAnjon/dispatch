// dispatch.tasks: the pure part. The Agents window's Tasks tab, task graph and task page (Dispatch IDE
// patches/430-tasks.patch, 430-tasks.patch, 330-task-links.patch) read the task
// model through the bridge; only these read-only argument shapes reach the CLI.

export interface TasksRequest {
  op?: unknown;
  /** The session's folder (a worktree counts as its repository). */
  folder?: unknown;
  /** One session: its id or the Agents window resource (`agent-host-claude:/<id>`). */
  session?: unknown;
  project?: unknown;
  /** show: the task id. */
  id?: unknown;
  /** list / graph: the tasks touched in the last N days (the CLI's default is 30; 0 = all). */
  days?: unknown;
  /** list: the tasks before that window instead (a project's Archive). */
  archived?: unknown;
  /** show: only the task, not its commits (a title lookup for a task named in text). */
  brief?: unknown;
}

const TASK_ID = /^[a-z][a-z0-9]*-[a-z0-9]{2,8}$/;
const SESSION = /^[A-Za-z0-9][\w.+:/-]{3,300}$/;
const PROJECT = /^[^\s-][^\n\r]{0,120}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function folderPath(v: unknown): string {
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

/** The `dispatch` argv for a request, or undefined when it is not one the window can send. */
export function tasksArgs(req: TasksRequest | undefined): string[] | undefined {
  if (!req || typeof req !== "object") return undefined;
  const op = req.op ?? "list";
  if (op === "show") {
    const id = str(req.id);
    if (!TASK_ID.test(id)) return undefined;
    return req.brief === true ? ["task", "show", id, "--brief", "--json"] : ["task", "show", id, "--json"];
  }
  if (op !== "list" && op !== "graph") return undefined;
  const args = ["task", op];
  const session = str(req.session);
  const folder = folderPath(req.folder);
  const project = str(req.project);
  if (session && !SESSION.test(session)) return undefined;
  if (str(req.folder) && !folder) return undefined;
  if (project && !PROJECT.test(project)) return undefined;
  if (project) args.push("--project", project);
  else if (folder) args.push("--folder", folder);
  if (session) args.push("--session", session);
  if (args.length === 2) return undefined;
  const days = typeof req.days === "number" && Number.isInteger(req.days) && req.days >= 0 && req.days <= 3650 ? req.days : undefined;
  if (days !== undefined) args.push("--days", String(days));
  if (op === "list" && req.archived === true) args.push("--archived");
  args.push("--json");
  return args;
}

/** Equivalent read requests share a process even when callers spell the defaults differently. */
export function tasksRequestKey(args: string[]): string {
  const normalized = [...args];
  for (let i = 2; i < normalized.length; i++) {
    if (normalized[i] === "--days" && normalized[i + 1] === "30") normalized.splice(i--, 2);
    else if (normalized[i] === "--folder") normalized[i + 1] = normalized[i + 1].replace(/\/+$/, "") || "/";
    else if (normalized[i] === "--session") {
      const value = normalized[i + 1];
      const id = value.replace(/^[a-z][\w+.-]*:\/*/i, "").replace(/\/+$/, "").split("/").pop()!;
      // The CLI resolves an OpenCode host id to a second, native id only with this scheme.
      const openCode = /^(?:vscode-)?(?:agent-host-)?opencode:/i.test(value) && !id.startsWith("ses_");
      normalized[i + 1] = openCode ? `opencode:${id}` : id;
    }
  }
  return normalized.join("\u0000");
}
