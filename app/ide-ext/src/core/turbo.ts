// dispatch.turbo: the pure part. The Timeline page and the Turbo switch on a new chat's page (Dispatch IDE
// patches/420-turbo.patch) ask the bridge for `dispatch turbo`; only these argument shapes reach the CLI.

const RUN = /^tb-[0-9]{4}-[0-9]{4}-[0-9a-f]{4}$/;
const PART = /^([0-9]{1,3}|shared|tests|check|land)$/;
const ENGINES = ["claude", "codex", "opencode"];

function run(v: unknown): string | undefined {
  return typeof v === "string" && RUN.test(v) ? v : undefined;
}

function words(v: unknown, max = 8000): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t && t.length <= max ? t : undefined;
}

function folder(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("/") && v.length < 1024 && !v.includes("\0") ? v : undefined;
}

export interface TurboReplan {
  atATime?: number;
  cwd?: string;
  engine?: string;
  model?: string;
}

/** The CLI call for one Timeline operation, or undefined for a request that is not one. Free text always goes in
 *  `--text=…`, so words that start with a dash stay words (a bare `--` trips argparse's subcommands on Python 3.9). */
export function turboArgs(op: unknown, ...a: unknown[]): string[] | undefined {
  switch (op) {
    case undefined:
    case "timeline":
      return ["turbo", "timeline", "--json"];
    case "list":
      return ["turbo", "list", "--json"];
    case "config": {
      const o = (a[0] ?? {}) as { engine?: unknown; model?: unknown };
      if (a[0] === undefined) return ["turbo", "config", "--json"];
      if (typeof o !== "object" || o === null || typeof o.engine !== "string" || !ENGINES.includes(o.engine)) return undefined;
      const model = o.model === undefined || o.model === "" ? "" : words(o.model, 200);
      if (model === undefined || model.startsWith("-")) return undefined;
      return ["turbo", "config", "--engine", o.engine, ...(model ? ["--model", model] : []), "--json"];
    }
    case "plan": {
      const text = words(a[0]);
      const cwd = a[1] === undefined || a[1] === "" ? "" : folder(a[1]);
      if (!text || cwd === undefined) return undefined;
      // the agent and model picked in the input box split the job and run the parts (task-o8wx); none: Turbo's own default
      const pick = (a[2] ?? {}) as { engine?: unknown; model?: unknown };
      const engine = typeof pick.engine === "string" && ENGINES.includes(pick.engine) ? pick.engine : "";
      const model = engine && typeof pick.model === "string" ? words(pick.model, 200) ?? "" : "";
      if (model.startsWith("-")) return undefined;
      return ["turbo", "plan", ...(cwd ? ["--cwd", cwd] : []), ...(engine ? ["--engine", engine] : []), ...(model ? ["--model", model] : []), "--json", `--text=${text}`];
    }
    case "status":
    case "start":
    case "pause":
    case "resume":
    case "cancel":
    case "keep":
    case "land": {
      const r = run(a[0]);
      return r ? ["turbo", op, r, "--json"] : undefined;
    }
    case "replan": {
      const r = run(a[0]);
      const o = (a[1] ?? {}) as TurboReplan;
      if (!r || typeof o !== "object" || o === null) return undefined;
      const args = ["turbo", "replan", r, "--json"];
      if (o.atATime !== undefined) {
        if (!Number.isInteger(o.atATime) || o.atATime < 1 || o.atATime > 8) return undefined;
        args.push("--at-a-time", String(o.atATime));
      }
      if (o.cwd !== undefined) {
        const c = folder(o.cwd);
        if (!c) return undefined;
        args.push("--cwd", c);
      }
      if (o.engine !== undefined) {
        if (!ENGINES.includes(o.engine)) return undefined;
        args.push("--engine", o.engine);
      }
      if (o.model !== undefined && o.model !== "") {
        const m = words(o.model, 200);
        if (!m || m.startsWith("-")) return undefined;
        args.push("--model", m);
      }
      return args.length > 4 ? args : undefined;
    }
    case "switch": {
      // stopped for the allowance: go on with another agent (the person's click on the Timeline)
      const r = run(a[0]);
      const o = (a[1] ?? {}) as { engine?: unknown; model?: unknown };
      if (!r || typeof o !== "object" || o === null || typeof o.engine !== "string" || !ENGINES.includes(o.engine)) return undefined;
      const model = o.model === undefined || o.model === "" ? "" : words(o.model, 200);
      if (model === undefined || model.startsWith("-")) return undefined;
      return ["turbo", "switch", r, "--engine", o.engine, ...(model ? ["--model", model] : []), "--json"];
    }
    case "answer": {
      const r = run(a[0]);
      const p = typeof a[1] === "number" ? String(a[1]) : a[1];
      const text = words(a[2], 2000);
      return r && typeof p === "string" && PART.test(p) && text ? ["turbo", "answer", r, p, "--json", `--text=${text}`] : undefined;
    }
    case "add": {
      const r = run(a[0]);
      const text = words(a[1], 400);
      return r && text ? ["turbo", "add", r, "--json", `--text=${text}`] : undefined;
    }
    default:
      return undefined;
  }
}
