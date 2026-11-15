// Dispatch › Search: ask the codebase a question (`dispatch code-search`, embeddings with keyword
// search as the floor); click a hit to open the file at those lines (PLAN.md §3.4). Saved files are
// re-indexed in the background when the project already has an index.
import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { localPath, log, rootFor, runJson } from "./cli";

interface Hit {
  path: string;
  start: number;
  end: number;
  score: number;
  via: string;
  text: string;
}

interface Answer {
  query: string;
  root: string;
  mode: "hybrid" | "keyword";
  reason?: string;
  results: Hit[];
  ms: number;
  indexing?: boolean;
}

/** `dispatch.codeSearch(query, root)`: the same search for other places (the Agents window's sessions picker,
 *  In codebase): up to 8 hits, absolute path, path relative to `root`, 1-based line, the hit's first line. */
export function registerCodeSearch(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.codeSearch", async (query: string, root: string) => {
      if (!query || !root) return [];
      const ans = await runJson<Answer>(["code-search", query, "--root", root, "-n", "8", "--json"], { timeoutMs: 60000 });
      return ans.results.map((h) => {
        const abs = path.isAbsolute(h.path) ? h.path : path.join(root, h.path);
        const first = h.text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
        return { path: abs, relative: path.relative(root, abs), line: h.start, text: first.slice(0, 160) };
      });
    }),
  );
}

