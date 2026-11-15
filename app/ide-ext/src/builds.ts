// dispatch.builds: the build queue in the Agents window's bottom bar (Dispatch IDE
// patches/120-status-bar.patch) and its panel.
//   queue          what builds now, what waits, what failed lately (`dispatch build queue --json`)
//   log <name>     follow one build's log in a terminal
//   retry <name>   build that commit again from scratch, in a terminal (a failed build of yours)
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log, runAnswer, commandLocation } from "./cli";
import { buildsArgs } from "./core/builds";
import { cliEnv, cliTarget } from "./core/cliOutput";

function inTerminal(args: string[], build: string) {
  const override = commandLocation();
  const bundled = path.join(vscode.env.appRoot, "dispatch-cli", "dispatch", "cli", "dispatch.py");
  const t = cliTarget(process.env, os.homedir(), (p) => fs.existsSync(p), override, bundled);
  const term = vscode.window.createTerminal({
    name: vscode.l10n.t("Build {0}", build.slice(0, 7)),
    shellPath: t.cmd,
    shellArgs: [...t.pre, ...args],
    env: cliEnv(process.env, "", os.homedir()) as { [key: string]: string },
    isTransient: true,
  });
  term.show();
  return { ok: true };
}

export function registerBuilds(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.builds", async (op?: unknown, ...a: unknown[]) => {
      const args = buildsArgs(op, ...a);
      if (!args) throw new Error(`dispatch.builds: bad request ${String(op)}`);
      if (op === "log" || op === "retry") return inTerminal(args, String(a[0]));
      try {
        return await runAnswer(args, { timeoutMs: 60000 });
      } catch (e) {
        log(`dispatch build queue: ${(e as Error).message}`);
        return { ok: false, error: "unavailable", message: vscode.l10n.t("Dispatch could not read the builds just now.") };
      }
    }),
  );
}
