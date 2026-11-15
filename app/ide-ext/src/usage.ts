// dispatch.usage: the account menu's Usage page (Dispatch IDE patches/460-usage.patch) reads `dispatch usage`
// through here, and a quota reading is recorded every half hour while the window is open, so the Claude
// limit curve has points (Codex's come from its own logs).
import * as vscode from "vscode";
import { log } from "./cli";
import { usageArgs } from "./core/usage";
import { shared } from "./shared";

const RECORD_MS = 30 * 60 * 1000; // one quota reading every half hour while the window is open

export function registerUsage(ctx: vscode.ExtensionContext) {
  const ask = shared();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.usage", async (op?: unknown, days?: unknown) => {
      const args = usageArgs(op, days);
      if (!args) throw new Error(`dispatch.usage: bad request ${String(op)}`);
      // the first page load reads the Codex rollouts of two weeks once (then cached): give it time
      return ask(args, op === "record" ? 30000 : 180000);
    }),
  );
  // the quota curves need readings over time: record one now and every half hour
  const record = () => void ask(["usage", "--record", "--json"], 30000).then(undefined, (e: Error) => log(`usage record: ${e.message}`));
  const first = setTimeout(record, 20000);
  const timer = setInterval(record, RECORD_MS);
  ctx.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(timer); } });
}
