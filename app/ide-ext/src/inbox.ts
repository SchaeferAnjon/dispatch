// dispatch.inbox (app/cli/inbox.py, sleep.py): the bell in the Agents window's title bar (Dispatch IDE
// patches/470-notifications.patch) polls `dispatch inbox list --json` through here, files what a
// session just did (finished / needs you / stopped), marks rows read or unread again, and asks who is
// asleep (`dispatch sleep --json`); Settings › Notifications and the window's banners read which kinds ring
// and the sound (`dispatch inbox prefs`), and play a sound (`dispatch inbox sound <name>`).
import * as vscode from "vscode";
import { log, runAnswer, runJson } from "./cli";
import { userDataOf } from "./core/history";
import { inboxArgs } from "./core/inbox";

export function registerInbox(ctx: vscode.ExtensionContext) {
  const inFlight = new Map<string, Promise<unknown>>();
  const userData = userDataOf(ctx.globalStorageUri.fsPath);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.inbox", async (op?: unknown, arg?: unknown, extra?: unknown) => {
      const args = inboxArgs(op, arg, extra, userData);
      if (!args) throw new Error(`dispatch.inbox: bad request ${String(op)}`);
      if (op === undefined || op === "list" || op === "sleep" || op === "prefs") {
        // polled: one read at a time per kind, a second caller shares the running one
        const k = String(op ?? "list");
        let p = inFlight.get(k);
        if (!p) {
          p = runJson(args, { timeoutMs: 15000 }).finally(() => inFlight.delete(k));
          inFlight.set(k, p);
        }
        return p;
      }
      if (op !== "add") log(`inbox ${args.slice(0, 3).join(" ")}`);
      return runAnswer(args, { timeoutMs: 20000 });
    }),
  );
}
