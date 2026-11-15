// Status bar: "Dispatch · 3" (live agent sessions, 30 s refresh), "Tab $0.03" (today's completion
// spend; click for the switch and the cap), "Checkpoints 12", "Agent changes 2" (active file).
// Plus the Dispatch › Sessions view.
import * as vscode from "vscode";
import { Checkpoints } from "./checkpoints";
import { log, optionalTreeView, rootFor, runJson } from "./cli";
import { localDayIso, money } from "./core/budget";
import { SessionItem, sessionItems, sessionSummary } from "./core/sessionsModel";
import { Hunks } from "./hunks";
import { signal } from "./signals";
import { TabCompletion } from "./tabCompletion";

const SESSIONS_EVERY_MS = 30_000;

export class Status implements vscode.TreeDataProvider<SessionItem> {
  private sessions = vscode.window.createStatusBarItem("dispatch.sessions", vscode.StatusBarAlignment.Left, 1000);
  private tabItem = vscode.window.createStatusBarItem("dispatch.tab", vscode.StatusBarAlignment.Right, 1000);
  private cpItem = vscode.window.createStatusBarItem("dispatch.checkpoints", vscode.StatusBarAlignment.Left, 999);
  private hunkItem = vscode.window.createStatusBarItem("dispatch.hunks", vscode.StatusBarAlignment.Left, 998);
  private items: SessionItem[] = [];
  private readonly treeChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private capWarned = "";

  constructor(private ctx: vscode.ExtensionContext, private tab: TabCompletion, private cps: Checkpoints, private hunks: Hunks) {
    this.sessions.name = "Dispatch";
    this.sessions.command = "dispatch.showSessions";
    this.tabItem.name = vscode.l10n.t("Dispatch Tab completion");
    this.tabItem.command = "dispatch.tabMenu";
    this.cpItem.name = vscode.l10n.t("Dispatch checkpoints");
    this.cpItem.command = "dispatch.showCheckpoints";
    this.hunkItem.name = vscode.l10n.t("Dispatch agent changes");
    this.hunkItem.command = "dispatch.nextHunk";
    this.sessions.text = "$(rocket) Dispatch";
    this.sessions.show();
    const timer = setInterval(() => void this.refreshSessions(), SESSIONS_EVERY_MS);
    ctx.subscriptions.push(
      this.sessions,
      this.tabItem,
      this.cpItem,
      this.hunkItem,
      { dispose: () => clearInterval(timer) },
      optionalTreeView("dispatch.sessions", this) ?? { dispose: () => undefined },
      vscode.commands.registerCommand("dispatch.showSessions", () => this.pickSession()),
      vscode.commands.registerCommand("dispatch.refreshSessions", () => this.refreshSessions()),
      vscode.commands.registerCommand("dispatch.openSession", (s?: SessionItem) => s && signal("open-session", { key: s.key, root: rootFor() })),
      vscode.commands.registerCommand("dispatch.tabMenu", () => this.tabMenu()),
      vscode.commands.registerCommand("dispatch.toggleTab", () => this.toggleTab()),
      vscode.commands.registerCommand("dispatch.setTabCap", () => this.setCap()),
      tab.onDidChange(() => this.renderTab()),
      cps.onDidChangeCount(() => this.renderCheckpoints()),
      hunks.onDidChange(() => this.renderHunks()),
    );
    void this.refreshSessions();
    this.renderTab();
  }

  async refreshSessions() {
    try {
      const rows = await runJson<unknown>(["sessions", "--json"], { timeoutMs: 20000 });
      this.items = sessionItems(rows, rootFor() || "");
      const s = sessionSummary(this.items);
      this.sessions.text = `$(rocket) Dispatch · ${s.total}`;
      this.sessions.tooltip = vscode.l10n.t("{0} live agent sessions, {1} in this project, {2} working", s.total, s.here, s.working);
      this.sessions.backgroundColor = undefined;
    } catch (e) {
      this.sessions.text = "$(warning) Dispatch";
      this.sessions.tooltip = vscode.l10n.t("The dispatch CLI did not answer: {0}", (e as Error).message);
      log(`sessions: ${(e as Error).message}`);
    }
    this.treeChanged.fire();
  }

  getChildren(el?: SessionItem): SessionItem[] {
    return el ? [] : this.items;
  }

  getTreeItem(s: SessionItem): vscode.TreeItem {
    const it = new vscode.TreeItem(s.label);
    it.description = [s.label.startsWith(s.agent) ? "" : s.agent, s.state === "unknown" ? "" : s.state, s.here ? "" : s.cwd.split("/").pop()]
      .filter(Boolean)
      .join(" · ");
    it.tooltip = `${s.label}\n${s.cwd}\n${s.key}`;
    it.iconPath = new vscode.ThemeIcon(s.state === "working" ? "loading~spin" : "comment-discussion");
    it.command = { command: "dispatch.openSession", title: "", arguments: [s] };
    return it;
  }

