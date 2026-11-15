// dispatch.turbo: the Timeline page and the Turbo switch on a new chat's page (Dispatch IDE
// patches/420-turbo.patch) read and drive `dispatch turbo` through here.
import * as vscode from "vscode";
import { log, runAnswer } from "./cli";
import { turboArgs } from "./core/turbo";

export function registerTurbo(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.turbo", async (op?: unknown, ...a: unknown[]) => {
      const args = turboArgs(op, ...a);
      if (!args) throw new Error(`dispatch.turbo: bad request ${String(op)}`);
      try {
        return await runAnswer(args, { timeoutMs: op === "plan" || op === "replan" || op === "start" ? 120000 : 60000 });
      } catch (e) {
        log(`dispatch turbo ${String(op)}: ${(e as Error).message}`);
        return { ok: false, error: "unavailable", message: vscode.l10n.t("Dispatch could not reach Turbo just now.") };
      }
    }),
  );
}
