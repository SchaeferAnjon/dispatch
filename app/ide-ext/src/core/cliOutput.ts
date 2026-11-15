// Pure helpers for talking to the `dispatch` CLI: which program to run and how to read its answer.
// No vscode import here, so vitest can run these from app/.

export interface CliTarget {
  cmd: string;
  pre: string[];
}

export interface CliEnv {
  [key: string]: string | undefined;
}

/**
 * The program that runs `dispatch …`. `ide start` gives the server DISPATCH_BIN (dispatch.py when it
 * is executable, else the `dispatch` on PATH) and DISPATCH_CLI / DISPATCH_PYTHON; the extension host
 * inherits them. `override` is the Command Location setting (dispatch.commandLocation).
 */
/**
 * `bundled` is the CLI inside Dispatch IDE (Resources/app/dispatch-cli/dispatch/cli/dispatch.py): used when no
 * dispatch is installed yet, so a new Mac's first-run wizard can start (it then links ~/.local/bin/dispatch).
 */
export function cliTarget(env: CliEnv, home: string, exists: (p: string) => boolean, override = "", bundled = ""): CliTarget {
  if (override.trim()) return splitPython(override.trim(), env);
  const bin = env.DISPATCH_BIN || "";
  if (bin && exists(bin)) return splitPython(bin, env);
  const cli = env.DISPATCH_CLI || "";
  if (cli && exists(cli)) return { cmd: env.DISPATCH_PYTHON || "python3", pre: [cli] };
  // where the CLI lives when the extension host has a bare PATH (the Dock, a shell environment that timed
  // out): look in the usual places; none there is still ~/.local/bin/dispatch, so the failure names that
  // path instead of an unfindable bare "dispatch"
  const local = home + "/.local/bin/dispatch";
  for (const p of [local, "/opt/homebrew/bin/dispatch", "/usr/local/bin/dispatch"]) {
    if (exists(p)) return { cmd: p, pre: [] };
  }
  if (bundled && exists(bundled)) return { cmd: env.DISPATCH_PYTHON || "python3", pre: [bundled] };
  return { cmd: local, pre: [] };
}

/** The folders a bare PATH lacks and the CLI needs (its python3 shebang, bd, the agents it starts). */
export function cliPathDirs(home: string): string[] {
  return [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];
}

function splitPython(p: string, env: CliEnv): CliTarget {
  // a .py path runs through Python: execFile of a script relies on its shebang and the x bit
  if (/\.py$/i.test(p)) return { cmd: env.DISPATCH_PYTHON || "python3", pre: [p] };
  return { cmd: p, pre: [] };
}

/**
 * The environment for CLI calls: the host's, minus the code-server password. `ideBin` is Dispatch IDE's
 * Resources/app/tools (bd and dolt ship there); the CLI looks there first (DISPATCH_IDE_BIN). With `home`,
 * the usual tool folders go on PATH (appended, so a resolved shell PATH keeps its order).
 */
export function cliEnv(env: CliEnv, ideBin = "", home = ""): CliEnv {
  const out: CliEnv = { ...env };
  delete out.PASSWORD;
  delete out.HASHED_PASSWORD;
  out.DISPATCH_CALLER = "ide-bridge";
  if (ideBin) out.DISPATCH_IDE_BIN = ideBin;
  if (home) {
    const parts = (out.PATH || "/usr/bin:/bin").split(":").filter(Boolean);
    for (const d of cliPathDirs(home)) if (!parts.includes(d)) parts.push(d);
    out.PATH = parts.join(":");
  }
  return out;
}

/**
 * The JSON answer in a CLI's stdout: the last line that parses (install / progress commands print
 * several lines; the answer is the last one). Undefined when nothing parses.
 */
export function lastJson(stdout: string): unknown {
  // one document (possibly pretty-printed) first; else the last line that parses
  const whole = stdout.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    try {
      return JSON.parse(whole);
    } catch {
      /* several lines */
    }
  }
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!(l.startsWith("{") || l.startsWith("["))) continue;
    try {
      return JSON.parse(l);
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** The error message in a `{ok: false, message}` answer, or undefined when the answer is fine. */
export function answerError(ans: unknown): { code: string; message: string } | undefined {
  if (!ans || typeof ans !== "object" || Array.isArray(ans)) return undefined;
  const a = ans as { ok?: unknown; error?: unknown; message?: unknown; unsupported?: unknown };
  if (a.ok === false) {
    const code = typeof a.error === "string" ? a.error : a.unsupported ? "unsupported" : "failed";
    const message = typeof a.message === "string" && a.message ? a.message : code;
    return { code, message };
  }
  return undefined;
}
