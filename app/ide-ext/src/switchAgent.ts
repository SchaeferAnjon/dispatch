// dispatch.switchAgent (design/copilot-app §8.5 D, task-3p0t): the Agents window's harness chip on a
// running session. Picking the other harness does not change that session: `dispatch agent switch`
// writes the hand-over (recent rounds verbatim, a summary of the rest), a new session of the picked
// harness starts in the same folder with it as its first message (Dispatch IDE's internal
// `_dispatch.startSession`, patches/250-switch-harness.patch), and the old one goes to Archived.
import * as vscode from "vscode";
import { log, runAnswer, runJson } from "./cli";
import { SwitchAnswer, sessionKey, switchFolder, switchTarget } from "./core/switchAgent";

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function registerSwitchAgent(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.switchAgent", (resource: unknown, sessionTypeId: unknown, windowFolder?: unknown) =>
      switchAgent(String(resource ?? ""), String(sessionTypeId ?? ""), typeof windowFolder === "string" ? windowFolder : undefined),
    ),
  );
}

async function switchAgent(resource: string, sessionTypeId: string, windowFolder?: string): Promise<string | undefined> {
  const key = sessionKey(resource);
  const to = switchTarget(sessionTypeId);
  log(`switchAgent ${resource} (${key ?? "?"}) → ${sessionTypeId}`);
  if (!key || !to) {
    void vscode.window.showWarningMessage(vscode.l10n.t("Only Claude Code, Codex and OpenCode conversations can switch."));
    return undefined;
  }
  const folderOfWindow = windowFolder ? vscode.Uri.parse(windowFolder).fsPath : undefined;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Handing the conversation over to {0}…", NAMES[to]) },
    async () => {
      let ans: SwitchAnswer;
      try {
        ans = await runJson<SwitchAnswer>(["agent", "switch", key, "--to", to, "--json"], { timeoutMs: 120000 });
      } catch (e) {
        void vscode.window.showErrorMessage(vscode.l10n.t("Could not hand the conversation over: {0}", (e as Error).message));
        return undefined;
      }
      const folder = switchFolder(ans, folderOfWindow);
      if (!folder || !ans.first_message) {
        void vscode.window.showErrorMessage(vscode.l10n.t("Could not hand the conversation over: {0}", "no folder or first message"));
        return undefined;
      }
      let started: string;
      try {
        started = await vscode.commands.executeCommand<string>("_dispatch.startSession", {
          folderUri: vscode.Uri.file(folder).toString(),
          sessionTypeId: to,
          prompt: ans.first_message,
          // the session it continues: the new one starts on the model this conversation ran on with that agent
          from: resource,
        });
      } catch (e) {
        void vscode.window.showErrorMessage(vscode.l10n.t("Could not start the {0} session: {1}", NAMES[to], (e as Error).message));
        return undefined;
      }
      log(`switchAgent: started ${started} in ${folder}`);
      // the old conversation goes to Archived (C's `dispatch ide archive-session`); not fatal if it can't
      try {
        const r = await runAnswer<{ ok?: boolean; message?: string }>(["ide", "archive-session", key, "--json"], { timeoutMs: 20000 });
        log(`switchAgent: archive ${key}: ${r.message ?? JSON.stringify(r)}`);
      } catch (e) {
        log(`switchAgent: archive ${key}: ${(e as Error).message}`);
      }
      // archiving the session on screen sends the window to the new-session page: show the new one
      try {
        await vscode.commands.executeCommand("_dispatch.openSession", started);
      } catch (e) {
        log(`switchAgent: open ${started}: ${(e as Error).message}`);
      }
      return started;
    },
  );
}
