// dispatch-bridge: the VS Code extension that ties the full IDE (code-server inside Dispatch) to
// Dispatch. Everything goes through the `dispatch` CLI and files under ~/tasks/.dispatch; no port of
// its own (design/full-ide/PLAN.md §2.3).
import * as fs from "fs";
import * as vscode from "vscode";
import { Checkpoints } from "./checkpoints";
import { idePath, log, rootFor, run, setLog } from "./cli";
import { Hunks } from "./hunks";
import { InlineEdit } from "./inlineEdit";
import { Recommend } from "./recommend";
import { registerCodeSearch, Search } from "./search";
import { openedByDispatch } from "./chatPanel";
import { NativeChat } from "./nativeChat";
import { applyIdeDefaults } from "./defaults";
import { registerLife } from "./life";
import { registerDocs } from "./docs";
import { registerFixit } from "./fixit";
import { registerAttribution } from "./attribution";
import { registerEditorSettings, watchSettingsRequests } from "./editorSettings";
import { registerDispatchDir } from "./dispatchDir";
import { registerCustomizations } from "./customizations";
import { registerKnowledge } from "./knowledge";
import { isNative, registerSignals } from "./signals";
import { Status } from "./status";
import { registerSwitchAgent } from "./switchAgent";
import { registerClaudeAccount } from "./claudeAccount";
import { registerWaiting } from "./waiting";
import { registerInbox } from "./inbox";
import { registerOnboarding } from "./onboarding";
import { registerProjects } from "./projects";
import { registerTasks } from "./tasks";
import { registerBoard } from "./board";
import { registerNow } from "./now";
import { registerOpenCommit } from "./commit";
import { registerEngines } from "./engines";
import { registerNet } from "./net";
import { registerSoul } from "./soul";
import { registerKeys } from "./keys";
import { registerPointTalk } from "./pointTalk";
import { registerTerminal } from "./terminal";
import { registerHistory, registerHistoryWindow } from "./history";
import { registerSlash } from "./slash";
import { registerIdeShow } from "./ideShow";
import { registerUsage } from "./usage";
import { registerAutomations } from "./automations";
import { registerMachines } from "./machines";
import { registerMobile } from "./mobile";
import { registerAccounts } from "./accounts";
import { registerBuilds } from "./builds";
import { registerBusy } from "./busy";
import { registerTurbo } from "./turbo";
import { registerMe } from "./me";
import { registerAssistant } from "./assistant";
import { registerCapture } from "./capture";
import { registerOpenCode } from "./opencode";
import { registerSettingsPage } from "./settingsPage";
import { registerStar } from "./star";
import { TabCompletion } from "./tabCompletion";

let tab: TabCompletion | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Dispatch");
  ctx.subscriptions.push(out);
  setLog(out);
  // the Agents window's Docs tab (and nothing stops the editor window from asking)
  step("docs", () => registerDocs(ctx));
  step("fixit", () => registerFixit(ctx));
  // who wrote which changed line: the Agents window's Changes and diffs
  step("attribution", () => registerAttribution(ctx));
  step("life", () => registerLife(ctx));
  log(`activate: DISPATCH_BIN=${process.env.DISPATCH_BIN || "-"} sid=${process.env.DISPATCH_IDE_SID || "-"} PATH=${process.env.PATH || "-"}`);
  if (isAgentsWindow()) return activateAgentsWindow(ctx);
  step("editor window", () => registerEditorWindow(ctx));
  // a window the History tab opened to continue a session (Open in New Window): its terminal picks it up
  step("history window", () => registerHistoryWindow(ctx));
  // Dispatch IDE (our Code - OSS build): the chat is VS Code's own chat view (nativeChat.ts); our webview
  // column (chatPanel.ts) is no longer registered
  const chat = step("native chat", () => (isNative() ? new NativeChat(ctx) : undefined));
  step("inline edit", () => new InlineEdit(ctx));
  const hunks = step("hunks", () => new Hunks(ctx)) ?? inertHunks(ctx);
  const cps = step("checkpoints", () => new Checkpoints(ctx)) ?? inertCheckpoints(ctx);
  step("search", () => new Search(ctx));
  // the folders Dispatch opened skip Restricted Mode
  void vscode.commands.executeCommand("setContext", "dispatch.native", !!chat);
  step("signals", () => registerSignals(ctx, chat));
  if (chat) {
    // Dispatch IDE's own defaults: the Dispatch themes following the system, fonts, icons (5A.2)
    void applyIdeDefaults(ctx);
    const root = rootFor();
    if (!vscode.workspace.isTrusted && openedByDispatch(root)) void vscode.commands.executeCommand("_dispatch.trustFolders", [root]).then(undefined, (e: Error) => log(`trust: ${e.message}`));
  }
  tab = step("tab completion", () => new TabCompletion(ctx));
  if (tab) step("status", () => new Status(ctx, tab!, cps, hunks));
  await tab?.start().catch((e: Error) => log(`activate: tab completion start failed: ${e.message}`));
  const rec = step("recommend", () => new Recommend(ctx));
  if (rec) setTimeout(() => void rec.check(), 4000);
}

