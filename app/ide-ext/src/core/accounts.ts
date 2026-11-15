// dispatch.accounts: the pure part. The title bar's usage strip and Accounts panel (Dispatch IDE
// patches/290-accounts.patch) ask the bridge for usage, switch accounts and sign in to another one; only
// these argument shapes reach `dispatch accounts`.

const ENGINES = new Set(["claude", "codex"]);
// an account id (claude-1a2b3c4d), an email or a label; a session id (a uuid, a Codex thread id)
const TARGET = /^[^\s"'`$\;|&<>]{1,120}$/;

function engine(v: unknown): string | undefined {
  return typeof v === "string" && ENGINES.has(v) ? v : undefined;
}

function target(v: unknown): string | undefined {
  return typeof v === "string" && TARGET.test(v.trim()) ? v.trim() : undefined;
}

/** The CLI call for one operation, or undefined for a request that is not one. `add` is not here: it runs in a
 *  terminal (the person signs in there), see accountsAddArgs. */
export function accountsArgs(op: unknown, ...a: unknown[]): string[] | undefined {
  switch (op) {
    case undefined:
    case "watch":
      return ["accounts", "watch", "--json"];
    case "status":
      return ["accounts", "status", "--json"];
    case "list":
      return ["accounts", "list", "--json"];
    case "use":
    case "remove": {
      const e = engine(a[0]);
      const t = target(a[1]);
      return e && t ? ["accounts", op, e, t, "--json"] : undefined;
    }
    case "continue": {
      const e = engine(a[0]);
      const s = target(a[1]);
      const to = a[2] === undefined || a[2] === "" ? "" : target(a[2]);
      if (!e || !s || to === undefined) return undefined;
      return ["accounts", "continue", e, s, ...(to ? ["--to", to] : []), "--json"];
    }
    default:
      return undefined;
  }
}

/** `dispatch accounts add <engine>` for the sign-in terminal; --use when there is nothing to keep in use. */
export function accountsAddArgs(e: unknown, use?: unknown): string[] | undefined {
  const x = engine(e);
  return x ? ["accounts", "add", x, ...(use === true ? ["--use"] : [])] : undefined;
}

/** How long each operation may take: `list` asks every saved account's usage over the network. */
export function accountsTimeout(op: unknown): number {
  return op === "list" ? 60000 : op === "continue" ? 120000 : 30000;
}
