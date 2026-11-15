// Dispatch › Checkpoints: the agent turns `dispatch checkpoint list` knows for this project, newest
// first; "Restore to before this turn" calls `checkpoint restore` (PLAN.md §3.5). When the CLI does
// not have checkpoints yet (it answers "unsupported"), the view shows one line saying so.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CliError, dispatchDir, log, optionalTreeView, rootFor, runAnswer, runJson } from "./cli";
import { CheckpointList, parseCheckpoints, parsePlan, parseRestore, PlanRow, RestorePlan, Turn } from "./core/checkpointModel";

const MAX_LISTED = 30;

type Node = { kind: "turn"; turn: Turn; n: number } | { kind: "file"; turn: Turn; path: string } | { kind: "info"; label: string };

export class Checkpoints implements vscode.TreeDataProvider<Node> {
  private list: CheckpointList = { available: false, reason: "loading" };
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly countChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCount = this.countChanged.event;
  private timer: NodeJS.Timeout | undefined;
  private view: vscode.TreeView<Node> | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    // the Checkpoints view is no longer contributed (the Agents window's Changes took its place)
    this.view = optionalTreeView("dispatch.checkpoints", this);
    if (this.view) ctx.subscriptions.push(this.view);
    ctx.subscriptions.push(
      vscode.commands.registerCommand("dispatch.refreshCheckpoints", () => this.refresh()),
      vscode.commands.registerCommand("dispatch.restoreCheckpoint", (n?: Node) => this.restore(n)),
      vscode.commands.registerCommand("dispatch.showCheckpoints", () => vscode.commands.executeCommand("dispatch.checkpoints.focus")),
      { dispose: () => this.timer && clearTimeout(this.timer) },
    );
    const dir = path.join(dispatchDir(), "checkpoints");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, { recursive: true }, (_e, f) => {
        if (!f || String(f).endsWith("turns.json")) this.soon();
      });
      ctx.subscriptions.push({ dispose: () => w.close() });
    } catch (e) {
      log(`checkpoints: cannot watch ${dir}: ${(e as Error).message}`);
    }
    void this.refresh();
  }

  count(): number | undefined {
    return this.list.available ? this.list.turns.length : undefined;
  }

  private soon() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 400);
  }

  async refresh() {
    const root = rootFor();
    if (!root) {
      this.list = { available: false, reason: "no_folder" };
    } else {
      try {
        this.list = parseCheckpoints(await runJson(["checkpoint", "list", "--root", root, "--json"], { timeoutMs: 20000 }));
      } catch (e) {
        this.list = { available: false, reason: (e as CliError).code || "failed" };
        log(`checkpoints: ${(e as Error).message}`);
      }
    }
    if (this.view) this.view.description = this.list.available ? String(this.list.turns.length) : undefined;
    this.changed.fire(undefined);
    this.countChanged.fire();
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      if (!this.list.available) {
        const why = this.list.reason;
        const label =
          why === "loading"
            ? vscode.l10n.t("Loading…")
            : why === "unsupported"
              ? vscode.l10n.t("Checkpoints come with a later Dispatch update.")
              : why === "no_folder"
                ? vscode.l10n.t("Open a folder to see its checkpoints.")
                : vscode.l10n.t("Could not read checkpoints ({0}).", why);
        return [{ kind: "info", label }];
      }
      if (!this.list.turns.length) return [{ kind: "info", label: vscode.l10n.t("No agent turns in this project yet.") }];
      const total = this.list.turns.length;
      return this.list.turns.map((turn, i) => ({ kind: "turn", turn, n: total - i }));
    }
    if (n.kind === "turn") return n.turn.files.map((p) => ({ kind: "file", turn: n.turn, path: p }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "info") return new vscode.TreeItem(n.label);
    if (n.kind === "file") {
      const it = new vscode.TreeItem(n.path);
      const root = rootFor();
      if (root) {
        const uri = vscode.Uri.file(path.join(root, n.path));
        it.resourceUri = uri;
        it.command = { command: "vscode.open", title: "", arguments: [uri] };
      }
      return it;
    }
    const t = n.turn;
    const when = t.ts ? new Date(t.ts * 1000) : undefined;
    const label = vscode.l10n.t("Turn {0}", n.n) + (t.text ? ` · ${t.text.split("\n")[0].slice(0, 60)}` : "");
    const it = new vscode.TreeItem(label, t.files.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    it.description = [when ? when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "", (t.files.length === 1 ? vscode.l10n.t("1 file") : vscode.l10n.t("{0} files", t.files.length))]
      .filter(Boolean)
      .join(" · ");
    it.tooltip = t.files.length ? t.files.join("\n") : undefined;
    it.contextValue = "turn";
    it.iconPath = new vscode.ThemeIcon("history");
    return it;
  }

  /** A dry run first: the modal lists every file the restore touches, later turns' files included
   *  (a restore to before turn N undoes N and everything after it), with the conflicts marked. */
  private async restore(n?: Node) {
    if (!n || n.kind !== "turn") return;
    const root = rootFor();
    if (!root) return;
    const t = n.turn;
    let plan: RestorePlan;
    try {
      plan = parsePlan(await runAnswer(["checkpoint", "restore", "--root", root, "--turn", t.id, "--dry-run", "--json"], { timeoutMs: 120000 }));
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Restore failed: {0}", (e as Error).message));
      return;
    }
    if (!plan.ok) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Restore failed: {0}", plan.message));
      return;
    }
    if (plan.running.length) {
      void vscode.window.showWarningMessage(vscode.l10n.t("An agent is working in this project. Restore once its turn is done (or interrupt it first)."));
      return;
    }
    if (!plan.rows.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t("The project files are already as they were before turn {0}.", n.n));
      return;
    }
    const act = (r: PlanRow) =>
      r.action === "delete" ? vscode.l10n.t("delete") : r.action === "create" ? vscode.l10n.t("recreate") : vscode.l10n.t("revert");
    const why = (r: PlanRow) => (r.unsure ? `  (${vscode.l10n.t("maybe not the agent's")})` : r.conflict ? `  (${vscode.l10n.t("changed later")})` : "");
    const shown = plan.rows.slice(0, MAX_LISTED);
    const detail =
      shown.map((r) => `${act(r)}  ${r.path}${why(r)}`).join("\n") +
      (plan.rows.length > shown.length ? "\n" + vscode.l10n.t("and {0} more", plan.rows.length - shown.length) : "");
    const clean = plan.rows.length - plan.conflicts;
    const all = vscode.l10n.t("Restore all");
    const onlyClean = vscode.l10n.t("Only the {0} without conflicts", clean);
    const go = vscode.l10n.t("Restore");
    const buttons = plan.conflicts ? (clean > 0 ? [onlyClean, all] : [all]) : [go];
    const msg = plan.conflicts
      ? vscode.l10n.t(
          "Restore the project to before turn {0}? {1} files change, later turns included. {2} of them changed after the agent finished or may not be the agent's; \"Restore all\" overwrites or deletes them.",
          n.n,
          plan.rows.length,
          plan.conflicts,
        )
      : vscode.l10n.t("Restore the project to before turn {0}? {1} files change, later turns included.", n.n, plan.rows.length);
    const pick = await vscode.window.showWarningMessage(msg, { modal: true, detail }, ...buttons);
    if (!pick) return;
    await this.doRestore(root, t, n.n, pick === all ? "force" : pick === onlyClean ? "clean" : "plain");
  }

  private async doRestore(root: string, t: Turn, n: number, mode: "plain" | "clean" | "force"): Promise<void> {
    const args = ["checkpoint", "restore", "--root", root, "--turn", t.id, "--json"];
    if (t.sid) args.splice(4, 0, "--sid", t.sid);
    if (mode === "force") args.push("--force");
    if (mode === "clean") args.push("--only-clean");
    let res;
    try {
      res = parseRestore(await runAnswer(args, { timeoutMs: 120000 }));
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Restore failed: {0}", (e as Error).message));
      return;
    }
    if (res.ok) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Restored to before turn {0} ({1} files).", n, res.files.length));
    } else if (res.conflict) {
      // files changed between the dry run and now
      void vscode.window.showWarningMessage(vscode.l10n.t("Files changed again just now; nothing was restored. Look at the list again."));
    } else {
      void vscode.window.showErrorMessage(vscode.l10n.t("Restore failed: {0}", res.message));
    }
    await this.refresh();
  }
}
