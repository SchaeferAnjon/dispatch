// OpenCode, the third engine of the Agents window: its page in Customizations, the account panel's
// OpenCode section and the editor's Accounts menu (Dispatch IDE patches/220-opencode.patch,
// 220-opencode.patch) ask here. What OpenCode has comes from `dispatch engines status opencode`
// (app/cli/opencode_engine.py: providers and where each key comes from, never a key; the default model;
// the allowance DeepSeek and Zhipu report; Dispatch's plugin). Adding a provider is OpenCode's own
// `opencode auth login` in a terminal: the key goes from the person to OpenCode, not through Dispatch.
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { log, runAnswer, runJson } from "./cli";
import { authLoginTerminal, OPENCODE_INSTALL_PLUGIN_ARGS, opencodeBinary, opencodeStatusArgs } from "./core/opencode";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

type Status = { installed?: boolean; path?: string };

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function status(refresh?: unknown): Promise<unknown> {
  return runJson(opencodeStatusArgs(refresh), { timeoutMs: 30000 });
}

/** `opencode auth login` in a terminal; resolves when the terminal closes (the login is done or given
 *  up), or after ten minutes. */
async function addProvider(): Promise<boolean> {
  let path: string | undefined;
  try {
    path = ((await status()) as Status).path;
  } catch (e) {
    log(`opencode status: ${(e as Error).message}`);
  }
  const term = vscode.window.createTerminal({
    name: "OpenCode",
    ...authLoginTerminal(opencodeBinary(path, os.homedir(), exists), process.platform),
    isTransient: true,
  });
  term.show();
  log("opencode auth login");
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), LOGIN_TIMEOUT_MS);
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === term) done(true);
    });
    function done(closed: boolean) {
      clearTimeout(timer);
      sub.dispose();
      resolve(closed);
    }
  });
}

export function registerOpenCode(ctx: vscode.ExtensionContext) {
  let installing: Promise<unknown> | undefined;
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.opencodeStatus", (refresh?: unknown) => status(refresh)),
    vscode.commands.registerCommand("dispatch.opencodeAddProvider", () => addProvider()),
    vscode.commands.registerCommand("dispatch.opencodeInstallPlugin", () => {
      // one at a time: a second click waits for the running one
      installing ??= runAnswer(OPENCODE_INSTALL_PLUGIN_ARGS, { timeoutMs: 30000 }).finally(() => (installing = undefined));
      return installing;
    }),
  );
}
