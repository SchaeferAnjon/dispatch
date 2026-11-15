// dispatch.inbox: the pure part. The bell in the Agents window's title bar (Dispatch IDE
// patches/470-notifications.patch) lists `dispatch inbox`, files what a session just did
// (finished / needs you / stopped) and marks rows read or unread again; it also shows who is asleep
// (`dispatch sleep`). Only these argument shapes reach the CLI.

export type InboxOp = "list" | "add" | "read" | "unread" | "readSession" | "readAll" | "sleep" | "sleepOn" | "sleepOff" | "prefs" | "sound";

/** What the window knows about a session when its status changes. */
export interface InboxAdd {
  status?: unknown;
  session?: unknown;
  agent?: unknown;
  title?: unknown;
  project?: unknown;
  cwd?: unknown;
  text?: unknown;
  why?: unknown;
}

const EVENT_ID = /^[0-9a-f]{12}$/;
/** A session: the Agents window's resource (a URI, one token) or chatd's <agent>:<id>. */
const SESSION = /^[a-zA-Z][a-zA-Z0-9+.-]{1,40}:[^\s]{3,400}$/;
const STATUS = /^(completed|needs_input|error|cancelled)$/;
const BY = /^(you|working|stopped)$/;
/** A sound: "default", "none" or one of the Mac's sounds by name (the CLI checks it against the Mac's). */
const SOUND = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\r\n\0]+/g, " ").trim().slice(0, max) : "";
}

/** The `dispatch` argv for an op, or undefined when the op or its argument is not one the bell sends.
 *  `userData` (the Agents window's user data folder) lets the CLI find a finished session's last words. */
export function inboxArgs(op: unknown, arg?: unknown, extra?: unknown, userData = ""): string[] | undefined {
  const ud = userData.startsWith("/") ? [`--user-data=${userData}`] : [];
  switch (op) {
    case undefined:
    case "list":
      return ["inbox", "list", "--limit", "40", ...ud, "--json"];
    case "prefs":
      return ["inbox", "prefs", "--json"];
    case "sound": {
      if (arg === undefined) return ["inbox", "sound", "--json"];
      return typeof arg === "string" && SOUND.test(arg) ? ["inbox", "sound", arg, "--json"] : undefined;
    }
    case "read":
    case "unread": {
      const ids = (Array.isArray(arg) ? arg : [arg]).filter((x): x is string => typeof x === "string" && EVENT_ID.test(x));
      return ids.length && ids.length <= 50 ? ["inbox", op, ...ids, "--json"] : undefined;
    }
    case "readSession": {
      const s = line(arg, 400);
      const by = typeof extra === "string" && BY.test(extra) ? extra : "you";
      return SESSION.test(s) ? ["inbox", "read", "--session", s, "--by", by, "--json"] : undefined;
    }
    case "readAll":
      return ["inbox", "read", "--all", "--json"];
    case "add": {
      const a = (typeof arg === "object" && arg !== null ? arg : {}) as InboxAdd;
      const status = line(a.status, 20);
      const session = line(a.session, 400);
      if (!STATUS.test(status) || !SESSION.test(session)) return undefined;
      const out = ["inbox", "add", "--status", status, "--session", session, "--source", "ide"];
      const opt = (flag: string, v: unknown, max: number) => {
        const s = line(v, max);
        // a value that starts with a dash would read as a flag: `--flag=value` keeps it a value
        if (s) out.push(`${flag}=${s}`);
      };
      opt("--agent", a.agent, 40);
      opt("--title", a.title, 200);
      opt("--project", a.project, 120);
      opt("--cwd", a.cwd, 600);
      opt("--text", a.text, 400);
      opt("--why", a.why, 300);
      out.push(...ud, "--json");
      return out;
    }
    case "sleep":
      return ["sleep", "--json"];
    case "sleepOn":
      return ["sleep", "on", "--json"];
    case "sleepOff":
      return ["sleep", "off", "--json"];
    default:
      return undefined;
  }
}
