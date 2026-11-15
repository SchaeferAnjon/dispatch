// The Agents window's Claude account section (Dispatch IDE patches/290-accounts.patch): it
// reads the user's own `claude` login and signs in / out with `claude` itself. Dispatch never sees the
// credentials: `claude auth login` opens the browser and stores them where Claude Code keeps them.
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { limitWindows, LimitWindow } from "./core/machines";

export type ClaudeState = { loggedIn: boolean; email?: string; subscriptionType?: string; weekly?: { usedPercent: number; resetsAt?: number }; windows?: LimitWindow[] };

const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** The user's installed claude (the extension host's PATH often lacks ~/.local/bin). */
export function claudeBin(): string {
  for (const c of [path.join(os.homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return "claude";
}

/** The environment without CLAUDE_CODE_OAUTH_TOKEN: with it set, `claude auth status` reports the token
 *  (no email, no plan) instead of the account the user signed in with. */
function loginEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

function claude(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(claudeBin(), args, { timeout: timeoutMs, env: loginEnv() }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout))),
  );
}

type QuotaRow = { agent?: string; windows?: { kind?: string; used_percent?: number; resets_at?: number | null }[] };

/** `claude auth status --json`, and the weekly limit from `dispatch quota` (its "weekly" window). */
export async function claudeStatus(): Promise<ClaudeState> {
  let auth: { loggedIn?: boolean; email?: string; subscriptionType?: string };
  try {
    auth = JSON.parse(await claude(["auth", "status", "--json"]));
  } catch (e) {
    log(`claude auth status: ${(e as Error).message}`);
    return { loggedIn: false };
  }
  // only a token in the environment (`claude setup-token`): signed in, without the account's details
  if (!auth.loggedIn) return process.env.CLAUDE_CODE_OAUTH_TOKEN ? { loggedIn: true } : { loggedIn: false };
  const state: ClaudeState = { loggedIn: true, email: auth.email, subscriptionType: auth.subscriptionType };
  try {
    const rows = await runJson<QuotaRow[]>(["quota", "--json", "--local"], { timeoutMs: 15000 });
    const w = rows.find((r) => r.agent === "claude-code")?.windows?.find((x) => x.kind === "weekly");
    if (w && typeof w.used_percent === "number") state.weekly = { usedPercent: w.used_percent, resetsAt: w.resets_at ?? undefined };
    const windows = limitWindows(rows, "claude-code");
    if (windows.length) state.windows = windows;
  } catch (e) {
    log(`quota: ${(e as Error).message}`);
  }
  return state;
}

/** Codex's limit windows as `dispatch quota` reads them from Codex's own logs (the account menu's ChatGPT rows). */
async function codexLimits(): Promise<LimitWindow[]> {
  try {
    return limitWindows(await runJson(["quota", "--json", "--local"], { timeoutMs: 15000 }), "codex");
  } catch (e) {
    log(`quota: ${(e as Error).message}`);
    return [];
  }
}

/** `claude auth login` in a terminal; resolves with the new state once the login is there (the terminal
 *  then closes), or with the old one when the terminal is closed first or after ten minutes. */
async function signIn(): Promise<ClaudeState> {
  const term = vscode.window.createTerminal({
    name: "Claude", shellPath: claudeBin(), shellArgs: ["auth", "login"], isTransient: true,
    env: { CLAUDE_CODE_OAUTH_TOKEN: null }, // sign in to the account, not to the token
  });
  term.show();
  const started = Date.now();
  return new Promise((resolve) => {
    let closed = false;
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === term) closed = true;
    });
    const tick = async () => {
      const state = await claudeStatus();
      if (state.loggedIn || closed || Date.now() - started > LOGIN_TIMEOUT_MS) {
        sub.dispose();
        if (!closed) term.dispose();
        resolve(state);
        return;
      }
      setTimeout(() => void tick(), LOGIN_POLL_MS);
    };
    setTimeout(() => void tick(), LOGIN_POLL_MS);
  });
}

async function signOut(): Promise<ClaudeState> {
  try {
    await claude(["auth", "logout"]);
  } catch (e) {
    log(`claude auth logout: ${(e as Error).message}`);
  }
  return claudeStatus();
}

export function registerClaudeAccount(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.claudeStatus", () => claudeStatus()),
    vscode.commands.registerCommand("dispatch.codexLimits", () => codexLimits()),
    vscode.commands.registerCommand("dispatch.claudeSignIn", () => signIn()),
    vscode.commands.registerCommand("dispatch.claudeSignOut", () => signOut()),
  );
}
