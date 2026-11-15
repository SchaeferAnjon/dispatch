// dispatch.onboarding: the setup wizard's and Migrations' way into the dispatch CLI (`dispatch onboard`), and
// the one thing the CLI cannot do, installing extensions into the running app (VS Code import).
// Dispatch IDE patches/505-onboarding.patch.
import { spawn } from "child_process";
import * as vscode from "vscode";
import { log, macToolsHere, runAnswer, runJson } from "./cli";
import { draftInput, extensionIds, onboardingArgs, registerInput, vscodeApplyInput } from "./core/onboarding";

interface ILogEntry { readonly kind?: string; readonly data?: { readonly extensions?: readonly string[] } }

async function installExtensions(ids: readonly string[]): Promise<{ installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const result = await vscode.commands.executeCommand<{ installed: string[]; failed: string[] }>("dispatch.onboarding.extensions", "install", [id]);
      installed.push(...result.installed);
      failed.push(...result.failed);
      if (result.installed.length) {
        await runAnswer(["onboard", "vscode-extensions", "--json"], { input: JSON.stringify({ ids: result.installed }), timeoutMs: 30000 });
      }
    } catch (e) {
      log(`onboarding: could not install ${id}: ${(e as Error).message}`);
      failed.push(id);
    }
  }
  return { installed, failed };
}

export function registerOnboarding(ctx: vscode.ExtensionContext) {
  const inFlight = new Map<string, Promise<unknown>>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.onboarding", async (op?: unknown, arg?: unknown, extra?: unknown) => {
      if (op === "tools") {
        return { ok: macToolsHere() };
      }
      if (op === "tools-install") {
        // macOS's own installer: it asks once more (Install, then Agree) and downloads them. Its question opens behind
        // this window (the click that asked for it was here), so the installer is brought forward once it is up
        log("onboarding: xcode-select --install");
        spawn("/usr/bin/xcode-select", ["--install"], { detached: true, stdio: "ignore" }).unref();
        await new Promise((r) => setTimeout(r, 1500));
        spawn("/usr/bin/open", ["-a", "/System/Library/CoreServices/Install Command Line Developer Tools.app"], { detached: true, stdio: "ignore" }).unref();
        return { ok: true };
      }
      if (op === "install-extensions") {
        const ids = extensionIds(arg);
        const result = await installExtensions(ids);
        return { ok: result.failed.length === 0, ...result, message: result.failed.length ? `Could not install: ${result.failed.join(", ")}. Retry setup.` : "" };
      }
      if (op === "undo") {
        // extensions come out of the running app, then the CLI puts the rest back
        const id = typeof arg === "string" ? arg : "";
        const entry = (await runJson<{ entry?: ILogEntry }>(["onboard", "log-entry", id, "--json"], { timeoutMs: 20000 })).entry;
        if (entry?.kind === "vscode") {
          const result = await vscode.commands.executeCommand<{ failed: string[] }>("dispatch.onboarding.extensions", "uninstall", entry.data?.extensions ?? []);
          if (result.failed.length) throw new Error(`Could not uninstall: ${result.failed.join(", ")}. Retry Undo.`);
        }
      }
      if (op === "agents-use") {
        // which agents the person uses: the engines command keeps it (dispatch engines use)
        return vscode.commands.executeCommand("dispatch.engines", "use", undefined, arg);
      }
      const args = onboardingArgs(op, arg, extra);
      if (!args) throw new Error(`dispatch.onboarding: bad request ${String(op)}`);
      const input = op === "register" ? registerInput(arg) : op === "vscode-apply" ? vscodeApplyInput(arg) : op === "draft" ? draftInput(arg) : undefined;
      if ((op === "register" || op === "vscode-apply" || op === "draft") && input === undefined) throw new Error(`dispatch.onboarding: bad ${String(op)} body`);
      const slow = op === "status" || op === "vscode" || op === "apply-dir" || op === "apply-command" || op === "apply-skills" || op === "apply-rules" || op === "register" || op === "folders" || op === "prefs";
      const opts = { timeoutMs: slow ? 180000 : 30000, input };
      if (op === "status" || op === "scan-status" || op === "log" || op === "available") {
        const key = args.join("\u0000");
        // `status` with "fresh" is asked again even when one is on its way: that one started before the change
        // the caller just made (a sign-in, an install) and would answer with the old state
        let p = op === "status" && arg === "fresh" ? undefined : inFlight.get(key);
        if (!p) {
          const mine = runJson(args, opts).finally(() => { if (inFlight.get(key) === mine) inFlight.delete(key); });
          p = mine;
          inFlight.set(key, mine);
        }
        return p;
      }
      log(`onboarding ${args.slice(1, 3).join(" ")}`);
      return runAnswer(args, opts);
    }),
  );
}
