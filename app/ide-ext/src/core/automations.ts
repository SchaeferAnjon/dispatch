// dispatch.automations: the pure part. The Automations page (Dispatch IDE patches/455-automations.patch)
// lists the scheduled jobs other tools set up (Hermes, OpenClaw, Codex, Claude, launchd, cron); only these
// argument shapes reach the CLI, and every one of them only reads.

/** `dispatch automations discover`: this Mac (`here`), the other Macs (`others`, `fresh` asks them now). */
export function automationsArgs(op: unknown): string[] | undefined {
  switch (op) {
    case undefined:
    case "here":
      return ["automations", "discover", "--json"];
    case "others":
      return ["automations", "discover", "--remote", "--json"];
    case "fresh":
      return ["automations", "discover", "--remote", "--fresh", "--json"];
    default:
      return undefined;
  }
}
