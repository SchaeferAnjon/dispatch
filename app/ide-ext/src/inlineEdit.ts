// ⌘K: rewrite the selected lines by an instruction. The model call is `dispatch ide edit` (model from
// the ide_edit_model setting, claude:sonnet by default); the answer opens as a diff (file ↔ proposal)
// with Accept (⌘⏎) / Reject (⎋) in the editor title (PLAN.md §3.1).
import * as path from "path";
import * as vscode from "vscode";
import { CliError, localPath, log, rootFor, runJson } from "./cli";
import { contextFromHits, EDIT_MAX_LINES, LineSpan, linesText, locate, parseInstruction, replaceLines, SearchHit, selectedLines, selectionTooLarge } from "./core/proposal";

export const PROPOSAL_SCHEME = "dispatch-proposal";
const CONTEXT_LINES = 80;

interface Proposal {
  id: string;
  target: vscode.Uri;
  span: LineSpan;
  original: string;
  text: string;
  instruction: string;
  model: string;
  /** its diff tab has been opened (a proposal whose tab is gone after that was closed by hand) */
  opened?: boolean;
}

export class InlineEdit implements vscode.TextDocumentContentProvider {
  private proposals = new Map<string, Proposal>();
  private seq = 0;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  /** the last proposal decided, for tests and the log */
  lastDecision: { id: string; accepted: boolean } | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this),
      vscode.commands.registerCommand("dispatch.inlineEdit", () => this.start()),
      vscode.commands.registerCommand("dispatch.acceptEdit", (uri?: vscode.Uri) => this.finish(true, uri)),
      vscode.commands.registerCommand("dispatch.rejectEdit", (uri?: vscode.Uri) => this.finish(false, uri)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.syncContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.syncContext()),
      vscode.window.onDidChangeActiveTextEditor(() => this.syncContext()),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const p = this.proposals.get(uri.query);
    if (!p) return "";
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === p.target.toString());
    const crlf = doc?.eol === vscode.EndOfLine.CRLF;
    const base = (doc?.getText() ?? "").replace(/\r\n/g, "\n");
    const at = locate(base, p.original, p.span.start) ?? p.span;
    const out = replaceLines(base, at, p.text);
    return crlf ? out.replace(/\n/g, "\r\n") : out;
  }

  private async start() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const doc = ed.document;
    const file = localPath(doc.uri);
    const root = rootFor(doc.uri);
    const s = ed.selection;
    const span = selectedLines({ startLine: s.start.line, startCol: s.start.character, endLine: s.end.line, endCol: s.end.character });
    const text = doc.getText().replace(/\r\n/g, "\n");
    const original = linesText(text, span);
    if (selectionTooLarge(original)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("⌘K rewrites up to {0} lines at a time; select less, or ask the agent in the chat.", EDIT_MAX_LINES),
      );
      return;
    }
    const raw = await vscode.window.showInputBox({
      title: vscode.l10n.t("Edit lines {0}-{1}", span.start + 1, span.end + 1),
      prompt: vscode.l10n.t("What should change? Start with @codebase to give the model related code from the project."),
      placeHolder: vscode.l10n.t("e.g. add type hints, handle the empty list"),
      ignoreFocusOut: true,
    });
    if (!raw || !raw.trim()) return;
    const { instruction, codebase } = parseInstruction(raw);
    if (!instruction) return;
    const rel = root && file ? path.relative(root, file).split(path.sep).join("/") : path.basename(doc.fileName);
    const all = text.split("\n");
    const payload = {
      instruction,
      selection: original,
      before: all.slice(Math.max(0, span.start - CONTEXT_LINES), span.start).join("\n"),
      after: all.slice(span.end + 1, span.end + 1 + CONTEXT_LINES).join("\n"),
      context: [] as SearchHit[],
    };
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Dispatch is rewriting {0} lines…", span.end - span.start + 1), cancellable: true },
      async (progress, token) => {
        try {
          if (codebase && root) {
            progress.report({ message: vscode.l10n.t("searching the codebase") });
            try {
              const hits = await runJson<{ results: SearchHit[] }>(["code-search", instruction, "--root", root, "-n", "12", "--json"], { timeoutMs: 60000, token });
              payload.context = contextFromHits(hits.results || [], rel, span);
            } catch (e) {
              if ((e as CliError).code === "cancelled") throw e;
              log(`⌘K @codebase: ${(e as Error).message}`);
            }
            progress.report({ message: vscode.l10n.t("asking the model") });
          }
          const args = ["ide", "edit", "--root", root || path.dirname(file || doc.fileName), "--start", String(span.start + 1), "--end", String(span.end + 1), "--json"];
          if (file) args.splice(4, 0, "--file", file);
          return await runJson<{ text: string; model: string }>(args, { input: JSON.stringify(payload), timeoutMs: 120000, token });
        } catch (e) {
          if ((e as CliError).code !== "cancelled") void vscode.window.showErrorMessage(vscode.l10n.t("⌘K failed: {0}", (e as Error).message));
          return undefined;
        }
      },
    );
    if (!res) return;
    if (res.text === original) {
      void vscode.window.showInformationMessage(vscode.l10n.t("The model left these lines unchanged."));
      return;
    }
    await this.show({ id: `p${++this.seq}`, target: doc.uri, span, original, text: res.text, instruction, model: res.model });
  }

  private async show(p: Proposal) {
    this.proposals.set(p.id, p);
    const right = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: p.target.path, query: p.id });
    const title = vscode.l10n.t("{0} ↔ ⌘K proposal", path.basename(p.target.path));
    await vscode.commands.executeCommand("vscode.diff", p.target, right, title, { preview: false, selection: new vscode.Range(p.span.start, 0, p.span.start, 0) });
    p.opened = true;
    log(`⌘K proposal ${p.id} shown for ${p.target.fsPath}:${p.span.start + 1}-${p.span.end + 1} (${p.model})`);
    this.syncContext();
  }

  /** The proposal in the active tab, or the one a title-bar button was clicked for. */
  private current(uri?: vscode.Uri): Proposal | undefined {
    if (uri?.scheme === PROPOSAL_SCHEME) return this.proposals.get(uri.query);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSAL_SCHEME) return this.proposals.get(input.modified.query);
    return undefined;
  }

  private async finish(accept: boolean, uri?: vscode.Uri) {
    const p = this.current(uri);
    if (!p) return;
    if (accept) {
      const doc = await vscode.workspace.openTextDocument(p.target);
      const at = locate(doc.getText().replace(/\r\n/g, "\n"), p.original, p.span.start);
      if (!at) {
        void vscode.window.showWarningMessage(vscode.l10n.t("These lines changed since the proposal was made; nothing was replaced."));
        return;
      }
      const we = new vscode.WorkspaceEdit();
      we.replace(p.target, new vscode.Range(at.start, 0, at.end, doc.lineAt(at.end).text.length), p.text);
      if (!(await vscode.workspace.applyEdit(we))) {
        void vscode.window.showErrorMessage(vscode.l10n.t("Could not apply the edit."));
        return;
      }
      await doc.save();
    }
    this.proposals.delete(p.id);
    this.lastDecision = { id: p.id, accepted: accept };
    log(`⌘K proposal ${p.id} ${accept ? "accepted" : "rejected"}`);
    await this.closeTabs(p.id);
    this.syncContext();
  }

  private async closeTabs(id: string) {
    const tabs: vscode.Tab[] = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSAL_SCHEME && t.input.modified.query === id) tabs.push(t);
      }
    }
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  /** `dispatch.proposalActive`: the active tab is a ⌘K proposal (Accept / Reject buttons and keys). */
  private syncContext() {
    const active = !!this.current();
    void vscode.commands.executeCommand("setContext", "dispatch.proposalActive", active);
    // a proposal tab closed by hand is a reject
    const open = new Set<string>();
    for (const g of vscode.window.tabGroups.all)
      for (const t of g.tabs) if (t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSAL_SCHEME) open.add(t.input.modified.query);
    for (const [id, p] of [...this.proposals]) if (p.opened && !open.has(id)) this.proposals.delete(id);
  }
}
