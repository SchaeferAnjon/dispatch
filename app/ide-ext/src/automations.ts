// dispatch.automations: the Automations page's "Set up in other apps" (Dispatch IDE
// patches/455-automations.patch) reads `dispatch automations discover` through here. Read-only.
import * as vscode from "vscode";
import { automationsArgs } from "./core/automations";
import { shared } from "./shared";

export function registerAutomations(ctx: vscode.ExtensionContext) {
  const ask = shared();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.automations", async (op?: unknown) => {
      const args = automationsArgs(op);
      if (!args) throw new Error(`dispatch.automations: bad request ${String(op)}`);
      // the other Macs: one ssh each, in parallel, ConnectTimeout 4 s and at most 15 s per Mac
      return ask(args, op === "here" || op === undefined ? 30000 : 45000);
    }),
  );
}
