// dispatch.builds: the pure part. The Agents window's bottom bar (Dispatch IDE
// patches/120-status-bar.patch) shows the build queue as a row of blocks; only these argument
// shapes reach `dispatch build`.

// a build's name: <sha12>[-min][-dev], or the older <ide sha12>-<kanban sha12>[-min]
const NAME = /^[0-9a-f]{7,40}(-[0-9a-f]{7,40})?(-min)?(-dev)?$/;
// what "Try again" builds: one commit's full package, the same kind it was
const RETRY = /^([0-9a-f]{12})(-min)?$/;

function name(v: unknown): string | undefined {
  return typeof v === "string" && NAME.test(v.trim()) ? v.trim() : undefined;
}

/** The CLI call for one bottom bar operation, or undefined for a request that is not one. */
export function buildsArgs(op: unknown, ...a: unknown[]): string[] | undefined {
  switch (op) {
    case undefined:
    case "queue":
      return ["build", "queue", "--json"];
    case "log": {
      const n = name(a[0]);
      return n ? ["build", "log", n, "--follow"] : undefined;
    }
    case "retry": {
      // the same commit again, from scratch (a failed build of yours, task-7ve7v)
      const m = typeof a[0] === "string" ? RETRY.exec(a[0].trim()) : null;
      return m ? ["build", "start", m[1], "--rebuild", ...(m[2] ? ["--min"] : [])] : undefined;
    }
    default:
      return undefined;
  }
}
