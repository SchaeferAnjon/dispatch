// Dispatch IDE only (the Code - OSS build, design/two-modes): the chat column in the secondary side
// bar. The webview is Dispatch's own ChatPage (built by vite.idechat.config.ts into media/chat); this
// side connects it to chatd's local door (127.0.0.1 port + token in chatd.json, the protocol of
// cli/chat_client.py) and runs `dispatch …` for it. The conversation is the one Dispatch opened this
// folder for (ide/sessions.json, written by `dispatch ide native-open`).
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { dispatchDir, idePath, log, rootFor, run } from "./cli";

type Msg = { kind: string; id?: number; [k: string]: unknown };

/** chatd's door, while the chatd that wrote chatd.json is alive. */
function door(): { port: number; token: string } | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dispatchDir(), "chatd.json"), "utf8"))?.door;
    return d && typeof d.port === "number" && d.token ? d : null;
  } catch {
    return null;
  }
}

/** The conversation Dispatch last opened `root` for (`agent:id`), or null. */
export function sessionFor(root: string | undefined): string | null {
  if (!root) return null;
  try {
    const m = JSON.parse(fs.readFileSync(idePath("sessions.json"), "utf8"));
    const sid = m?.[root]?.sid;
    return typeof sid === "string" && sid.includes(":") ? sid : null;
  } catch {
    return null;
  }
}

/** Folders Dispatch opened in this IDE (ide/sessions.json has them): the only ones trusted without asking. */
export function openedByDispatch(root: string | undefined): boolean {
  if (!root) return false;
  try {
    return Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(idePath("sessions.json"), "utf8")), root);
  } catch {
    return false;
  }
}

/** The Mac's first preferred language (Dispatch follows it; VS Code's own UI language is often just en). */
let osLang: string | undefined;
function systemLanguage(): string {
  if (osLang === undefined) {
    try { osLang = /"?([A-Za-z]{2}[^",\s]*)/.exec(execFileSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000 }))?.[1] ?? ""; } catch { osLang = ""; }
  }
  return osLang || vscode.env.language;
}

/** When the extension started (the chat timing log counts from here). */
export const activatedAt = Date.now();

/** One connection to chatd for the window; lines in both directions, reconnecting while Dispatch restarts. */
export class ChatdLink {
  private sock: net.Socket | null = null;
  private buf = "";
  private retry: NodeJS.Timeout | undefined;
  private closed = false;
  constructor(private onEvent: (e: unknown) => void) { this.connect(); }

  private connect() {
    const d = door();
    if (!d) { this.onEvent({ ev: "chatd", state: "down", reason: "Dispatch is not open" }); this.later(); return; }
    const s = net.connect(d.port, "127.0.0.1");
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      s.write(JSON.stringify({ token: d.token }) + "\n");
      this.onEvent({ ev: "chatd", state: "up" });
    });
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try { this.onEvent(JSON.parse(line)); } catch { log(`chatd: bad line ${line.slice(0, 80)}`); }
      }
    });
    const gone = () => {
      if (this.sock !== s) return;
      this.sock = null;
      this.buf = "";
      this.onEvent({ ev: "chatd", state: "down" });
      this.later();
    };
    s.on("error", (e) => log(`chatd: ${e.message}`));
    s.on("close", gone);
  }
  private later() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, 3000);
  }
  send(cmd: unknown): boolean {
    if (!this.sock || this.sock.connecting) return false;
    this.sock.write(JSON.stringify(cmd) + "\n");
    return true;
  }
  restart() { this.sock?.destroy(); }
  dispose() { this.closed = true; clearTimeout(this.retry); this.sock?.destroy(); }
}

export class ChatPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "dispatch.chat";
  private view: vscode.WebviewView | undefined;
  private link: ChatdLink | undefined;

  constructor(private ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatPanel.viewId, this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.onDidChangeActiveColorTheme(() => this.init()),
      vscode.commands.registerCommand("dispatch.chatDrawer", () => void this.view?.webview.postMessage({ kind: "drawer" })),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.init()),
      { dispose: () => this.link?.dispose() },
    );
    // Dispatch writes sessions.json when it opens a folder here with another conversation
    let last = "";
    const poll = setInterval(() => { const s = sessionFor(rootFor()) ?? ""; if (s !== last) { last = s; this.init(); } }, 2000);
    ctx.subscriptions.push({ dispose: () => clearInterval(poll) });
  }

  private resolvedAt = 0;

  resolveWebviewView(view: vscode.WebviewView) {
    this.resolvedAt = Date.now();
    log(`chat: resolve (${this.resolvedAt - activatedAt} ms after activation)`);
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat");
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [media] };
    const src = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src ${w.cspSource}; img-src ${w.cspSource} data: blob:; font-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${src("chat.css")}"></head>
