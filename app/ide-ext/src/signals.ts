// The IDE → Dispatch direction. The workbench is a child webview inside Dispatch; the extension host
// cannot reach the React page, so it writes one-line signals with `dispatch ide signal <name>` and the
// app watches ~/tasks/.dispatch/ide/signal (PLAN.md §2.2). Also: the unsaved-file count the app reads
// on ⌘Q (ide/dirty.json, the file `dispatch ide dirty` writes), and the web preview in VS Code's Simple Browser.
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { idePath, localPath, log, rootFor, runJson } from "./cli";
import { chatRef, dirtyJson, dirtyReport, PREVIEW_PORTS } from "./core/signalModel";
/** Where ⌘L and ⌘⇧L go in Dispatch IDE (nativeChat.ts: VS Code's own chat view). */
type ChatTarget = { focus(): Promise<unknown>; insert(text: string): Promise<unknown> };

/** Dispatch IDE.app (our Code - OSS build) rather than the workbench embedded in Dispatch. */
export const isNative = () => vscode.env.appName === "Dispatch IDE";

export async function signal(name: string, data?: unknown): Promise<boolean> {
  const args = ["ide", "signal", name, "--json"];
  if (data !== undefined) args.splice(3, 0, "--data", JSON.stringify(data));
  try {
    await runJson(args, { timeoutMs: 10000 });
    return true;
  } catch (e) {
    log(`signal ${name}: ${(e as Error).message}`);
    return false;
  }
}

/** `chat`: Dispatch IDE's chat view (⌘L / ⌘⇧L go there instead of to Dispatch's window). */
export function registerSignals(ctx: vscode.ExtensionContext, chat?: ChatTarget) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.focusChat", () => chat ? chat.focus() : signal("focus-chat", { root: rootFor() })),
    vscode.commands.registerCommand("dispatch.backToChat", () => isNative()
      // --frame: Dispatch's window comes back where this one is, at its size (5A.3); a CLI older than --frame gets the plain call
      ? runJson(["ide", "back", "--root", rootFor() || "", "--frame", "--json"], { timeoutMs: 10000 })
        .catch(() => runJson(["ide", "back", "--root", rootFor() || "", "--json"], { timeoutMs: 10000 }))
        .catch((e: Error) => log(`back: ${e.message}`))
      : signal("back-to-chat", { root: rootFor() })),
    vscode.commands.registerCommand("dispatch.addToChat", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const file = localPath(ed.document.uri);
      const root = rootFor(ed.document.uri);
      const s = ed.selection;
      const ref = chatRef({
        root: root || "",
        file: file || ed.document.fileName,
        startLine: s.start.line,
        endLine: s.isEmpty ? s.start.line : s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line,
        text: s.isEmpty ? ed.document.lineAt(s.start.line).text : ed.document.getText(s),
        sep: path.sep,
      });
      if (chat) await chat.insert(ref.mention.endsWith(" ") ? ref.mention : ref.mention + " ");
      else if (await signal("add-to-chat", ref)) vscode.window.setStatusBarMessage(vscode.l10n.t("Added {0} to the chat", ref.mention), 3000);
    }),
    vscode.commands.registerCommand("dispatch.openPreview", () => openPreview()),
  );
  new DirtyCount(ctx);
  watchOpenRequests(ctx);
}

/** The Dispatch → IDE direction: `dispatch ide open-file <path>` (a file chip clicked in the chat
 * column) writes ~/tasks/.dispatch/ide/open-request; open it here. Only requests newer than this
 * window, so a reload does not reopen an old one. */
function watchOpenRequests(ctx: vscode.ExtensionContext) {
  const file = idePath("open-request");
  const started = Date.now() / 1000;
  let seen = -1;
  const check = () => {
    let rec: { path?: unknown; line?: unknown; at?: unknown; seq?: unknown };
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return;
    }
    const seq = typeof rec.seq === "number" ? rec.seq : 0;
    if (seq === seen) return;
    seen = seq;
    if (typeof rec.path !== "string" || typeof rec.at !== "number" || rec.at < started - 2) return;
    const line = typeof rec.line === "number" && rec.line > 0 ? rec.line - 1 : 0;
    const pos = new vscode.Position(line, 0);
    vscode.window.showTextDocument(vscode.Uri.file(rec.path), { selection: new vscode.Range(pos, pos), preview: false }).then(
      undefined,
      (e: unknown) => log(`open-request ${rec.path}: ${(e as Error).message}`),
    );
  };
  fs.watchFile(file, { interval: 500 }, check);
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file, check) });
}

/** Unsaved documents in this workbench, written straight to ide/dirty.json (no CLI process on the
 *  way: ⌘Q reads the file): at once when the count grows, a second later when it shrinks. */
class DirtyCount {
  private last = -1;
  private timer: NodeJS.Timeout | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    const check = () => {
      const n = this.count();
      const when = dirtyReport(this.last, n);
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (when === "now") this.write(n);
      else if (when === "later") this.timer = setTimeout(() => this.write(this.count()), 1000);
    };
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(check),
      vscode.workspace.onDidSaveTextDocument(check),
      vscode.workspace.onDidCloseTextDocument(check),
      vscode.workspace.onDidOpenTextDocument(check),
      { dispose: () => this.timer && clearTimeout(this.timer) },
    );
    check();
  }

  count(): number {
    return vscode.workspace.textDocuments.filter((d) => d.isDirty && (d.uri.scheme === "untitled" || !!localPath(d.uri))).length;
  }

  private write(n: number) {
    if (n === this.last) return;
    const p = idePath("dirty.json");
    const tmp = `${p}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, dirtyJson(n, Date.now()));
      fs.renameSync(tmp, p);
      this.last = n;
    } catch (e) {
      log(`dirty: ${(e as Error).message}`);
    }
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Open a local dev server in Simple Browser beside the editor: pick a port that answers, or type a URL. */
async function openPreview() {
  const up = (await Promise.all(PREVIEW_PORTS.map(async (p) => ((await listening(p)) ? p : 0)))).filter(Boolean);
  const other = vscode.l10n.t("Other URL…");
  const items: vscode.QuickPickItem[] = [
    ...up.map((p) => ({ label: `http://localhost:${p}`, description: vscode.l10n.t("answering") })),
    { label: other },
  ];
  let url: string | undefined;
  if (up.length) {
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Preview which server?") });
    if (!pick) return;
    url = pick.label === other ? undefined : pick.label;
  }
  if (!url) {
    url = await vscode.window.showInputBox({
      title: vscode.l10n.t("Preview"),
      prompt: up.length ? undefined : vscode.l10n.t("No dev server found on the usual ports. Enter a URL."),
      value: "http://localhost:3000",
      validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : vscode.l10n.t("Enter an http:// or https:// URL")),
    });
    if (!url) return;
  }
  await vscode.commands.executeCommand("simpleBrowser.show", url.trim());
}
