// dispatch.slash: the grey rows of the Agents window's slash menu (Dispatch IDE, dispatchSlashMenu.ts).
// A command the session's engine does not have here, but another engine or the engine's own terminal
// does, gets a row saying why and where; the table is `dispatch slash --engine <id> --json` (cli/slash.py).
// It does not change while the app runs, so each engine's table is read once.
import * as vscode from "vscode";
import { runJson } from "./cli";
import { parseSlashTable, slashArgs, type SlashTable } from "./core/slash";

export function registerSlash(ctx: vscode.ExtensionContext) {
  const tables = new Map<string, Promise<SlashTable | undefined>>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.slash", (engine?: unknown) => {
      const args = slashArgs(engine);
      if (!args) return undefined;
      const key = args[2];
      let p = tables.get(key);
      if (!p) {
        p = runJson(args, { timeoutMs: 20000 }).then(parseSlashTable, () => {
          tables.delete(key); // try again next time the menu opens
          return undefined;
        });
        tables.set(key, p);
      }
      return p;
    }),
  );
}