/**
 * One piece of the activation. A piece that throws (a bare PATH from the Dock, a shell environment that timed
 * out, a missing file) is logged and skipped: the others still register, so one broken part does not leave the
 * window with "command 'dispatch.tasks' not found" everywhere.
 */
function step<T>(name: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    log(`activate: ${name} failed: ${(e as Error)?.stack || e}`);
    return undefined;
  }
}

/** Stand-ins for the editor parts Status reads, when they did not start (or in the Agents window). */
function inertHunks(ctx: vscode.ExtensionContext): Hunks {
  const none = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(none);
  return { onDidChange: none.event, activeCount: () => 0 } as unknown as Hunks;
}
function inertCheckpoints(ctx: vscode.ExtensionContext): Checkpoints {
  const none = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(none);
  return { onDidChangeCount: none.event, count: () => undefined } as unknown as Checkpoints;
}

export async function deactivate() {
  await tab?.dispose();
}


// ---- the Agents window (design/copilot-app §8.5 B) ----------------------------------------------
// Dispatch Agent is Dispatch IDE's own Agents window. There the bridge keeps the status item, the
// sessions list and its commands; hunks, Tab completion and ⌘K belong to the editor. ⌘E goes back
// and forth: the editor → the Agents window (workbench.action.openAgentsWindow), the Agents window →
// the editor on the active session's folder.

const REQUEST_FRESH_S = 30; // an agents-request older than this is stale

/** vscode.workspace.isAgentSessionsWorkspace (proposal agentSessionsWorkspace); false where the
 *  proposal is not enabled for us. */
export function isAgentsWindow(): boolean {
  try {
    return !!(vscode.workspace as unknown as { isAgentSessionsWorkspace?: boolean }).isAgentSessionsWorkspace;
  } catch {
    return false;
  }
}

