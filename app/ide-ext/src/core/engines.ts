// Pure helpers for dispatch.engines (no vscode import, vitest runs them from app/).

export interface EngineRow {
  id: string;
  name: string;
  installed: boolean;
  version: string;
  latest: string;
  update_available: boolean;
  method: string;
  command: string;
  /** the oldest version Dispatch can drive ("" when there is no minimum) and whether the installed copy reaches it */
  min_version?: string;
  supported?: boolean;
}

export const ENGINE_IDS = ["claude", "codex", "opencode"] as const;

const AGENT_ID = /^[a-z][a-z0-9-]{0,30}$/;

/** A comma list of agent ids from `{ off, on }`: ids only, or undefined when the field is not a list of them. */
function agentList(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length > 60 || !v.every(x => typeof x === "string" && AGENT_ID.test(x))) return undefined;
  return v.join(",");
}

/** The CLI arguments for a request from Customizations: list (all, or one engine), refresh, check (installed
 *  versions only, never asks npm: fast enough for a notice above the input), or upgrade one. `detect` finds every
 *  agent CLI on this Mac, `enabled` reads which ones are turned on, `use` ({ off, on, default } or { reset }) saves that. */
export function enginesArgs(op: unknown, id: unknown, arg?: unknown): string[] | undefined {
  if (op === "detect") return ["engines", "detect", "--json"];
  if (op === "enabled") return ["engines", "enabled", "--json"];
  if (op === "use") {
    const r = (arg ?? {}) as Record<string, unknown>;
    if (r.reset === true) return ["engines", "use", "--reset", "--json"];
    const off = r.off === undefined ? "" : agentList(r.off);
    const on = r.on === undefined ? "" : agentList(r.on);
    const dflt = r.default === undefined ? "" : typeof r.default === "string" && (r.default === "" || AGENT_ID.test(r.default)) ? r.default : undefined;
    if (off === undefined || on === undefined || dflt === undefined || (r.off === undefined && r.on === undefined && r.default === undefined)) return undefined;
    return ["engines", "use", ...(r.off !== undefined ? ["--off", off] : []), ...(r.on !== undefined ? ["--on", on] : []), ...(r.default !== undefined ? ["--default", dflt] : []), "--json"];
  }
  const engine = typeof id === "string" && (ENGINE_IDS as readonly string[]).includes(id) ? id : "";
  if (op === undefined || op === "list") return ["engines", "list", ...(engine ? [engine] : []), "--json"];
  if (op === "refresh") return ["engines", "list", ...(engine ? [engine] : []), "--refresh", "--json"];
  if (op === "check") return ["engines", "list", ...(engine ? [engine] : []), "--offline", "--json"];
  if (op === "upgrade" && engine) return ["engines", "upgrade", engine, "--json"];
  if (op === "login" && (engine === "claude" || engine === "codex")) return ["engines", "login", engine, "--json"];
  return undefined;
}
