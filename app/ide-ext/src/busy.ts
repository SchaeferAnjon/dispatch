// dispatch.busy: is this Mac too busy (`dispatch busy --json`), and Let idle agents sleep (`dispatch sleep now`),
// for the Agents window's bottom bar (Dispatch IDE patches/120-status-bar.patch).
import * as vscode from "vscode";
import { log, runAnswer } from "./cli";
import { busyArgs } from "./core/busy";

export function registerBusy(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.busy", async (op?: unknown) => {
      const args = busyArgs(op);
      if (!args) throw new Error(`dispatch.busy: bad request ${String(op)}`);
      try {
        return await runAnswer(args, { timeoutMs: 30000 });
      } catch (e) {
        log(`dispatch ${args.join(" ")}: ${(e as Error).message}`);
        return { ok: false, error: "unavailable" };
      }
    }),
  );
}
