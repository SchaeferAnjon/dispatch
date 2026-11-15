// dispatch.waiting (design/task-model/DECISIONS.md「Waiting for you」): the Agents window's badge,
// hover card and Waiting for you page (Dispatch IDE patches/425-waiting.patch) read `dispatch
// waiting --json` through here every few seconds; Allow / Deny / Pick / Mark read / Done / Not now,
// their undos (unread / reopen / unsnooze), Reply and "the page was opened" (seen) go back the same way.
import * as vscode from "vscode";
import { log, runAnswer, runJson } from "./cli";
import { waitingArgs } from "./core/waiting";
import { sharedRuns } from "./core/board";

export function registerWaiting(ctx: vscode.ExtensionContext) {
  const run = sharedRuns();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.waiting", async (op?: unknown, id?: unknown, extra?: unknown) => {
      const args = waitingArgs(op, id, extra);
      if (!args) throw new Error(`dispatch.waiting: bad request ${String(op)} ${String(id ?? "")}`);
      if (args[1] === "--json") {
        // the page polls: one list at a time, a second caller shares the running one
        return run("waiting", () => runJson(args, { timeoutMs: 20000 }));
      }
      log(`waiting ${args.slice(0, 3).join(" ")}`);
      return runAnswer(args, { timeoutMs: 60000 });
    }),
  );
}
