// dispatch.busy: the pure part. The Agents window's bottom bar (Dispatch IDE patches/120-status-bar.patch)
// shows "Busy" only when this Mac is too busy, and its panel's Let idle agents sleep; only these shapes reach the CLI.

/** The CLI call for one request, or undefined for a request that is not one. */
export function busyArgs(op: unknown): string[] | undefined {
  switch (op) {
    case undefined:
    case "status":
      return ["busy", "--json"];
    case "sleep":
      return ["sleep", "now", "--json"];
    default:
      return undefined;
  }
}
