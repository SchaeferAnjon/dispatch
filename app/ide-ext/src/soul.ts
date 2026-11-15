// dispatch.soul: Settings › Soul (Dispatch IDE contrib/dispatchSettings/browser/dispatchSettingsSoul.ts) reads and
// changes the Soul every agent gets (app/cli/soul.py); the CLI syncs it into Claude Code, Codex and OpenCode.
import * as vscode from "vscode";
import { log, runAnswer } from "./cli";
import { soulRequest } from "./core/soul";

export function registerSoul(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.soul", async (op?: unknown, text?: unknown) => {
      const req = soulRequest(op, text);
      if (!req) throw new Error(`dispatch.soul: bad request ${String(op)}`);
      if (op !== undefined && op !== "show") log(`soul ${String(op)}`);
      return runAnswer(req.args, { input: req.input, timeoutMs: 60000 });
    }),
  );
}
