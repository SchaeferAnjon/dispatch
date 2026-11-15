// A CLI read that several callers poll: one run per argv at a time, a second caller shares the running one.
import { runJson } from "./cli";
import { sharedRuns } from "./core/board";

/** One call per argv at a time: a second caller shares the running one (not across a board change). */
export function shared() {
  const run = sharedRuns();
  return (args: string[], timeoutMs: number) => run(args.join("\u0000"), () => runJson(args, { timeoutMs }));
}
