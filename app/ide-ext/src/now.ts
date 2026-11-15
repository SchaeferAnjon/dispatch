// dispatch.now: the Now tab of the Agents window's side pane (Dispatch IDE patches/410-now.patch)
// reads `dispatch now --session <id> --json` through here.
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { nowArgs, NowRequest } from "./core/now";

export function registerNow(ctx: vscode.ExtensionContext) {
  const inFlight = new Map<string, Promise<unknown>>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.now", async (req?: NowRequest) => {
      const args = nowArgs(req);
      if (!args) return { error: "bad request" };
      const key = args.join("\0");
      let p = inFlight.get(key);
      if (!p) {
        p = runJson(args, { timeoutMs: 30000 }).finally(() => inFlight.delete(key));
        inFlight.set(key, p);
      }
      try {
        return await p;
      } catch (e) {
        log(`now: ${(e as Error).message}`);
        return { error: (e as Error).message };
      }
    }),
  );
}
