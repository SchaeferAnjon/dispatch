// dispatch.assistant: the first suggestions on a new chat's page (Dispatch IDE dispatchFirstPrompts.ts) read
// `dispatch assistant` through here: the suggestions and whether the Assistant was ever talked to.
import * as vscode from "vscode";
import { answerCache, assistantArgs, retryTimeout } from "./core/assistant";
import { shared } from "./shared";

export function registerAssistant(ctx: vscode.ExtensionContext) {
  const ask = shared();
  // the status: asked at every start, hover and click, on a Mac that may be running a dozen builds. The last answer is
  // given at once inside 15 s; an older one waits up to 3 s for the new one before it is given; and a run that timed out
  // is run once more before anyone hears about it
  const status = answerCache(
    () => retryTimeout(() => ask(assistantArgs("status")!, 30000)),
    { freshMs: 15000, waitMs: 3000 },
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.assistant", async (op?: unknown, arg?: unknown) => {
      const args = assistantArgs(op, arg);
      if (!args) throw new Error(`dispatch.assistant: bad request ${String(op)}`);
      return status();
    }),
  );
}
