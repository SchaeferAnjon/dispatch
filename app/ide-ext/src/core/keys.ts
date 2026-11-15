// Pure helpers for dispatch.env (no vscode import, vitest runs them from app/): Settings › Keys in the Agents window
// (Dispatch IDE contrib/dispatchSettings/browser/dispatchSettingsKeys.ts) reads and changes Dispatch's key store
// (`dispatch env`, ~/.config/dispatch/env, 0600). A value only ever travels on the CLI's stdin (saving) or stdout
// (Show, Copy): never as an argument, so it is not in the process list, and never in a log line.

export interface KeysCall {
  args: string[];
  /** written to the CLI's stdin */
  input?: string;
  /** the answer is the value itself, not JSON (`env get`) */
  text?: boolean;
}

/** One line of ~/.dispatch/state/env-events.jsonl (app/cli/env_changes.py): what changed, never the value. */
export interface KeyEvent {
  id: string;
  op: "set" | "edit" | "unset" | "undo";
  name: string;
  note: string;
  project: string;
  by: string;
  at: string;
  created: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHANGE = /^envc-[a-z0-9]{8}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** A purpose or a project is one line. */
const line = (v: unknown) => str(v).replace(/[\r\n]+/g, " ").trim().slice(0, 300);

function nameOf(p: Record<string, unknown>): string {
  const n = str(p.name).trim();
  if (!NAME.test(n)) throw new Error("A key's name has letters, digits and underscores, and does not start with a digit.");
  return n;
}

/** The CLI call for an operation of the Keys page; throws for one it does not make. */
export function keysCall(op: string, p: Record<string, unknown> = {}): KeysCall {
  switch (op) {
    case "list":
      return { args: ["env", "list", "--json"] };
    case "reveal":
      return { args: ["env", "get", nameOf(p)], text: true };
    case "save": {
      // the purpose and project as `--x=value`: one that starts with "-" stays a value
      const args = ["env", "set", nameOf(p), "--by", "settings", "--json", `--note=${line(p.note)}`, `--project=${line(p.project)}`];
      const value = str(p.value);
      if (value) {
        if (/[\r\n]/.test(value.trim())) throw new Error("A key is one line.");
        return { args: [...args, "--stdin"], input: value.trim() };
      }
      return { args, input: "" };
    }
    case "remove":
      return { args: ["env", "unset", nameOf(p), "--by", "settings", "--json"] };
    case "undo": {
      const change = str(p.change);
      if (!CHANGE.test(change)) throw new Error("Not a change Dispatch made.");
      return { args: ["env", "undo", change, "--by", "settings", "--json"] };
    }
    default:
      throw new Error(`dispatch.env: no operation ${op}`);
  }
}

/** The events in the file's text, oldest first; lines that are not one are skipped. */
export function parseKeyEvents(text: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l) as Partial<KeyEvent>;
      if (e && typeof e.id === "string" && typeof e.name === "string" && typeof e.op === "string") {
        out.push({ id: e.id, op: e.op as KeyEvent["op"], name: e.name, note: str(e.note), project: str(e.project), by: str(e.by), at: str(e.at), created: !!e.created });
      }
    } catch {
      // a line being written, or not ours
    }
  }
  return out;
}

/** The events not seen yet; `seen` takes them in. The file is rewritten when it is trimmed, so ids, not offsets. */
export function newKeyEvents(text: string, seen: Set<string>): KeyEvent[] {
  const fresh = parseKeyEvents(text).filter(e => !seen.has(e.id));
  for (const e of fresh) seen.add(e.id);
  return fresh;
}
