// dispatch.usage: the pure part. The Agents window's Usage page (Dispatch IDE patches/460-usage.patch) asks
// the bridge for `dispatch usage`; only these argument shapes reach the CLI.

/** `dispatch usage`: the page (`page`, optionally with the heatmap's day count) or one quota reading (`record`). */
export function usageArgs(op: unknown, days?: unknown): string[] | undefined {
  switch (op) {
    case undefined:
    case "page": {
      if (days === undefined) return ["usage", "--json"];
      const n = typeof days === "number" ? days : Number.NaN;
      return Number.isInteger(n) && n >= 7 && n <= 1098 ? ["usage", "--days", String(n), "--json"] : undefined;
    }
    case "record":
      return ["usage", "--record", "--json"];
    default:
      return undefined;
  }
}
