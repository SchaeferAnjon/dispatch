// dispatch.accounts: the title bar's usage strip and Accounts panel (Dispatch IDE patches/290-accounts.patch).
//   watch                                 usage of the accounts in use, and sessions that stopped on a limit since
//                                         the last ask (each one once)
//   list                                  every saved account with its usage
//   use <engine> <account>                switch in one step
//   continue <engine> <session> [<account>]  switch, and let a session Dispatch holds go on
//   remove <engine> <account>             forget a saved account (its sign-in too)
//   add <engine> [use]                    sign in to another account in a terminal; answers once the terminal ends
// Every answer is the CLI's JSON, `{ok: false, message}` included: the panel shows the message as is.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log, runAnswer, commandLocation } from "./cli";
import { accountsAddArgs, accountsArgs, accountsTimeout } from "./core/accounts";
import { cliEnv, cliTarget } from "./core/cliOutput";

const ADD_TIMEOUT_MS = 15 * 60 * 1000;

/** The sign-in runs where the person can see it: the engine's own login prints a link and waits for the browser. */
async function add(engine: unknown, use: unknown): Promise<unknown> {
  const args = accountsAddArgs(engine, use);
  if (!args) throw new Error(`dispatch.accounts: bad engine ${String(engine)}`);
  const override = commandLocation();
  const bundled = path.join(vscode.env.appRoot, "dispatch-cli", "dispatch", "cli", "dispatch.py");
  const t = cliTarget(process.env, os.homedir(), (p) => fs.existsSync(p), override, bundled);
  const name = engine === "codex" ? vscode.l10n.t("Add a Codex account") : vscode.l10n.t("Add a Claude account");
  const term = vscode.window.createTerminal({
    name,
    shellPath: t.cmd,
    shellArgs: [...t.pre, ...args],
    env: cliEnv(process.env, "", os.homedir()) as { [key: string]: string },
    isTransient: true,
  });
  term.show();
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (code: number | undefined, closed: boolean) => {
      clearInterval(timer);
      sub.dispose();
      // a finished sign-in leaves nothing to read in the terminal: close it; a failed one stays open to be read
      if (!closed && code === 0) term.dispose();
      resolve({ ok: code === 0, exitCode: code ?? null });
    };
    const sub = vscode.window.onDidCloseTerminal((x) => {
      if (x === term) finish(x.exitStatus?.code, true);
    });
    const timer = setInterval(() => {
      if (term.exitStatus) finish(term.exitStatus.code, false);
      else if (Date.now() - started > ADD_TIMEOUT_MS) finish(undefined, false);
    }, 1000);
  });
}

export function registerAccounts(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.accounts", async (op?: unknown, ...a: unknown[]) => {
      if (op === "add") return add(a[0], a[1]);
      const args = accountsArgs(op, ...a);
      if (!args) throw new Error(`dispatch.accounts: bad request ${String(op)}`);
      try {
        return await runAnswer(args, { timeoutMs: accountsTimeout(op) });
      } catch (e) {
        log(`dispatch accounts ${String(op)}: ${(e as Error).message}`);
        return { ok: false, error: "unavailable", message: vscode.l10n.t("Dispatch could not read your accounts just now.") };
      }
    }),
  );
}