<body><div id="root"></div><script type="module" src="${src("chat.js")}"></script></body></html>`;
    w.onDidReceiveMessage((m: Msg) => void this.handle(m));
    this.link ??= new ChatdLink((e) => void this.view?.webview.postMessage({ kind: "event", e }));
  }

  /** ⌘L: show the column and put the cursor in its box. */
  async focus() {
    log("chat: focus");
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(`${ChatPanel.viewId}.focus`);
    // the webview takes a moment to get the keyboard after it is shown
    for (const ms of [60, 250, 600]) setTimeout(() => void this.view?.webview.postMessage({ kind: "focus" }), ms);
  }
  /** ⌘⇧L: `@file:lines` into the box. */
  async insert(text: string) {
    await this.focus();
    void this.view?.webview.postMessage({ kind: "insert", text });
  }

  private init() {
    const k = vscode.window.activeColorTheme.kind;
    const dark = k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast;
    void this.view?.webview.postMessage({ kind: "init", init: { root: rootFor() ?? "", session: sessionFor(rootFor()), language: systemLanguage(), dark } });
  }

  private reply(id: number | undefined, ok: boolean, result?: string, error?: string, cached = false) {
    if (id !== undefined) void this.view?.webview.postMessage({ kind: "reply", id, ok, result, error, cached });
  }

  private async handle(m: Msg) {
    try {
      switch (m.kind) {
        case "ready": this.init(); return;
        case "chat":
          if (!this.link?.send(m.cmd)) throw new Error(vscode.l10n.t("Dispatch is not open: the chat runs in Dispatch."));
          return this.reply(m.id, true);
        case "chatRestart": this.link?.restart(); return this.reply(m.id, true);
        case "timing": {
          // the page's own clock: performance.timeOrigin is when the webview document started loading
          const o = Number(m.origin) || 0, at = (k: string) => (typeof m[k] === "number" ? Math.round(o + (m[k] as number) - this.resolvedAt) : "-");
          log(`chat timing (ms after resolve): document ${Math.round(o - this.resolvedAt)}, bundle ${at("bundle")}, init ${at("init")}, detail ${at("detail")}, content ${at("paint")}${m.cached ? " (from cache)" : ""}`);
          return;
        }
        case "dispatch": {
          const args = Array.isArray(m.args) ? m.args.filter((a): a is string => typeof a === "string") : [];
          const fetch = async () => {
            const t0 = Date.now();
            const r = await run(args, { input: typeof m.stdin === "string" ? m.stdin : undefined, timeoutMs: 120000 });
            log(`chat: dispatch ${args.slice(0, 2).join(" ")} ${Date.now() - t0} ms`);
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`);
            return r.stdout;
          };
          if (!m.cache) return this.reply(m.id, true, await fetch());
          // the last answer now (a python start is 0.3 to 0.6 s), the fresh one when it lands
          const key = `chatcli:${args.join(" ")}`;
          const store = m.cache === "workspace" ? this.ctx.workspaceState : this.ctx.globalState;
          const cached = store.get<string>(key);
          if (cached === undefined) { const out = await fetch(); void store.update(key, out); return this.reply(m.id, true, out); }
          this.reply(m.id, true, cached, undefined, true);
          const out = await fetch().catch(() => cached);
          if (out !== cached) { void store.update(key, out); void this.view?.webview.postMessage({ kind: "fresh", key: args.join(" "), result: out }); }
          return;
        }
        case "openFile": {
          const p = String(m.path || "");
          const abs = path.isAbsolute(p) ? p : path.join(rootFor() ?? "", p);
          const doc = await vscode.workspace.openTextDocument(abs);
          const line = typeof m.line === "number" && m.line > 0 ? m.line - 1 : 0;
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: false });
          return this.reply(m.id, true);
        }
        case "title":
          if (this.view) { this.view.title = typeof m.title === "string" && m.title ? m.title : vscode.l10n.t("Chat"); this.view.description = typeof m.state === "string" ? m.state : ""; }
          return;
        case "back": await vscode.commands.executeCommand("dispatch.backToChat"); return;
        case "close": await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar"); return;
      }
    } catch (e) {
      this.reply(m.id, false, undefined, (e as Error).message);
    }
  }
}