function activateAgentsWindow(ctx: vscode.ExtensionContext) {
  log("activate: Agents window");
  // the Agents window's own first-run defaults (ide-defaults.json "agents": AI features on, no GitHub,
  // Codex, no VS Code easter egg); before this the early return above skipped them
  void applyIdeDefaults(ctx);
  void vscode.commands.executeCommand("setContext", "dispatch.agentsWindow", true);
  // Status wants the editor parts for its Tab / checkpoint / hunk items: here they are inert
  // (TabCompletion never starts, no checkpoints, no hunks), so only the sessions item shows.
  // Every piece on its own (step): one that throws does not keep the others from registering.
  step("status", () => new Status(ctx, new TabCompletion(ctx), inertCheckpoints(ctx), inertHunks(ctx)));
  step("open editor window", () => ctx.subscriptions.push(vscode.commands.registerCommand("dispatch.openEditorWindow", () => openEditorWindow())));
  // the harness chip of a running session (Dispatch IDE patches/250-switch-harness.patch)
  step("switch agent", () => registerSwitchAgent(ctx));
  // the account menu's Claude section (Dispatch IDE patches/290-accounts.patch)
  step("claude account", () => registerClaudeAccount(ctx));
  // the sessions picker's In codebase group (Dispatch IDE patches/350-codebase-search.patch)
  step("code search", () => registerCodeSearch(ctx));
  // the board's changes pushed by chatd's board service: the board views refresh on a change, not on a timer (patches/dispatch-board-push.patch)
  step("board", () => registerBoard(ctx));
  // Waiting for you: the badge next to Sessions and its page (patches/425-waiting.patch)
  step("waiting", () => registerWaiting(ctx));
  // the bell in the title bar and who is asleep (patches/470-notifications.patch)
  step("inbox", () => registerInbox(ctx));
  // Projects: the sidebar's project groups, the Projects page and a project's page (patches/sessions-projects.patch)
  step("projects", () => registerProjects(ctx));
  // First-run setup wizard and Migrations (patches/505-onboarding.patch)
  step("onboarding", () => registerOnboarding(ctx));
  // Tasks: the right panel's Tasks tab, the Task graph page and task pages (patches/430-tasks.patch, 430-tasks.patch)
  step("tasks", () => registerTasks(ctx));
  // Now: the right panel's Now tab, what a session is doing (patches/410-now.patch)
  step("now", () => registerNow(ctx));
  step("open commit", () => registerOpenCommit(ctx));
  // Customizations → Knowledge: wiki and facts (patches/525-knowledge.patch)
  step("knowledge", () => registerKnowledge(ctx));
  // Customizations → Editor: Tab completion and ⌘K settings (patches/530-editor-settings.patch)
  step("editor settings", () => registerEditorSettings(ctx));
  // Customizations → Overview's Find skills, Claude's Sub-agent effort (~/.dispatch, patches/515-customizations.patch, 515-customizations.patch)
  step("dispatch dir", () => registerDispatchDir(ctx));
  // the helper agents that come with Dispatch (engineer, tester, researcher, designer…): an update brings their new
  // version and new ones to a Mac that went through setup; a file of the same name stays (cli/builtin_agents.py)
  step("builtin agents", () => setTimeout(() => void run(["builtin-agents", "sync", "--if-set-up", "--json"], { timeoutMs: 30000 })
    .then(r => log(`builtin agents: ${r.code === 0 ? "synced" : (r.stderr || r.stdout).trim().slice(-300)}`), (e: Error) => log(`builtin agents: ${e.message}`)), 5000));
  // Dispatch's MCP server (cli/dispatch_mcp.py): the board's tools for Claude Code, Codex and OpenCode. Setup adds it; this
  // brings it to a Mac set up before, to an agent installed since, and moves it along with the app (its path is in the entry)
  step("dispatch tools", () => setTimeout(() => void run(["mcp", "register", "--if-set-up", "--json"], { timeoutMs: 30000 })
    .then(r => log(`dispatch tools: ${r.code === 0 ? r.stdout.replace(/\s+/g, " ").slice(0, 400) : (r.stderr || r.stdout).trim().slice(-300)}`), (e: Error) => log(`dispatch tools: ${e.message}`)), 4000));
  // Dispatch's one hook entry in Claude Code and Codex (cli/hooks_setup.py): an update replaces the hooks an older
  // version wrote, moves the entry along with the app, and has Codex trust it again (it runs only trusted hooks); it
  // only touches a file that already has a Dispatch hook, so a Mac that never went through setup gets nothing
  step("dispatch hooks", () => setTimeout(() => void run(["hooks", "sync", "--json"], { timeoutMs: 90000 })
    .then(r => log(`dispatch hooks: ${r.code === 0 ? r.stdout.replace(/\s+/g, " ").slice(0, 400) : (r.stderr || r.stdout).trim().slice(-300)}`), (e: Error) => log(`dispatch hooks: ${e.message}`)), 6000));
  // Dispatch's rules and Soul in every agent (cli/soul.py): after an update the new dispatch.md, and a newer default
  // Soul the person never changed, reach the agents; only on a Mac whose agents already have Dispatch's block
  step("dispatch rules", () => setTimeout(() => void run(["rules", "sync", "--if-set-up", "--json"], { timeoutMs: 60000 })
    .then(r => log(`dispatch rules: ${r.code === 0 ? r.stdout.replace(/\s+/g, " ").slice(0, 400) : (r.stderr || r.stdout).trim().slice(-300)}`), (e: Error) => log(`dispatch rules: ${e.message}`)), 8000));
  step("customizations", () => registerCustomizations(ctx));
  // Customizations → Claude / Codex: the Version row and its Update (patches/515-customizations.patch)
  step("engines", () => registerEngines(ctx));
  step("net", () => registerNet(ctx));
  step("soul", () => registerSoul(ctx));
  // Settings › Keys and the "Key saved" toast (keys.ts)
  step("keys", () => registerKeys(ctx));
  // Point and talk: the Soniox key, a temporary key for the live words, a whole recording transcribed (pointTalk.ts)
  step("point talk", () => registerPointTalk(ctx));
  // the Agents window's terminal: agents that can run in it, the Ghostty look (patches/610-terminal.patch)
  step("terminal", () => registerTerminal(ctx));
  // the right panel's History tab: every session on this Mac, nothing imported (patches/450-history.patch)
  step("history", () => registerHistory(ctx));
  step("slash", () => registerSlash(ctx));
  // `dispatch ide show` / `task deliver --show`: a deliverable opens in the right panel (patches/435-docs.patch)
  step("ide show", () => registerIdeShow(ctx));
  // the account menu's Usage page (patches/460-usage.patch)
  step("usage", () => registerUsage(ctx));
  // the Automations page's jobs from other apps (patches/455-automations.patch)
  step("automations", () => registerAutomations(ctx));
  // the title bar's Machines menu (patches/285-machines.patch)
  step("machines", () => registerMachines(ctx));
  // the title bar's phone pairing popover (patches/465-mobile.patch)
  step("mobile", () => registerMobile(ctx));
  // the title bar's usage strip and Accounts panel: several Claude and Codex accounts, switched in one step (patches/290-accounts.patch)
  step("accounts", () => registerAccounts(ctx));
  // the Agents window's bottom bar: the build queue as blocks, its panel and a build's log (patches/120-status-bar.patch)
  step("builds", () => registerBuilds(ctx));
  step("busy", () => registerBusy(ctx));
  // Turbo: the Timeline page and the switch on a new chat's page (patches/420-turbo.patch)
  step("turbo", () => registerTurbo(ctx));
  // the title bar's picture: your GitHub account (patches/110-title-bar.patch)
  step("me", () => registerMe(ctx));
  // the first suggestions on a new chat's page read `dispatch assistant` (dispatchFirstPrompts.ts)
  step("assistant", () => registerAssistant(ctx));
  // what is asked for in a chat goes on the board by itself and lines up (patches/dispatch-capture.patch)
  step("capture", () => registerCapture(ctx));
  // Customizations → OpenCode, the account panel's OpenCode section (patches/220-opencode.patch, 220-opencode.patch)
  step("opencode", () => registerOpenCode(ctx));
  // the Settings page (⌘,): its notification switches, and the Keep awake mode (held by chatd while agents work) (patches/510-settings.patch)
  step("settings page", () => registerSettingsPage(ctx));
  // asking once for a GitHub star, after a week of use (kanban app/cli/star.py)
  step("star", () => registerStar(ctx));
}

