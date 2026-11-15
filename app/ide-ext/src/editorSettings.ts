// dispatch.editorSettings: Tab completion and ⌘K settings, read and saved through the CLI.
//   get / save   the editor window's Settings (Dispatch IDE patches/530-editor-settings.patch,
//                "Tab Completion and ⌘K") shows and changes them; a save here reaches this window's completions at once
//   showInEditor the Agents window's "Editor window settings": leaves ide/settings-request, which the first editor
//                window to see it takes (watchSettingsRequests) and opens its Settings on them
import * as fs from "fs";
import * as vscode from "vscode";
import { idePath, log, runJson } from "./cli";
import { editorCall, EDITOR_SETTINGS_QUERY, settingsRequest, takeSettingsRequest } from "./core/editorSettings";

export function registerEditorSettings(ctx: vscode.ExtensionContext, onSaved?: () => void) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.editorSettings", async (op: unknown, payload: unknown) => {
      if (op === "showInEditor") {
        try {
          fs.mkdirSync(idePath(""), { recursive: true });
          fs.writeFileSync(idePath("settings-request"), JSON.stringify(settingsRequest(Date.now() / 1000)));
          return { ok: true };
        } catch (e) {
          log(`editorSettings showInEditor: ${(e as Error).message}`);
          return { ok: false, error: (e as Error).message };
        }
      }
      try {
        const call = editorCall(String(op ?? ""), payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
        const answer = await runJson(call.args, { input: call.input, timeoutMs: 60000 });
        if (op === "get") return { ok: true, result: answer };
        onSaved?.();
        // a save answers with the setting saved; the page wants every one back
        return { ok: true, result: await runJson(editorCall("get").args, { timeoutMs: 30000 }) };
      } catch (e) {
        log(`editorSettings ${String(op)}: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
}

/** In an editor window: the Agents window asked for Tab completion and ⌘K; the first window to rename the file away takes it. */
export function watchSettingsRequests(ctx: vscode.ExtensionContext) {
  const file = idePath("settings-request");
  const check = () => {
    const rec = takeSettingsRequest(file, process.pid, Date.now() / 1000, fs);
    if (!rec) return;
    log("settings-request");
    const query = rec.query || EDITOR_SETTINGS_QUERY;
    // the IDE's own command waits for Dispatch's values first, so the Settings editor does not search again under the
    // person's cursor; an IDE without it opens Settings directly
    void vscode.commands
      .executeCommand("dispatch.editorSettings.open", query)
      .then(undefined, () => vscode.commands.executeCommand("workbench.action.openSettings", query))
      .then(undefined, (e: Error) => log(`settings-request: ${e.message}`));
  };
  fs.watchFile(file, { interval: 500 }, check);
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file, check) });
  check(); // a request written before this window was up
}