export class Search implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pendingQuery = "";
  private saved = new Set<string>();
  private saveTimer: NodeJS.Timeout | undefined;
  private indexed: boolean | undefined;
  private seq = 0;

  constructor(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider("dispatch.search", this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand("dispatch.searchCodebase", () => this.focus()),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
      { dispose: () => this.saveTimer && clearTimeout(this.saveTimer) },
    );
  }

  private async focus() {
    const ed = vscode.window.activeTextEditor;
    const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection).trim() : "";
    if (sel && sel.length < 200 && !sel.includes("\n")) this.pendingQuery = sel;
    await vscode.commands.executeCommand("dispatch.search.focus");
    if (this.view) {
      void this.view.webview.postMessage({ type: "focus", query: this.pendingQuery });
      this.pendingQuery = "";
    }
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.onDidDispose(() => (this.view = undefined));
    view.webview.onDidReceiveMessage((m: { type: string; query?: string; path?: string; start?: number; end?: number }) => {
      if (m.type === "search" && m.query) void this.search(m.query);
      if (m.type === "open" && m.path) void this.open(m.path, m.start || 1, m.end || m.start || 1);
      if (m.type === "ready" && this.pendingQuery) {
        void view.webview.postMessage({ type: "focus", query: this.pendingQuery });
        this.pendingQuery = "";
      }
    });
  }

  private async search(query: string) {
    const root = rootFor();
    const v = this.view;
    if (!v) return;
    if (!root) {
      void v.webview.postMessage({ type: "error", message: vscode.l10n.t("Open a folder first.") });
      return;
    }
    const n = ++this.seq;
    void v.webview.postMessage({ type: "busy" });
    try {
      const ans = await runJson<Answer>(["code-search", query, "--root", root, "-n", "20", "--json"], { timeoutMs: 180000 });
      if (n !== this.seq) return;
      this.indexed = true;
      const modeLabel =
        ans.mode === "hybrid"
          ? vscode.l10n.t("meaning + keywords")
          : ans.reason === "no_key"
            ? vscode.l10n.t("keywords only (no OPENAI_API_KEY)")
            : vscode.l10n.t("keywords only");
      void v.webview.postMessage({ type: "results", query, mode: modeLabel, ms: ans.ms, results: ans.results.map((h) => ({ ...h, text: h.text.slice(0, 600) })), empty: vscode.l10n.t("Nothing found.") });
    } catch (e) {
      if (n === this.seq) void v.webview.postMessage({ type: "error", message: (e as Error).message });
    }
  }

  private async open(rel: string, start: number, end: number) {
    const root = rootFor();
    if (!root) return;
    const uri = vscode.Uri.file(path.join(root, rel));
    const range = new vscode.Range(Math.max(0, start - 1), 0, Math.max(0, end - 1), 0);
    const ed = await vscode.window.showTextDocument(uri, { selection: new vscode.Range(range.start, range.start), preview: true });
    ed.revealRange(range, vscode.TextEditorRevealType.AtTop);
  }

  /** Re-index saved files ten seconds after the last save, one CLI call for all of them. */
  private onSave(d: vscode.TextDocument) {
    const file = localPath(d.uri);
    const root = rootFor(d.uri);
    if (!file || !root || this.indexed === false) return;
    this.saved.add(path.relative(root, file));
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.reindex(root), 10000);
  }

  private async reindex(root: string) {
    if (this.indexed === undefined) {
      try {
        const st = await runJson<{ exists: boolean }>(["code-search", "status", "--root", root, "--json"], { timeoutMs: 20000 });
        this.indexed = !!st.exists;
      } catch {
        this.indexed = false;
      }
    }
    const files = [...this.saved];
    this.saved.clear();
    if (!this.indexed || !files.length) return;
    try {
      await runJson(["code-search", "index", "--root", root, ...files.flatMap((f) => ["--file", f]), "--json"], { timeoutMs: 120000 });
    } catch (e) {
      log(`code-search index: ${(e as Error).message}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const t = {
      placeholder: vscode.l10n.t("Ask the codebase, e.g. where is the session list refreshed"),
      searching: vscode.l10n.t("Searching…"),
      hint: vscode.l10n.t("Enter to search. Results come from the project index; the first search builds it."),
    };
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{padding:6px 8px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
input{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);outline:none}
input:focus{border-color:var(--vscode-focusBorder)}
.meta{margin:6px 0;opacity:.75;font-size:.92em}
.hit{padding:5px 4px;border-radius:3px;cursor:pointer}
.hit:hover,.hit:focus{background:var(--vscode-list-hoverBackground);outline:none}
.loc{font-family:var(--vscode-editor-font-family);font-size:.95em;color:var(--vscode-textLink-foreground)}
.via{float:right;opacity:.6;font-size:.85em}
pre{margin:3px 0 0;white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family);font-size:.88em;opacity:.85;max-height:4.6em;overflow:hidden}
.err{color:var(--vscode-errorForeground)}
</style></head><body>
<input id="q" type="text" placeholder="${esc(t.placeholder)}" aria-label="${esc(t.placeholder)}">
<div class="meta" id="meta">${esc(t.hint)}</div>
<div id="out" role="list"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const q = document.getElementById('q'), out = document.getElementById('out'), meta = document.getElementById('meta');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
q.addEventListener('keydown', e => { if (e.key === 'Enter' && q.value.trim()) vscode.postMessage({type:'search', query:q.value.trim()}); });
out.addEventListener('click', e => { const h = e.target.closest('.hit'); if (h) vscode.postMessage({type:'open', path:h.dataset.path, start:+h.dataset.start, end:+h.dataset.end}); });
out.addEventListener('keydown', e => { const h = e.target.closest('.hit'); if (h && e.key === 'Enter') h.click(); });
window.addEventListener('message', ({data:m}) => {
  if (m.type === 'focus') { if (m.query) q.value = m.query; q.focus(); q.select(); if (m.query) vscode.postMessage({type:'search', query:m.query}); }
  if (m.type === 'busy') { meta.textContent = ${JSON.stringify(t.searching)}; meta.className = 'meta'; }
  if (m.type === 'error') { meta.textContent = m.message; meta.className = 'meta err'; out.innerHTML = ''; }
  if (m.type === 'results') {
    meta.className = 'meta';
    meta.textContent = m.results.length + ' · ' + m.mode + ' · ' + m.ms + ' ms';
    out.innerHTML = m.results.length ? m.results.map(h => '<div class="hit" role="listitem" tabindex="0" data-path="'+esc(h.path)+'" data-start="'+h.start+'" data-end="'+h.end+'"><span class="via">'+esc(h.via)+'</span><span class="loc">'+esc(h.path)+':'+h.start+'-'+h.end+'</span><pre>'+esc(h.text.split('\\n').filter(l => l.trim()).slice(0,3).join('\\n'))+'</pre></div>').join('') : '<div class="meta">'+esc(m.empty)+'</div>';
  }
});
vscode.postMessage({type:'ready'});
q.focus();
</script></body></html>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
