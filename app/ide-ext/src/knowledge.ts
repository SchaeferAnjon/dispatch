// dispatch.knowledge: the Knowledge page in the Agents window's Customizations (Dispatch IDE
// patches/525-knowledge.patch) and the "Remembered" line under a reply
// (patches/335-preferences.patch) run their CLI operations here. The page's webview (media/knowledge,
// built from app/src/knowledge) posts {op, payload} to the window, the window calls this command, the answer
// goes back as {ok, result} or {ok: false, error}.
//
// The preferences file (~/.dispatch/preferences.jsonl, DISPATCH_HOME wins) is watched: when an agent
// remembers, edits or forgets one, the window hears `_dispatch.knowledgeChanged` and an open Knowledge page
// reads the list again.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { knowledgeCall } from "./core/knowledge";

/** Dispatch's own data folder, where preferences.jsonl lives (the CLI's dispatch_dir.root()). */
export function dispatchHome(): string {
  const env = (process.env.DISPATCH_HOME || "").trim();
  return env ? path.resolve(env.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), ".dispatch");
}

function watchPreferences(ctx: vscode.ExtensionContext) {
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // only the Agents window registers it; the editor window has no Knowledge page
      void vscode.commands.executeCommand("_dispatch.knowledgeChanged", { what: "prefs" }).then(undefined, () => undefined);
    }, 250);
  };
  const dir = dispatchHome();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const w = fs.watch(dir, (_event, file) => {
      if (String(file || "") === "preferences.jsonl") changed();
    });
    w.on("error", () => undefined);
    ctx.subscriptions.push({ dispose: () => { w.close(); if (timer) clearTimeout(timer); } });
  } catch (e) {
    log(`knowledge: cannot watch ${dir}: ${(e as Error).message}`);
  }
}

export function registerKnowledge(ctx: vscode.ExtensionContext) {
  watchPreferences(ctx);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.knowledge", async (op: unknown, payload: unknown) => {
      try {
        const call = knowledgeCall(String(op ?? ""), payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
        const result = await runJson(call.args, { input: call.input, timeoutMs: op === "prefsImport" || op === "memoriesList" ? 90000 : 30000 });
        return { ok: true, result };
      } catch (e) {
        log(`knowledge ${String(op)}: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
}
