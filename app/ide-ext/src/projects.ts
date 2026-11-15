// dispatch.projects (design/task-model/DECISIONS.md「项目」): the Agents window groups its sessions by
// the registered projects (`dispatch projects --json`), and its Projects page and project pages
// (Dispatch IDE patches/sessions-projects.patch) read `dispatch projects-view --json` through here.
// Add as project / New Project / opening another Mac's session go back the same way.
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { log, run, runAnswer, runJson } from "./cli";
import { lastJson } from "./core/cliOutput";
import { cloneProgressFile, createArgs, projectsArgs } from "./core/projects";
import { openRemoteSession } from "./machines";
import { sharedRuns } from "./core/board";

export function registerProjects(ctx: vscode.ExtensionContext) {
  const sharedRead = sharedRuns();
  // copies running now, by the id the window gave them: what stops them, and where their progress is written
  const copies = new Map<string, vscode.CancellationTokenSource>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.projects", async (op?: unknown, arg?: unknown, extra?: unknown) => {
      // Add project: a new project by name, a copy from a web address (the dialog polls its progress and can stop it)
      if (op === "defaults" || op === "create" || op === "clone") {
        const args = createArgs(op, arg, os.tmpdir());
        if (!args) return { ok: false, message: "Dispatch could not read that request. Check the name or the web address and try again." };
        if (op === "defaults") return runAnswer(args, { timeoutMs: 20000 });
        const id = op === "clone" ? String((arg as { progressId?: string }).progressId) : "";
        const file = cloneProgressFile(os.tmpdir(), id);
        const stop = new vscode.CancellationTokenSource();
        if (op === "clone") copies.set(id, stop);
        log(`projects ${op} ${op === "clone" ? args[2] : args[2].slice(0, 40)}`);
        try {
          const r = await run(args, { timeoutMs: 30 * 60 * 1000, token: stop.token });
          return lastJson(r.stdout) ?? { ok: false, message: (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] || "Dispatch did not answer. Try again." };
        } catch (e) {
          return { ok: false, message: stop.token.isCancellationRequested ? "The copy was stopped." : (e as Error).message, code: stop.token.isCancellationRequested ? "cancelled" : undefined };
        } finally {
          copies.delete(id);
          stop.dispose();
          if (file) fs.rm(file, { force: true }, () => undefined);
        }
      }
      if (op === "cloneProgress") {
        const file = cloneProgressFile(os.tmpdir(), arg);
        try {
          return file ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
        } catch {
          return { state: "running", phase: "Connecting", percent: 0, detail: "" };
        }
      }
      if (op === "cloneCancel") {
        copies.get(String(arg))?.cancel();
        return;
      }
      const args = projectsArgs(op, arg, extra);
      if (!args) throw new Error(`dispatch.projects: bad request ${String(op)}`);
      // another Mac's session: a window connected to that Mac on the session's folder (Open Remote - SSH),
      // not an ssh session in Terminal
      if (op === "open") return openRemoteSession(arg, extra);
      if (op === undefined || op === "registry" || op === "sidebar" || op === "page" || op === "project" || op === "host" || op === "custom") {
        // reads are polled: one per shape at a time, a second caller shares the running one (not across a board change)
        return sharedRead(args.join("\u0000"), () => runJson(args, { timeoutMs: 45000 }));
      }
      log(`projects ${args.slice(0, 3).join(" ")}`);
      // a rename moves every task of the project, in batches through the board's one writer: give it time
      return runAnswer(args, { timeoutMs: op === "renameKey" ? 600000 : 60000 });
    }),
  );
}
