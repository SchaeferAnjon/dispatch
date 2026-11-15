// dispatch.terminal: the pure part. The Agents window's terminal (Dispatch IDE patches/610-terminal.patch)
// asks the bridge which agents can run in it, what the person's Ghostty settings would bring, where the terminal
// daemon listens (it is started when it is not running) and the snippets; only these requests reach
// `dispatch terminal` (kanban app/cli/terminal_cmd.py).

/** One agent that can run in a terminal (`dispatch terminal agents`). */
export interface TerminalAgent {
  id: string;
  name: string;
  /** One plain sentence: who makes it, what it costs or needs. */
  about: string;
  /** What is typed into the terminal to start it: the full path plus the arguments that open its terminal interface. */
  command: string;
  /** The lines to type to start it with a conversation id, to go on after a restart, to start a copy of its
   * conversation; `{session}` / `{new}` are filled by the window, '' when the agent has no such way. */
  start?: string;
  resume?: string;
  fork?: string;
  /** Dispatch's chat drives it too (Claude Code, Codex, OpenCode). */
  runnable: boolean;
  /** The person uses it with Dispatch (ticked in the setup, or one Dispatch runs). */
  enabled: boolean;
  is_default: boolean;
}

/** What the terminal would take from the person's Ghostty settings (`dispatch terminal ghostty`). */
export interface GhosttyPreview {
  found: boolean;
  paths: string[];
  summary?: { font: string; size?: number; theme: string; cursor: string };
  /** VS Code setting names: terminal.integrated.fontFamily, fontSize, cursorStyle, cursorBlinking. */
  settings?: Record<string, string | number | boolean>;
  /** workbench.colorCustomizations entries for the terminal. */
  colors?: Record<string, string>;
  /** Colors for each appearance when the Ghostty theme is a light/dark pair (then `colors` is empty). */
  colors_by_scheme?: { light?: Record<string, string>; dark?: Record<string, string> } | null;
  left_out?: string[];
  error?: string;
}

/** A snippets request: { op: list | add | update | remove, id?, name?, text? }. */
export interface SnippetsRequest {
  op?: string;
  id?: string;
  name?: string;
  text?: string;
}

const SNIPPET_OPS = ["list", "add", "update", "remove"];

/**
 * The CLI call for one request, or undefined for a request that is not one. `appRoot` is Dispatch IDE's
 * Resources/app (the daemon runs on that app's Electron).
 */
export function terminalArgs(op: unknown, arg?: unknown, appRoot?: string): string[] | undefined {
  if (op === "agents") return ["terminal", "agents", "--json"];
  if (op === "ghostty") return ["terminal", "ghostty", "--json"];
  if (op === "daemon") {
    // { ifKept: true }: a window opening asks only for terminals kept from before, and starts nothing otherwise
    const ifKept = !!(arg && typeof arg === "object" && (arg as { ifKept?: unknown }).ifKept === true);
    return ["terminal", "daemon", "start", "--json", ...(ifKept ? ["--if-kept"] : []), ...(appRoot ? ["--app-root", appRoot] : [])];
  }
  if (op === "snippets") {
    const r = (arg && typeof arg === "object" ? arg : {}) as SnippetsRequest;
    const sub = typeof r.op === "string" && SNIPPET_OPS.includes(r.op) ? r.op : "list";
    const out = ["terminal", "snippets", sub, "--json"];
    // `--x=value`: words that start with a dash stay words
    if (typeof r.id === "string" && r.id) out.push(`--id=${r.id}`);
    if (typeof r.name === "string") out.push(`--name=${r.name}`);
    if (typeof r.text === "string") out.push(`--text=${r.text}`);
    return out;
  }
  return undefined;
}

const SETTING = /^terminal\.integrated\.(fontFamily|fontSize|cursorStyle|cursorBlinking)$/;
const COLOR = /^terminal(Cursor)?\.[A-Za-z]+$/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** The answer as the window uses it: only the four terminal settings and terminal colors, whatever else was in it dropped. */
export function shapeGhostty(raw: unknown): GhosttyPreview {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<GhosttyPreview>;
  if (!r.found) return { found: false, paths: Array.isArray(r.paths) ? r.paths.filter((p) => typeof p === "string") : [], error: typeof r.error === "string" ? r.error : "" };
  const settings: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(r.settings ?? {})) {
    if (SETTING.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) settings[k] = v;
  }
  const colors = (m: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((m && typeof m === "object" ? m : {}) as Record<string, unknown>)) {
      if (COLOR.test(k) && typeof v === "string" && HEX.test(v)) out[k] = v;
    }
    return out;
  };
  const by = r.colors_by_scheme;
  const scheme = by && typeof by === "object" ? { light: colors(by.light), dark: colors(by.dark) } : null;
  const s = r.summary;
  return {
    found: true,
    paths: Array.isArray(r.paths) ? r.paths.filter((p) => typeof p === "string") : [],
    summary: { font: typeof s?.font === "string" ? s.font : "", size: typeof s?.size === "number" ? s.size : undefined, theme: typeof s?.theme === "string" ? s.theme : "", cursor: typeof s?.cursor === "string" ? s.cursor : "" },
    settings,
    colors: colors(r.colors),
    colors_by_scheme: scheme && (Object.keys(scheme.light).length || Object.keys(scheme.dark).length) ? scheme : null,
    left_out: Array.isArray(r.left_out) ? r.left_out.filter((x) => typeof x === "string") : [],
    error: typeof r.error === "string" ? r.error : "",
  };
}
