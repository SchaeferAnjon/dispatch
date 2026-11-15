// dispatch.capture: what the person asks for in a chat goes on the board by itself and lines up (Dispatch IDE
// patches/dispatch-capture.patch, app/cli/capture.py). The window sends each message it sends to `dispatch capture
// note`, reads the receipts for the line under a message, and the panel's buttons and Pause come through here too.
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { captureArgs } from "./core/capture";
import { shared } from "./shared";

export function registerCapture(ctx: vscode.ExtensionContext) {
  const read = shared();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.capture", async (op?: unknown, arg?: unknown) => {
      const run = captureArgs(op, arg);
      if (!run) throw new Error(`dispatch.capture: bad request ${String(op)}`);
      try {
        if (op === "list" || op === "nextup") return await read(run.args, 30000);
        // reading a message asks a model (a few seconds, more on a busy Mac)
        return await runJson(run.args, { input: run.input, timeoutMs: op === "note" ? 90000 : 60000 });
      } catch (e) {
        log(`capture ${String(op)}: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
}
