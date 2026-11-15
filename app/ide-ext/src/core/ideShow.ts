// `dispatch ide show` (kanban app/cli/ide_show.py): the pure part. The CLI leaves
// <DISPATCH_DIR>/ide/requests/<id>.json; the Agents window's bridge takes it, opens the target in
// the right panel and answers <id>.done. Only these shapes are acted on.

export interface ShowRequest {
  id: string;
  /** An absolute path, or an http(s) URL. */
  target: string;
  /** The Agents window's session resource to switch to first, or "". */
  session: string;
  /** The task it was delivered for (`--task`, `task deliver --show`, `deliver --show`), or "": the Docs reader's second line names it. */
  task: string;
  at: number;
  /** A delivery page (`dispatch deliver --show`): impl | proposal. */
  delivery?: "impl" | "proposal";
}

/** A request is taken while it is this fresh (seconds); the CLI gives up after a few. */
export const SHOW_FRESH_S = 30;
/** The heartbeat the CLI checks (agents-window.json) is rewritten this often (ms). */
export const HEARTBEAT_MS = 4000;

const ID = /^[a-f0-9]{6,32}$/;
const TASK = /^[A-Za-z][\w.-]{1,60}$/;
const SESSION = /^[A-Za-z][\w+.-]*:\/[^\s]{1,300}$/;

/** The request in a file's text, or undefined when it is not one to act on. */
export function parseShowRequest(text: string, nowS: number): ShowRequest | undefined {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!rec || typeof rec !== "object") return undefined;
  const id = typeof rec.id === "string" ? rec.id : "";
  const target = typeof rec.target === "string" ? rec.target.trim() : "";
  const session = typeof rec.session === "string" ? rec.session.trim() : "";
  const at = typeof rec.at === "number" ? rec.at : 0;
  const task = typeof rec.task === "string" && TASK.test(rec.task.trim()) ? rec.task.trim() : "";
  if (!ID.test(id) || !target || /[\n\r\0]/.test(target)) return undefined;
  if (!(target.startsWith("/") || /^https?:\/\//i.test(target))) return undefined;
  if (session && !SESSION.test(session)) return undefined;
  if (nowS - at > SHOW_FRESH_S || at - nowS > SHOW_FRESH_S) return undefined;
  const out: ShowRequest = { id, target, session, task, at };
  const delivery = rec.delivery === "impl" || rec.delivery === "proposal" ? rec.delivery : undefined;
  if (delivery && target.startsWith("/") && /\.html?$/i.test(target)) {
    if (delivery === "proposal" && !task) return undefined;
    out.delivery = delivery;
  }
  return out;
}

/** `<id>.json` names in a directory listing, oldest first by the name order the CLI gives them. */
export function requestFiles(names: string[]): string[] {
  return names.filter((n) => /^[a-f0-9]{6,32}\.json$/.test(n)).sort();
}

// `dispatch browser --ide …` (kanban app/cli/browser_ide.py): a terminal session drives the
// integrated browser in the right panel. Same folder and files as `ide show`, with `kind: "browser"`
// and the command in `args`; the bridge runs `_dispatch.browser` (Dispatch IDE
// patches/710-browser-agent-tools.patch) and answers `{ok, result}` in <id>.done.

/** What the heartbeat (agents-window.json) says this bridge can do, so an older CLI or bridge is never left waiting. */
// "browser-profiles": the login identities (`open` with `profile`, `profiles`, `profile-add`), so the CLI
// never sends a profile to a bridge that would drop it and open the page as someone else.
// "browser-size": `size` lays the page out at a desktop width, scaled into the panel (a site that shows its
// phone page in the narrow panel, like Higgsfield); without it the CLI says to update instead of waiting.
export const IDE_FEATURES = ["show", "browser", "browser-profiles", "browser-size"] as const;

export const BROWSER_ACTIONS = ["status", "open", "go", "read", "click", "type", "press", "shot", "profiles", "profile-add", "size"] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export interface BrowserArgs {
  action: BrowserAction;
  url?: string;
  page?: string;
  ref?: string;
  selector?: string;
  element?: string;
  text?: string;
  key?: string;
  submit?: boolean;
  engine?: string;
  /** `open`: a login identity by name. */
  profile?: string;
  /** `profile-add`: the new identity's name. */
  name?: string;
  /** `size`: the width and height to lay the page out at; both missing: back to the panel's own size. */
  width?: number;
  height?: number;
}

export interface BrowserRequest {
  id: string;
  args: BrowserArgs;
  at: number;
}

const STRING_ARGS = ["url", "page", "ref", "selector", "element", "text", "key", "engine", "profile", "name"] as const;

/** A browser request in a file's text, or undefined when the file is not one (a show request, junk, stale). */
export function parseBrowserRequest(text: string, nowS: number): BrowserRequest | undefined {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!rec || typeof rec !== "object" || rec.kind !== "browser") return undefined;
  const id = typeof rec.id === "string" ? rec.id : "";
  const at = typeof rec.at === "number" ? rec.at : 0;
  const raw = rec.args && typeof rec.args === "object" ? (rec.args as Record<string, unknown>) : undefined;
  if (!ID.test(id) || !raw) return undefined;
  if (nowS - at > SHOW_FRESH_S || at - nowS > SHOW_FRESH_S) return undefined;
  const action = raw.action;
  if (typeof action !== "string" || !(BROWSER_ACTIONS as readonly string[]).includes(action)) return undefined;
  const args: BrowserArgs = { action: action as BrowserAction };
  for (const k of STRING_ARGS) {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 20000 && !/\0/.test(v)) args[k] = v;
  }
  if (raw.submit === true) args.submit = true;
  if (action === "size" && (raw.width !== undefined || raw.height !== undefined)) {
    const w = raw.width, h = raw.height;
    const ok = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
    if (!ok(w, 320, 3840) || !ok(h, 320, 2400)) return undefined;
    args.width = w as number;
    args.height = h as number;
  }
  if ((action === "open" || action === "go") && !/^(https?|file):\/\//i.test(args.url ?? "")) return undefined;
  if (action === "profile-add" && !args.name) return undefined;
  return { id, args, at };
}
