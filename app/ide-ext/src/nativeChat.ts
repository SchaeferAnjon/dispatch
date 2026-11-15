// Dispatch IDE only: the editor window's chat is VS Code's own chat view in the secondary side bar, run
// by the same agent host as the Agents window (Claude Code / Codex, the same sessions, pickers and
// Changes). The bridge only points at it: ⌘L focuses it, ⌘⇧L puts a reference into it, and
// `dispatch ide native-open` (ide/chat-request) brings it up on the folder's newest session.
// chatPanel.ts (our own webview column) is retired and no longer registered.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { idePath, log, rootFor, runJson } from "./cli";

const REQUEST_FRESH_S = 30; // a chat-request older than this is stale (a window opened later ignores it)

type FolderSession = { session: { link: string; title: string } | null };

/** The folder's real path (/tmp/x and /private/tmp/x are one folder), itself when it cannot be resolved. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class NativeChat {
  constructor(ctx: vscode.ExtensionContext) {
    this.watchRequests(ctx);
  }

  /** The chat view, its input focused. */
  async focus() {
    await vscode.commands.executeCommand("workbench.action.chat.open").then(undefined, (e: Error) => log(`chat.open: ${e.message}`));
  }

  /** `text` into the chat input (not sent). */
  async insert(text: string) {
    await vscode.commands
      .executeCommand("workbench.action.chat.open", { query: text, isPartialQuery: true })
      .then(undefined, (e: Error) => log(`chat.open query: ${e.message}`));
  }

  /** The folder's newest session (`dispatch ide folder-session`) in the chat view; none: the chat as it is. */
  async openFolderSession(root: string) {
    try {
      const r = await runJson<FolderSession>(["ide", "folder-session", "--root", root, "--json"], { timeoutMs: 10000 });
      if (r.session?.link) {
        log(`chat: ${r.session.link} (${r.session.title})`);
        // VS Code's agent-host-session:// opener shows the session in the chat view and resolves once it
        // is loaded; only the input gets focus after it (workbench.action.chat.open here would start
        // over and cancel the load)
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(r.session.link));
        await vscode.commands.executeCommand("workbench.action.chat.focusInput").then(undefined, () => undefined);
        return;
      }
    } catch (e) {
      log(`folder-session: ${(e as Error).message}`);
    }
    await this.focus();
  }

  /** ide/chat-request {root, at, seq}: the window whose folder it names takes it; also read once at
   *  start, for the window that request just opened. */
  private watchRequests(ctx: vscode.ExtensionContext) {
    const file = idePath("chat-request");
    const root = rootFor();
    let seen = -1;
    const check = () => {
      let rec: { root?: unknown; at?: unknown; seq?: unknown };
      try {
        rec = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return;
      }
      const seq = typeof rec.seq === "number" ? rec.seq : 0;
      if (seq === seen) return;
      seen = seq;
      if (typeof rec.root !== "string" || typeof rec.at !== "number" || Date.now() / 1000 - rec.at > REQUEST_FRESH_S) return;
      if (!root || real(rec.root) !== real(root)) return;
      void this.openFolderSession(root);
    };
    check();
    fs.watchFile(file, { interval: 500 }, check);
    ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file, check) });
  }
}