/** The editor on the folder of the Agents window's active session (the window mounts it as its
 *  workspace folder); the window that already has it comes forward. No session: a new window. */
async function openEditorWindow() {
  try {
    await vscode.commands.executeCommand("agents.openSessionInVSCode");
  } catch (e) {
    log(`openEditorWindow: ${(e as Error).message}`);
  }
}

/** The editor window's ⌘E: the Agents window (it keeps a draft typed in the chat and picks this
 *  window's folder, as ⌘⇧A does). */
function registerEditorWindow(ctx: vscode.ExtensionContext) {
  // the Accounts menu's Claude login (Dispatch IDE patches/820-editor-accounts-menu.patch), same as the Agents window's
  registerClaudeAccount(ctx);
  // and OpenCode's providers (patches/220-opencode.patch)
  registerOpenCode(ctx);
  registerCodeSearch(ctx);
  // the title bar's machine button (patches/285-machines.patch) is in editor windows too, the one on
  // another Mac included: there it lists the machines as that Mac sees them
  step("machines", () => registerMachines(ctx));
  step("mobile", () => registerMobile(ctx));
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.openAgentsWindow", () =>
      vscode.commands.executeCommand("workbench.action.openAgentsWindow").then(undefined, (e: Error) => log(`openAgentsWindow: ${e.message}`)),
    ),
  );
  watchAgentsRequests(ctx);
  // Tab completion and ⌘K live in this window's Settings now (Dispatch IDE patches/530-editor-settings.patch)
  step("editor settings", () => registerEditorSettings(ctx, () => void tab?.refresh(true)));
  watchSettingsRequests(ctx);
}

/** `dispatch ide agents --root DIR` leaves ide/agents-request. The Agents window has no command that
 *  takes a folder (only the main process's openAgentsWindow does, reached from an editor window), so
 *  an editor window carries it out: the first one to rename the file away takes it. */
function watchAgentsRequests(ctx: vscode.ExtensionContext) {
  const file = idePath("agents-request");
  const check = () => {
    const mine = `${file}.${process.pid}`;
    try {
      fs.renameSync(file, mine);
    } catch {
      return; // none, or another window took it
    }
    let rec: { root?: unknown; at?: unknown };
    try {
      rec = JSON.parse(fs.readFileSync(mine, "utf8"));
      fs.rmSync(mine, { force: true });
    } catch {
      return;
    }
    if (typeof rec.root !== "string" || typeof rec.at !== "number" || Date.now() / 1000 - rec.at > REQUEST_FRESH_S) return;
    log(`agents-request ${rec.root}`);
    void vscode.commands.executeCommand("workbench.action.openAgentsWindow", { folderUri: vscode.Uri.file(rec.root) }).then(undefined, (e: Error) => log(`agents-request: ${e.message}`));
  };
  fs.watchFile(file, { interval: 500 }, check);
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file, check) });
  check(); // a request written before this window was up (watchFile only reports changes)
}
