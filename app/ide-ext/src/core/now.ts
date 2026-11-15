// dispatch.now: the pure part. The Agents window's Now tab (Dispatch IDE patches/410-now.patch)
// reads one session's line of what it is doing now, with its task, plan, deliveries and handoffs
// (`dispatch now --session <id> --json`, app/cli/now_line.py). Read only: the agent writes the line itself.

export interface NowRequest {
  /** The session: its id or the Agents window resource (`agent-host-claude:/<id>`). */
  session?: unknown;
  /** Also what the session's process shows this moment (asked only while it works or waits: it costs a few seconds). */
  live?: unknown;
}

const SESSION = /^[A-Za-z0-9][\w.+:/-]{3,300}$/;

/** The `dispatch` argv for a request, or undefined when it is not one the window can send. */
export function nowArgs(req: NowRequest | undefined): string[] | undefined {
  if (!req || typeof req !== "object") return undefined;
  const session = typeof req.session === "string" ? req.session.trim() : "";
  if (!SESSION.test(session) || session.includes("..")) return undefined;
  return ["now", "--session", session, ...(req.live === true ? ["--live"] : []), "--json"];
}
