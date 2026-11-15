// dispatch.projects: the pure part. The Agents window's Projects (Dispatch IDE
// patches/sessions-projects.patch: the sidebar's project groups, the Projects page, a project's page)
// asks the bridge for `dispatch projects` / `dispatch projects-view`; only these argument shapes reach the CLI.

export type ProjectsOp = "registry" | "sidebar" | "page" | "project" | "add" | "new" | "rename" | "renameKey" | "renameKeyCheck" | "open" | "host" | "defaults" | "create" | "clone" | "cloneProgress" | "cloneCancel" | "custom" | "look" | "tool" | "copies";

const ICONS = new Set(["folder", "symbol", "emoji", "picture"]);
const WORD = /^[a-z][a-z0-9-]{0,40}$/;

const NAME = /^[^\u0000-\u001f]{1,120}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,120}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

function absPath(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s.startsWith("/") && !s.includes("\u0000") && s.length < 1024 ? s : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The `dispatch` argv for an op, or undefined when the op or its argument is not one the window can send. */
export function projectsArgs(op: unknown, arg?: unknown, extra?: unknown): string[] | undefined {
  switch (op) {
    case undefined:
    case "registry":
      return ["projects", "--json"];
    case "sidebar":
      return ["projects", "--sidebar", "--json"];
    case "page":
      return ["projects-view", "--json"];
    case "project": {
      const name = str(arg);
      return NAME.test(name) && !name.startsWith("-") ? ["projects-view", "--project", name, "--json"] : undefined;
    }
    case "add":
    case "new": {
      const dir = absPath(arg);
      if (!dir) return undefined;
      const name = str(extra);
      if (name && (!NAME.test(name) || name.startsWith("-"))) return undefined;
      return ["projects-view", op, dir, ...(name ? ["--name", name] : []), "--json"];
    }
    case "rename": {
      // what the window calls a project; an empty label goes back to its name. `--name=` keeps a label that starts with "-" a value.
      const name = str(arg);
      const label = str(extra);
      if (!NAME.test(name) || name.startsWith("-") || label.length > 80 || /[\u0000-\u001f]/.test(label)) return undefined;
      return ["projects-view", "rename", name, `--name=${label}`, "--json"];
    }
    case "renameKey":
    case "renameKeyCheck": {
      // the project's name itself: its tasks, documents, preferences and notes move along (task-ysxde); the check
      // only counts them
      const name = str(arg);
      const next = str(extra);
      if (!NAME.test(name) || name.startsWith("-") || !next || next.length > 80 || next.startsWith("-") || next.includes("#") || /[\u0000-\u001f]/.test(next)) return undefined;
      return ["projects-view", "rename", name, `--name=${next}`, "--key", ...(op === "renameKeyCheck" ? ["--dry-run"] : []), "--json"];
    }
    case "open": {
      const id = str(arg);
      const host = str(extra);
      return SESSION_ID.test(id) && HOST.test(host) ? ["projects-view", "open", id, "--on", host, "--json"] : undefined;
    }
    case "host": {
      const host = str(arg);
      return HOST.test(host) ? ["projects-view", "--host", host, "--json"] : undefined;
    }
    case "custom": {
      // the project's Customize page (dispatch project-custom show)
      const name = str(arg);
      return NAME.test(name) && !name.startsWith("-") ? ["project-custom", "show", name, "--json"] : undefined;
    }
    case "tool": {
      // {server, engine, on}: one MCP server for one engine in this project only
      const name = str(arg);
      const server = field(extra, "server");
      const engine = field(extra, "engine");
      const on = extra && typeof extra === "object" ? (extra as Record<string, unknown>).on : undefined;
      if (!NAME.test(name) || name.startsWith("-") || !/^[A-Za-z0-9_.@-]{1,120}$/.test(server) || server.startsWith("-")) return undefined;
      if (!["claude-code", "codex", "opencode"].includes(engine) || typeof on !== "boolean") return undefined;
      return ["project-custom", "tool", name, "--server", server, "--engine", engine, on ? "--on" : "--off", "--json"];
    }
    case "copies": {
      // {auto}: whether a copy for parallel work gets ready on its own
      const name = str(arg);
      const auto = extra && typeof extra === "object" ? (extra as Record<string, unknown>).auto : undefined;
      if (!NAME.test(name) || name.startsWith("-") || typeof auto !== "boolean") return undefined;
      return ["project-custom", "copies", name, "--auto", auto ? "on" : "off", "--json"];
    }
    case "look": {
      // {icon?, symbol?, emoji?, picture?, color?}: what the Look section set
      const name = str(arg);
      if (!NAME.test(name) || name.startsWith("-") || !extra || typeof extra !== "object") return undefined;
      const out = ["project-custom", "look", name];
      const icon = field(extra, "icon");
      if (icon) { if (!ICONS.has(icon)) return undefined; out.push("--icon", icon); }
      const symbol = field(extra, "symbol");
      if (symbol) { if (!WORD.test(symbol)) return undefined; out.push("--symbol", symbol); }
      const emoji = field(extra, "emoji");
      if (emoji) { if (emoji.length > 16 || /[\u0000-\u001f\s]/.test(emoji)) return undefined; out.push(`--emoji=${emoji}`); }
      const picture = field(extra, "picture");
      if (picture) { if (!absPath(picture)) return undefined; out.push(`--picture=${picture}`); }
      const color = field(extra, "color");
      if (color) { if (!WORD.test(color)) return undefined; out.push("--color", color); }
      return out.length > 3 ? [...out, "--json"] : undefined;
    }
    default:
      return undefined;
  }
}

const PROGRESS_ID = /^[A-Za-z0-9-]{8,40}$/;
// a web address as people paste it: https://, ssh://, git@host:path, github.com/owner/name or a folder on this Mac
const ADDRESS = /^[^\s\u0000-\u001f-][^\s\u0000-\u001f]{0,1023}$/;

/** Where the copy's progress is written for the window to read (only an id of this shape names a file). */
export function cloneProgressFile(tmpDir: string, id: unknown): string | undefined {
  const s = typeof id === "string" ? id : "";
  return PROGRESS_ID.test(s) ? `${tmpDir.replace(/\/+$/, "")}/dispatch-clone-${s}.json` : undefined;
}

function field(o: unknown, key: string): string {
  return o && typeof o === "object" ? str((o as Record<string, unknown>)[key]) : "";
}

/**
 * The `dispatch` argv for Add project's three ways besides Choose a folder (the dialog sends an options object):
 *  - defaults: where new projects go and whether git works
 *  - create {name, parent?}: a new project by name
 *  - clone {address, parent?, name?, progressId}: a copy of a project from a web address
 * `machine` (anything but this Mac) is passed on so the CLI can say it is not supported yet.
 */
export function createArgs(op: unknown, opts: unknown, tmpDir: string): string[] | undefined {
  if (op === "defaults") return ["projects-view", "defaults", "--json"];
  if (op !== "create" && op !== "clone") return undefined;
  const parent = field(opts, "parent");
  if (parent && !absPath(parent) && parent !== "~" && !parent.startsWith("~/")) return undefined;
  const machine = field(opts, "machine");
  if (machine && !HOST.test(machine)) return undefined;
  const tail = [...(parent ? ["--parent", parent] : []), ...(machine ? ["--on", machine] : []), "--json"];
  if (op === "create") {
    const name = field(opts, "name");
    // `--name=` keeps a name that starts with "-" a value; the CLI refuses those names with a message
    return name && NAME.test(name) ? ["projects-view", "new", `--name=${name}`, ...tail] : undefined;
  }
  const address = field(opts, "address");
  const name = field(opts, "name");
  const file = cloneProgressFile(tmpDir, field(opts, "progressId"));
  if (!ADDRESS.test(address) || !file) return undefined;
  if (name && (!NAME.test(name) || name.startsWith("-"))) return undefined;
  return ["projects-view", "clone", address, ...(name ? [`--name=${name}`] : []), "--progress-file", file, ...tail];
}
