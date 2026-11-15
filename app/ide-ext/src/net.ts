// dispatch.net: the network the engines use (app/cli/net.py), for the setup wizard's "from this network" card, the
// notice above a new Claude Code or Codex session when their servers cannot be reached, and Settings > Network
// (Dispatch IDE patches/270-network.patch). The agent host reads `env` itself, without the bridge.
import * as vscode from "vscode";
import { log, runAnswer, runJson } from "./cli";
import { netArgs } from "./core/net";

export function registerNet(ctx: vscode.ExtensionContext) {
  const inFlight = new Map<string, Promise<unknown>>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.net", async (op?: unknown, what?: unknown, value?: unknown) => {
      const args = netArgs(op, what, value);
      if (!args) throw new Error(`dispatch.net: bad request ${String(op)}`);
      if (op === "set") {
        log(`net set ${String(what)}`);
        return runAnswer(args, { timeoutMs: 60000 });
      }
      // the check asks a few servers (up to six seconds each when they do not answer): one of each at a time
      const key = args.join(" ");
      let p = inFlight.get(key);
      if (!p) {
        const mine = runJson(args, { timeoutMs: 60000 }).finally(() => { if (inFlight.get(key) === mine) inFlight.delete(key); });
        inFlight.set(key, mine);
        p = mine;
      }
      return p;
    }),
  );
}
