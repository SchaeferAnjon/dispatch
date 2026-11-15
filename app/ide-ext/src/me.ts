// dispatch.me: who uses this Mac, for the picture at the top right of the Agents window's title bar
// (Dispatch IDE patches/110-title-bar.patch): `dispatch me --json` → { github, name, avatar }.
import * as vscode from "vscode";
import { log, runAnswer } from "./cli";

export function registerMe(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.me", async () => {
      try {
        return await runAnswer(["me", "--json"], { timeoutMs: 15000 });
      } catch (e) {
        log(`dispatch me: ${(e as Error).message}`);
        return { github: "", name: "", avatar: "" };
      }
    }),
  );
}
