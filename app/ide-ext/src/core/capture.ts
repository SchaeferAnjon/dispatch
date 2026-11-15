// dispatch.capture: the pure part. The line under a message in the Agents window ("Noted 2 · next up #3", Dispatch IDE
// patches/dispatch-capture.patch) and the Assistant's home ask the bridge for `dispatch capture` and `dispatch nextup`
// (app/cli/capture.py); only these argument shapes reach the CLI.

export interface CaptureRun {
  args: string[];
  /** The message, on stdin (it can be long and hold anything). */
  input?: string;
}

const SESSION = /^[A-Za-z0-9][\w.+:/%@-]{3,400}$/;
const TASK = /^[A-Za-z0-9][\w.-]{1,80}$/;
const RECEIPT = /^n[0-9a-f]{6,24}$/;

function str(v: unknown, max = 4000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function task(v: unknown): string | undefined {
  const t = str(v, 100);
  return TASK.test(t) ? t : undefined;
}

/** The argv (and stdin) for a request from the window, or undefined when it is not one it can send. */
export function captureArgs(op: unknown, arg?: unknown): CaptureRun | undefined {
  const a = (arg && typeof arg === "object" ? arg : {}) as Record<string, unknown>;
  switch (op) {
    case "note": {
      const text = typeof a.text === "string" ? a.text.slice(0, 8000) : "";
      const session = str(a.session, 400);
      if (!text.trim() || (session && (!SESSION.test(session) || session.includes("..")))) return undefined;
      const args = ["capture", "note", "--text", "-", "--json"];
      if (session) args.push("--session", session);
      const cwd = str(a.cwd, 1000);
      if (cwd.startsWith("/") && !cwd.includes("\0")) args.push("--cwd", cwd);
      const title = str(a.title, 200);
      if (title) args.push("--title", title);
      if (a.chat === true) args.push("--chat");
      return { args, input: text };
    }
    case "list":
      return { args: ["capture", "list", "--json"] };
    case "front":
    case "later":
    case "lineup":
    case "drop":
    case "undo":
    case "requeue":
    case "targets": {
      const t = task(a.task);
      return t ? { args: ["capture", op, t, "--json"] } : undefined;
    }
    case "edit": {
      const t = task(a.task);
      const title = str(a.title, 200);
      return t && title ? { args: ["capture", "edit", t, title, "--json"] } : undefined;
    }
    case "merge": {
      const t = task(a.task), into = task(a.into);
      return t && into && t !== into ? { args: ["capture", "merge", t, into, "--json"] } : undefined;
    }
    case "keep":
    case "noteit": {
      const r = str(a.receipt, 40);
      const i = typeof a.index === "number" && Number.isInteger(a.index) && a.index >= 0 && a.index < 20 ? a.index : -1;
      return RECEIPT.test(r) && i >= 0 ? { args: ["capture", op, r, String(i), "--json"] } : undefined;
    }
    case "seen":
      return { args: ["capture", "seen", "--json"] };
    case "nextup":
      return { args: ["nextup", "list", "--json"] };
    case "pause":
    case "resume":
    case "retry":
      return { args: ["nextup", op, "--json"] };
    case "requeueAll":
      return { args: ["nextup", "requeue", "--json"] };
    case "settings":
      return { args: ["nextup", "settings", "--json"] };
    case "limit": {
      const n = a.limit;
      return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20 ? { args: ["nextup", "limit", String(n), "--json"] } : undefined;
    }
    case "engine": {
      const e = a.engine;
      return e === "" || e === "default" || e === "claude" || e === "codex" || e === "opencode"
        ? { args: ["nextup", "engine", e === "" ? "default" : e, "--json"] } : undefined;
    }
    default:
      return undefined;
  }
}
