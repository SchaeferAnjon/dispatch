// dispatch.firstRun: the pure part. The first-run wizard and Customizations (Dispatch IDE patches/505-onboarding.patch)
// ask the bridge for how much agents may do on their own, keeping the Mac awake, and notifications on this Mac.
// Only these argument shapes reach the dispatch CLI.

export const AUTONOMY_LEVELS = ["ask-every", "ask-risky", "auto"] as const;

/** The `dispatch` argv for an op, or undefined when the op or its argument is not one the window can send. */
export function firstRunArgs(op: unknown, arg?: unknown): string[] | undefined {
  const r = (arg ?? {}) as Record<string, unknown>;
  switch (op) {
    case "autonomy":
      return ["autonomy", "--json"];
    case "autonomy-set":
      return typeof r.level === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(r.level) ? ["autonomy", "set", r.level, "--json"] : undefined;
    case "state":
      return ["settings", "--json"];
    case "awake":
      return ["awake", "--json"];
    case "awake-set":
      return typeof r.on === "boolean" ? ["settings", "keep_awake", r.on ? "1" : "0", "--json"] : undefined;
    case "notify-set":
      return typeof r.on === "boolean" ? ["settings", "notify_desktop", r.on ? "1" : "0", "--json"] : undefined;
    case "git-identity":
      // the name and email on commits: what git has and what to offer (task-pog4t)
      return ["git-identity", "show", "--json"];
    case "git-identity-set": {
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const email = typeof r.email === "string" ? r.email.trim() : "";
      const fine = (x: string, max: number) => x.length > 0 && x.length <= max && !x.startsWith("-") && !/[\u0000\n\r<>]/.test(x);
      return fine(name, 100) && fine(email, 200) && email.includes("@")
        ? ["git-identity", "set", "--name", name, "--email", email, "--json"] : undefined;
    }
    case "notify-test":
      return ["first-run", "notify-test", "--json"];
    case "notify-open":
      return ["first-run", "notify-settings", "--json"];
    default:
      return undefined;
  }
}
