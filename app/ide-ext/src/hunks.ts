// Agent changes in the open file: green lines for what the agent wrote, a red marker where it removed
// lines, a CodeLens per change (Accept ⌘Y · Undo ⌘N) and one at the top for the whole file. The data
// is the Monaco editor mode's: baselines chatd captures before an agent edit, `dispatch editor
// hunks|accept|undo` (app/src/editor/CONTRACT.md 三). Saves the person makes here are folded into the
// baseline with `dispatch editor fold`, so their own typing never shows as an agent change.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { dispatchDir, idePath, localPath, log, runJson } from "./cli";
import { AgentHunk, hunkAt, nextHunk, oldPreview, paint, pickSession, preferredSid, SessionIndex, sidFromDir } from "./core/hunkModel";

interface FileHunks {
  sid: string;
  root: string;
  file: string;
  version: number;
  hunks: AgentHunk[];
}

export class Hunks implements vscode.CodeLensProvider {
  private byUri = new Map<string, FileHunks>();
  private indexes: SessionIndex[] = [];
  private indexesAt = 0;
  private sessions: { mtime: number; data: unknown } = { mtime: -1, data: undefined };
  private beforeSave = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly changed = new vscode.EventEmitter<void>();
  /** fires when the count of agent changes in the active file changes (status bar) */
  readonly onDidChange = this.changed.event;
  private addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
  });
  private removedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "2px 0 0 0",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorGutter.deletedBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      this.addedDeco,
      this.removedDeco,
      vscode.languages.registerCodeLensProvider({ pattern: "**" }, this),
      vscode.commands.registerCommand("dispatch.acceptHunk", (uri?: vscode.Uri, id?: string) => this.decide("accept", uri, id)),
      vscode.commands.registerCommand("dispatch.undoHunk", (uri?: vscode.Uri, id?: string) => this.decide("undo", uri, id)),
      vscode.commands.registerCommand("dispatch.acceptAllHunks", (uri?: vscode.Uri) => this.decide("accept", uri, "*")),
      vscode.commands.registerCommand("dispatch.undoAllHunks", (uri?: vscode.Uri) => this.decide("undo", uri, "*")),
      vscode.commands.registerCommand("dispatch.nextHunk", () => this.jump(1)),
      vscode.commands.registerCommand("dispatch.prevHunk", () => this.jump(-1)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisible()),
      vscode.window.onDidChangeActiveTextEditor(() => this.syncContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.syncContext()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.rememberDisk(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => void this.afterSave(d)),
      { dispose: () => this.timer && clearTimeout(this.timer) },
    );
    this.watch(ctx);
    this.refreshVisible();
  }

  /** chatd writes editor/<sid>/index.json when an agent edits; the agent's writes land on disk. */
  private watch(ctx: vscode.ExtensionContext) {
    const dir = path.join(dispatchDir(), "editor");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, { recursive: true }, () => this.soon());
      ctx.subscriptions.push({ dispose: () => w.close() });
    } catch (e) {
      log(`hunks: cannot watch ${dir}: ${(e as Error).message}`);
    }
    const fw = vscode.workspace.createFileSystemWatcher("**/*");
    fw.onDidChange(() => this.soon());
    fw.onDidCreate(() => this.soon());
    fw.onDidDelete(() => this.soon());
    ctx.subscriptions.push(fw);
  }

  private soon() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.indexesAt = 0;
      this.refreshVisible();
    }, 300);
  }

  private loadIndexes(): SessionIndex[] {
    if (Date.now() - this.indexesAt < 2000) return this.indexes;
    const dir = path.join(dispatchDir(), "editor");
    const out: SessionIndex[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      const p = path.join(dir, n, "index.json");
      try {
        const st = fs.statSync(p);
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j && typeof j.root === "string" && j.files && typeof j.files === "object") out.push({ sid: sidFromDir(n), root: j.root, files: j.files, mtime: st.mtimeMs });
      } catch {
        /* no index in this folder */
      }
    }
    this.indexes = out;
    this.indexesAt = Date.now();
    return out;
  }

  private owner(file: string) {
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {
      /* deleted: keep the path */
    }
    const idx = this.loadIndexes();
    const want = (f: string) => preferredSid(this.openedFor(), f, process.env.DISPATCH_IDE_SID || "");
    return pickSession(idx, real, want(real)) ?? (real !== file ? pickSession(idx, file, want(file)) : undefined);
  }

  /** ide/sessions.json: the session each folder was last opened for (re-read when it changes). */
  private openedFor(): unknown {
    const p = idePath("sessions.json");
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m !== this.sessions.mtime) this.sessions = { mtime: m, data: JSON.parse(fs.readFileSync(p, "utf8")) };
    } catch {
      this.sessions = { mtime: -1, data: undefined };
    }
    return this.sessions.data;
  }

  refreshVisible() {
    for (const ed of vscode.window.visibleTextEditors) void this.refresh(ed.document);
  }

  async refresh(doc: vscode.TextDocument) {
    const file = localPath(doc.uri);
    const key = doc.uri.toString();
    const own = file ? this.owner(file) : undefined;
    if (!file || !own) {
      if (this.byUri.delete(key)) this.render(doc);
      return;
    }
    try {
      const ans = await runJson<{ hunks: AgentHunk[] }>(["editor", "hunks", file, "--root", own.root, "--sid", own.sid, "--json"], { timeoutMs: 20000 });
      this.byUri.set(key, { sid: own.sid, root: own.root, file, version: doc.version, hunks: ans.hunks || [] });
    } catch (e) {
      log(`hunks ${file}: ${(e as Error).message}`);
      this.byUri.delete(key);
    }
    this.render(doc);
  }

  /** Paint every visible editor showing `doc`; hide the paint while it has unsaved typing. */
  private render(doc: vscode.TextDocument) {
    const fh = this.byUri.get(doc.uri.toString());
    const hunks = fh && !doc.isDirty ? fh.hunks : [];
    const p = paint(hunks, doc.lineCount);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document !== doc) continue;
      ed.setDecorations(
        this.addedDeco,
        p.added.map(([a, b], i) => ({
          range: new vscode.Range(a, 0, b, 0),
          hoverMessage: this.hover(hunks.filter((h) => h.new_lines > 0)[i]),
        })),
      );
      ed.setDecorations(
        this.removedDeco,
        p.removedAt.map((l, i) => ({
          range: new vscode.Range(l, 0, l, 0),
          hoverMessage: this.hover(hunks.filter((h) => h.new_lines === 0)[i]),
          renderOptions: { after: { margin: "0 0 0 2em", fontStyle: "italic", contentText: vscode.l10n.t("− {0} lines removed by the agent", hunks.filter((h) => h.new_lines === 0)[i]?.old_lines ?? 0), color: new vscode.ThemeColor("editorGutter.deletedBackground") } },
        })),
      );
    }
    this.lensChanged.fire();
    this.syncContext();
  }

  private hover(h: AgentHunk | undefined): vscode.MarkdownString | undefined {
    if (!h || !h.old_lines) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(vscode.l10n.t("**Before the agent's change** ({0} lines):", h.old_lines) + "\n");
    md.appendCodeblock(oldPreview(h));
    return md;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const fh = this.byUri.get(doc.uri.toString());
    if (!fh || !fh.hunks.length || doc.isDirty) return [];
    const p = paint(fh.hunks, doc.lineCount);
    const n = fh.hunks.length;
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: n === 1 ? vscode.l10n.t("$(sparkle) The agent changed this file in 1 place") : vscode.l10n.t("$(sparkle) The agent changed this file in {0} places", n), command: "dispatch.nextHunk" }),
      new vscode.CodeLens(top, { title: vscode.l10n.t("Accept all ⇧⌘Y"), command: "dispatch.acceptAllHunks", arguments: [doc.uri] }),
      new vscode.CodeLens(top, { title: vscode.l10n.t("Undo all ⇧⌘N"), command: "dispatch.undoAllHunks", arguments: [doc.uri] }),
    ];
    fh.hunks.forEach((h, i) => {
      const r = new vscode.Range(p.lens[i], 0, p.lens[i], 0);
      lenses.push(
        new vscode.CodeLens(r, { title: vscode.l10n.t("Accept ⌘Y"), command: "dispatch.acceptHunk", arguments: [doc.uri, h.id] }),
        new vscode.CodeLens(r, { title: vscode.l10n.t("Undo ⌘N"), command: "dispatch.undoHunk", arguments: [doc.uri, h.id] }),
        new vscode.CodeLens(r, { title: vscode.l10n.t("change {0} of {1}", h.index, n), command: "" }),
      );
    });
    return lenses;
  }

  /** Agent changes in the active editor (status bar). */
  activeCount(): number {
    const ed = vscode.window.activeTextEditor;
    const fh = ed && this.byUri.get(ed.document.uri.toString());
    return fh && !ed.document.isDirty ? fh.hunks.length : 0;
  }

  private syncContext() {
    void vscode.commands.executeCommand("setContext", "dispatch.hasHunks", this.activeCount() > 0);
    this.changed.fire();
  }

  private async decide(op: "accept" | "undo", uri?: vscode.Uri, id?: string) {
    const ed = vscode.window.activeTextEditor;
    const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : ed?.document;
    if (!doc) return;
    const fh = this.byUri.get(doc.uri.toString());
    if (!fh || !fh.hunks.length) return;
    if (doc.isDirty) {
      void vscode.window.showWarningMessage(vscode.l10n.t("Save the file first: the agent's changes are compared with the file on disk."));
      return;
    }
    let target: string[];
    if (id === "*") target = ["--all"];
    else {
      const h = id ? fh.hunks.find((x) => x.id === id) : hunkAt(fh.hunks, ed && ed.document === doc ? ed.selection.active.line : 0);
      if (!h) return;
      target = ["--hunk", h.id];
    }
    try {
      const ans = await runJson<{ hunks: AgentHunk[]; wrote?: boolean; text?: string; exists?: boolean }>(
        ["editor", op, fh.file, "--root", fh.root, "--sid", fh.sid, ...target, "--json"],
        { timeoutMs: 20000 },
      );
      log(`hunks: ${op} ${target.join(" ")} in ${fh.file} → ${ans.hunks?.length ?? 0} left`);
      if (op === "undo" && ans.wrote && ans.exists !== false && typeof ans.text === "string") {
        // put the disk's new text into the open document now instead of waiting for the file watcher;
        // the save that follows writes the same bytes, so there is nothing to fold
        const full = new vscode.Range(0, 0, doc.lineCount, 0);
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, full, ans.text);
        await vscode.workspace.applyEdit(we);
        this.beforeSave.set(doc.uri.toString(), ans.text);
        await doc.save();
        void this.note(fh, op, target);
      } else if (op === "undo") {
        void this.note(fh, op, target);
      }
      fh.hunks = ans.hunks || [];
      this.render(doc);
    } catch (e) {
      void vscode.window.showErrorMessage(op === "accept" ? vscode.l10n.t("Could not accept the change: {0}", (e as Error).message) : vscode.l10n.t("Could not undo the change: {0}", (e as Error).message));
      void this.refresh(doc);
    }
  }

  /** Tell the agent (next message) that the person undid its change, like the Monaco editor mode does. */
  private async note(fh: FileHunks, _op: string, target: string[]) {
    const rel = path.relative(fh.root, fh.file).split(path.sep).join("/");
    const text = target[0] === "--all" ? `The user undid all of your changes to ${rel} in the IDE.` : `The user undid one of your changes to ${rel} in the IDE.`;
    try {
      await runJson(["ide", "signal", "agent-note", "--data", JSON.stringify({ sid: fh.sid, path: rel, text }), "--json"], { timeoutMs: 10000 });
    } catch (e) {
      log(`note: ${(e as Error).message}`);
    }
  }

  private jump(dir: 1 | -1) {
    const ed = vscode.window.activeTextEditor;
    const fh = ed && this.byUri.get(ed.document.uri.toString());
    if (!ed || !fh) return;
    const h = nextHunk(fh.hunks, ed.selection.active.line, dir);
    if (!h) return;
    const line = Math.max(0, Math.min(h.new_start - 1, ed.document.lineCount - 1));
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private onEdit(e: vscode.TextDocumentChangeEvent) {
    // typing hides the paint (line numbers no longer match the disk); saving brings it back
    if (!e.contentChanges.length) return;
    const fh = this.byUri.get(e.document.uri.toString());
    if (fh && e.document.isDirty) this.render(e.document);
  }

  private rememberDisk(doc: vscode.TextDocument) {
    const file = localPath(doc.uri);
    if (!file || !this.owner(file)) return;
    const k = doc.uri.toString();
    if (this.beforeSave.has(k)) return;
    try {
      this.beforeSave.set(k, fs.readFileSync(file, "utf8"));
    } catch {
      this.beforeSave.set(k, "");
    }
  }

  private async afterSave(doc: vscode.TextDocument) {
    const k = doc.uri.toString();
    const before = this.beforeSave.get(k);
    this.beforeSave.delete(k);
    const file = localPath(doc.uri);
    const own = file ? this.owner(file) : undefined;
    if (file && own && before !== undefined) {
      try {
        const ans = await runJson<{ baseline_folded: boolean }>(["editor", "fold", file, "--root", own.root, "--sid", own.sid, "--json"], { input: before, timeoutMs: 20000 });
        log(`hunks: save of ${file} folded=${ans.baseline_folded}`);
      } catch (e) {
        log(`fold ${file}: ${(e as Error).message}`);
      }
    }
    await this.refresh(doc);
  }
}
