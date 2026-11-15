// dispatch.engines: the Version row on the Agents window's Claude and Codex pages in Customizations
// (Dispatch IDE patches/515-customizations.patch) reads `dispatch engines --json` here,
// and its Update button runs `dispatch engines upgrade <id>` (npm, bun, Homebrew or the engine's own
// updater, whichever installed it). `check` is the quick read (installed versions, no npm) that the OpenCode
// version notice above the input uses (patches/225-opencode-version.patch). `detect`, `enabled` and `use` are the
// list of every agent CLI on this Mac and which ones the person uses (patches/agents-choice.patch).
import * as vscode from "vscode";
import { log, runAnswer, runJson } from "./cli";
import { enginesArgs } from "./core/engines";
import { firstRunArgs } from "./core/firstRun";
import { awakeChanged } from "./settingsPage";

export function registerEngines(ctx: vscode.ExtensionContext) {
  const running = new Map<string, Promise<unknown>>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.engines", async (op?: unknown, id?: unknown, arg?: unknown) => {
      const args = enginesArgs(op, id, arg);
      if (!args) throw new Error(`dispatch.engines: bad request ${String(op)} ${String(id ?? "")}`);
      if (args[1] === "use") return runAnswer(args, { timeoutMs: 20000 });
      if (args[1] === "login") return runAnswer(args, { timeoutMs: 6 * 60000 });
      if (args[1] !== "upgrade") return runJson(args, { timeoutMs: 60000 });
      // one update per engine at a time: a second click waits for the running one
      const engine = args[2];
      let p = running.get(engine);
      if (!p) {
        log(`engines upgrade ${engine}`);
        p = runAnswer(args, { timeoutMs: 15 * 60000 }).finally(() => running.delete(engine));
        running.set(engine, p);
      }
      return p;
    }),
    // first run: how much agents may do on their own, keep awake, notifications on this Mac (patches/505-onboarding.patch)
    vscode.commands.registerCommand("dispatch.firstRun", async (op?: unknown, arg?: unknown) => {
      const args = firstRunArgs(op, arg);
      if (!args) throw new Error(`dispatch.firstRun: bad request ${String(op)}`);
      const answer = await runAnswer(args, { timeoutMs: 90000 });
      if (op === "awake-set") awakeChanged(); // the Settings page's Keep awake shows what was just chosen
      return answer;
    }),
  );
}
