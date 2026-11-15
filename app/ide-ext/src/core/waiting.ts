// dispatch.waiting: the pure part. The Agents window's Waiting for you (Dispatch IDE
// patches/425-waiting.patch) asks the bridge for `dispatch waiting` and acts on its rows; only
// these argument shapes reach the CLI.

export type WaitingOp =
  | "list"
  | "allow"
  | "deny"
  | "pick"
  | "read"
  | "readAll"
  | "unread"
  | "done"
  | "doneAll"
  | "reopen"
  | "snooze"
  | "unsnooze"
  | "reply"
  | "seen";

const ROW_ID = /^(ide|chat):[^\s]{3,300}$/;
const IDE_ROW_ID = /^ide:[^\s]{3,300}$/;
const TASK_ID = /^[a-z][a-z0-9]*-[a-z0-9]{2,8}$/;
/** A design direction's row (`dispatch flow design`): task:<id>. */
const TASK_ROW = /^task:[a-z][a-z0-9]*-[a-z0-9]{2,8}$/;
/** One task id or several, comma separated (the page's Select → Done / Not now). */
const TASK_IDS = /^[a-z][a-z0-9]*-[a-z0-9]{2,8}(,[a-z][a-z0-9]*-[a-z0-9]{2,8}){0,49}$/;
/** An agent's question: the option's id, its label or its number; one line, no leading dash. */
const ANSWER = /^[^\s-][^\n\r]{0,199}$/;
/** A design direction: A to F. */
const DIRECTION = /^[A-F]$/;
const UNTIL = /^(tomorrow|next-week|\d{9,11})$/;

/** pick: which option and, for a design direction, optionally why (one line, kept short). */
export interface PickExtra {
  option?: unknown;
  reason?: unknown;
}

/** The `dispatch` argv for an op, or undefined when the op or the id is not one the page can send. */
export function waitingArgs(op: unknown, id?: unknown, extra?: unknown): string[] | undefined {
  const s = typeof id === "string" ? id.trim() : "";
  const x = typeof extra === "string" ? extra.trim() : "";
  switch (op) {
    case undefined:
    case "list":
      return ["waiting", "--json"];
    case "allow":
    case "deny":
    case "read":
      return ROW_ID.test(s) ? ["waiting", op, s, "--json"] : undefined;
    case "unread":
      return IDE_ROW_ID.test(s) ? ["waiting", "unread", s, "--json"] : undefined;
    case "pick": {
      // the option as it is, or { option, reason } (a design direction's why goes into FACTS.md)
      const pick: PickExtra = typeof extra === "object" && extra !== null ? (extra as PickExtra) : { option: extra };
      const option = typeof pick.option === "string" ? pick.option.trim() : "";
      if (IDE_ROW_ID.test(s)) return ANSWER.test(option) ? ["waiting", "pick", s, option, "--json"] : undefined;
      if (!TASK_ROW.test(s) || !DIRECTION.test(option.toUpperCase())) return undefined;
      const reason = typeof pick.reason === "string" ? pick.reason.replace(/[\r\n\0]+/g, " ").trim().slice(0, 300) : "";
      return ["waiting", "pick", s, option.toUpperCase(), ...(reason ? [`--reason=${reason}`] : []), "--json"];
    }
    case "readAll":
      return ["waiting", "read", "--all", "--json"];
    case "done":
      // one task: `dispatch done` (the board's own close); several: `waiting done a,b`
      if (TASK_ID.test(s)) return ["done", s, "--reason", "Done in Waiting for you", "--json"];
      return TASK_IDS.test(s) ? ["waiting", "done", s, "--json"] : undefined;
    case "doneAll":
      return ["waiting", "done", "--all", "--json"];
    case "reopen":
    case "unsnooze":
      return TASK_IDS.test(s) ? ["waiting", op, s, "--json"] : undefined;
    case "snooze":
      if (!TASK_IDS.test(s)) return undefined;
      if (x && !UNTIL.test(x)) return undefined;
      return ["waiting", "snooze", s, ...(x ? ["--until", x] : []), "--json"];
    case "reply":
      return TASK_ID.test(s) ? ["waiting", "reply", s, "--json"] : undefined;
    case "seen":
      return ["waiting", "seen", "--json"];
    default:
      return undefined;
  }
}