  private async pickSession() {
    await this.refreshSessions();
    const pick = await vscode.window.showQuickPick(
      this.items.map((s) => ({ label: s.label, description: `${s.agent} · ${s.state}`, detail: s.cwd, s })),
      { title: vscode.l10n.t("Open a session in Dispatch"), matchOnDetail: true },
    );
    if (pick) await signal("open-session", { key: pick.s.key, root: rootFor() });
  }

  renderTab() {
    const b = this.tab.budget;
    const t = b.today;
    if (!t) {
      this.tabItem.hide();
      return;
    }
    const st = b.state(this.tab.hasKey());
    const spent = money(b.spent());
    this.tabItem.backgroundColor = undefined;
    if (st === "off") {
      this.tabItem.text = "$(circle-slash) Tab";
      this.tabItem.tooltip = vscode.l10n.t("Tab completion is off. Click to turn it on.");
    } else if (st === "no_key") {
      this.tabItem.text = "$(key) Tab";
      this.tabItem.tooltip = vscode.l10n.t("Tab completion needs a DeepSeek API key: add one in the Agents window's Settings › Network (Add a key to OpenCode), or pick Claude or Codex as the Tab model.");
    } else if (st === "over_cap") {
      this.tabItem.text = `$(warning) Tab ${spent}`;
      this.tabItem.tooltip = vscode.l10n.t("Tab completion reached today's cap of {0}. It resumes tomorrow; click to change the cap.", money(b.cap()));
      this.tabItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      // once a day, not on every window that opens while the cap holds
      const day = localDayIso();
      if (this.capWarned !== day && this.ctx.globalState.get("dispatch.tabCapWarned") !== day) {
        this.capWarned = day;
        void this.ctx.globalState.update("dispatch.tabCapWarned", day);
        void vscode.window.showWarningMessage(vscode.l10n.t("Tab completion reached today's cap of {0}. It resumes tomorrow.", money(b.cap())));
      }
    } else {
      this.tabItem.text = `$(sparkle) Tab ${spent}`;
      this.tabItem.tooltip = vscode.l10n.t("Tab completion today: {0} completions, {1} of {2} (estimate at {3} prices)", b.count(), spent, money(b.cap()), "2026-09");
    }
    if (this.tab.lastError && st === "on") this.tabItem.tooltip += "\n" + vscode.l10n.t("Last error: {0}", this.tab.lastError);
    this.tabItem.show();
  }

  private renderCheckpoints() {
    const n = this.cps.count();
    if (n === undefined) {
      this.cpItem.hide();
      return;
    }
    this.cpItem.text = `$(history) ${n}`;
    this.cpItem.tooltip = vscode.l10n.t("{0} checkpoints in this project (one per agent turn)", n);
    this.cpItem.show();
  }

  private renderHunks() {
    const n = this.hunks.activeCount();
    if (!n) {
      this.hunkItem.hide();
      return;
    }
    this.hunkItem.text = `$(sparkle) ${n}`;
    this.hunkItem.tooltip =
      n === 1
        ? vscode.l10n.t("The agent changed this file in 1 place (F7 next, ⌘Y accept, ⌘N undo)")
        : vscode.l10n.t("The agent changed this file in {0} places (F7 next, ⌘Y accept, ⌘N undo)", n);
    this.hunkItem.show();
  }

  private async tabMenu() {
    await this.tab.refresh();
    const b = this.tab.budget;
    const on = !!b.today?.enabled;
    type Item = vscode.QuickPickItem & { run: () => Promise<unknown> };
    const items: Item[] = [
      { label: on ? vscode.l10n.t("$(circle-slash) Turn Tab completion off") : vscode.l10n.t("$(sparkle) Turn Tab completion on"), run: () => this.toggleTab() },
      { label: vscode.l10n.t("$(dashboard) Daily cap: {0}", money(b.cap())), description: vscode.l10n.t("change"), run: () => this.setCap() },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Tab completion · today {0} completions, {1}", b.count(), money(b.spent())),
    });
    if (pick) await pick.run();
  }

  private async toggleTab() {
    const on = !this.tab.budget.today?.enabled;
    if (on && !this.tab.hasKey()) {
      await this.tab.loadKey();
      if (!this.tab.hasKey()) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Tab completion needs a DeepSeek API key: add one in the Agents window's Settings › Network (Add a key to OpenCode), or pick Claude or Codex as the Tab model."));
        return;
      }
    }
    try {
      await this.tab.setEnabled(on);
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  }

  private async setCap() {
    const cur = this.tab.budget.cap();
    const v = await vscode.window.showInputBox({
      title: vscode.l10n.t("Tab completion daily cap (USD)"),
      prompt: vscode.l10n.t("0 means no cap. Requests stop for the day once today's spend reaches it."),
      value: String(cur),
      validateInput: (s) => (/^\d+(\.\d+)?$/.test(s.trim()) ? undefined : vscode.l10n.t("A number of dollars, e.g. 0.5")),
    });
    if (v === undefined) return;
    try {
      await this.tab.setCap(Number(v.trim()));
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  }
}
