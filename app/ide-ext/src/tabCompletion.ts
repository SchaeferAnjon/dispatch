// Tab completion: grey ghost text from DeepSeek FIM, called straight from the extension host
// (a completion has to arrive in a few hundred ms; chatd is not on this path), or from Claude / Codex
// on the person's subscription through `dispatch ide complete` when ide_tab_model says claude:… /
// codex:… (slower, free here). On by default, daily cap in dollars, every request appended to
// ~/tasks/.dispatch/ide/tab-usage.jsonl and folded into the ledger by `dispatch ide usage add` once a
// minute (PLAN.md §3.2).
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { idePath, localPath, log, rootFor, runJson, runText } from "./cli";
import { Budget, localDayIso, money, UsageToday } from "./core/budget";
import { buildFimRequest, cleanCompletion, FIM_URL, shouldTrigger } from "./core/fim";
import { fimCall } from "./core/fimCall";
import { viaSubscription } from "./core/editorSettings";
import { settingValue, TAB_DELAY } from "./core/settingNames";

const FOLD_EVERY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8000;
// Claude / Codex (the subscription, `dispatch ide complete`): a CLI start per completion, so wait for a
// longer pause in typing and give it longer to answer
const SUBSCRIPTION_DEBOUNCE_MS = 700;
const SUBSCRIPTION_TIMEOUT_MS = 45000;

export class TabCompletion implements vscode.InlineCompletionItemProvider {
  readonly budget = new Budget();
  private key = "";
  private keyLoaded = false;
  private pending = 0;
  private cache = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private foldTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  lastError = "";

  constructor(private ctx: vscode.ExtensionContext) {}

  async start() {
    await Promise.all([this.loadKey(), this.refresh()]);
    // fold what this window spent, or at least pick up a switch / cap changed in Dispatch's settings
    this.foldTimer = setInterval(() => void (this.pending ? this.fold() : this.refresh()), FOLD_EVERY_MS);
    this.ctx.subscriptions.push({ dispose: () => this.foldTimer && clearInterval(this.foldTimer) });
    this.ctx.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, this));
    void this.askOnce();
  }

  /** Whether completions can go out: DeepSeek needs its key, Claude and Codex run on the subscription. */
  hasKey(): boolean {
    return !!this.key || viaSubscription(this.budget.model());
  }

  /** DEEPSEEK_API_KEY: the host environment first (tests, a key set for code-server), then `dispatch ide tab-key`
   *  (`dispatch env`, else the DeepSeek key OpenCode already has). */
  async loadKey() {
    this.key = process.env.DEEPSEEK_API_KEY || (await runText(["ide", "tab-key"], { timeoutMs: 10000 }));
    this.keyLoaded = true;
    this.changed.fire();
  }

  /** Re-read today's spend, the switch and the cap from the CLI (the ledger is the truth). */
  refresh(force = false): Promise<void> {
    // after a settings change an answer already in flight may predate it: queue one more
    if (this.refreshing) return force ? this.refreshing.then(() => this.refresh()) : this.refreshing;
    this.refreshing = (async () => {
      try {
        const t = await runJson<UsageToday>(["ide", "usage", "today", "--json"], { timeoutMs: 15000 });
        this.budget.setToday(t);
        log(`tab: ${t.enabled ? "on" : "off"}, today ${t.count} × = $${t.usd} of cap $${t.cap_usd}`);
      } catch (e) {
        log(`usage today failed: ${(e as Error).message}`);
      } finally {
        this.refreshing = undefined;
        this.changed.fire();
      }
    })();
    return this.refreshing;
  }

  /** Fold tab-usage.jsonl into the per-day ledger (and summarize's usage record). */
  async fold() {
    if (this.pending === 0 && !this.budget.stale(localDayIso())) return;
    this.pending = 0;
    try {
      const t = await runJson<UsageToday>(["ide", "usage", "add", "--json"], { timeoutMs: 20000 });
      this.budget.setToday(t);
      this.changed.fire();
    } catch (e) {
      log(`usage add failed: ${(e as Error).message}`);
    }
  }

  async setEnabled(on: boolean) {
    if (on && !this.key) await this.loadKey();
    await this.saveSetting({ ide_tab_completion: on ? 1 : 0 }, { enabled: on });
  }

  async setCap(usd: number) {
    await this.saveSetting({ ide_tab_daily_cap_usd: usd }, { cap_usd: usd });
  }

  /** Takes effect here at once; `dispatch settings --save` (seconds: it writes the board) runs behind. */
  private async saveSetting(setting: Record<string, number>, patch: Parameters<Budget["patch"]>[0]) {
    this.budget.patch(patch);
    this.changed.fire();
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Saving the setting in Dispatch…") }, () =>
        runJson(["settings", "--save", "--json"], { input: JSON.stringify(setting), timeoutMs: 60000 }),
      );
    } finally {
      await this.refresh(true);
    }
  }

  /** With a key and the switch off, ask once whether to turn it on (PLAN.md §3.2). */
  private async askOnce() {
    if (!this.key || this.budget.today?.enabled || this.ctx.globalState.get("dispatch.tabAsked")) return;
    await this.ctx.globalState.update("dispatch.tabAsked", true);
    const on = vscode.l10n.t("Turn on");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t("Tab completion with DeepSeek is available (about $0.0005 per completion, capped at {0} a day). Turn it on?", money(this.budget.cap())),
      on,
      vscode.l10n.t("Not now"),
    );
    if (pick === on) await this.setEnabled(true);
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const sub = viaSubscription(this.budget.model());
    if (!this.budget.today?.enabled || (!sub && (!this.keyLoaded || !this.key))) return;
    const file = localPath(doc.uri);
    if (!file || doc.lineCount > 50000) return;
    if (this.budget.stale(localDayIso())) await this.refresh();
    if (this.budget.overCap()) {
      this.changed.fire();
      return;
    }
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const explicit = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const req = buildFimRequest({ relPath: relTo(rootFor(doc.uri), file), languageId: doc.languageId, text, offset }, this.budget.model());
    if (!shouldTrigger(req.linePrefix, req.lineSuffix, explicit)) return;
    const cacheKey = `${doc.uri.toString()}@${doc.version}:${offset}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) return hit ? [new vscode.InlineCompletionItem(hit, new vscode.Range(pos, pos))] : undefined;

    const debounce = sub ? SUBSCRIPTION_DEBOUNCE_MS : (settingValue<number>((k) => vscode.workspace.getConfiguration("dispatch").get<number>(k), TAB_DELAY) ?? 250);
    if (!explicit) {
      await new Promise((r) => setTimeout(r, debounce));
      if (token.isCancellationRequested) return;
    }
    if (sub) return this.viaCli(doc, pos, req, cacheKey, token, file);
    const r = await fimCall({
      url: process.env.DISPATCH_TAB_ENDPOINT || FIM_URL,
      key: this.key,
      body: req.body,
      budget: this.budget,
      cancelled: () => token.isCancellationRequested,
      onCancel: (fn) => {
        const sub = token.onCancellationRequested(fn);
        return () => sub.dispose();
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      record: (u) => this.record({ ts: Date.now() / 1000, ...u, model: this.budget.model(), lang: doc.languageId }),
    });
    if (r.kind === "over_cap") {
      this.changed.fire();
      return;
    }
    if (r.kind === "http" || r.kind === "error") {
      this.lastError = r.kind === "http" ? `HTTP ${r.status}: ${r.body.slice(0, 200)}` : r.message;
      log(`tab: ${this.lastError}`);
      this.changed.fire();
      return;
    }
    if (r.kind !== "ok") return;
    this.lastError = "";
    const out = cleanCompletion(r.text, req.lineSuffix, req.multiline);
    this.remember(cacheKey, out);
    log(`tab: ${r.usage.prompt_tokens}+${r.usage.completion_tokens} tok (${r.usage.cached_tokens} cached) ${money(r.usd)} → ${JSON.stringify(out.slice(0, 60))}`);
    if (!out || token.isCancellationRequested) return;
    return [new vscode.InlineCompletionItem(out, new vscode.Range(pos, pos))];
  }

  /** One completion from Claude or Codex through `dispatch ide complete`; free here (the subscription), counted. */
  private async viaCli(doc: vscode.TextDocument, pos: vscode.Position, req: ReturnType<typeof buildFimRequest>, cacheKey: string, token: vscode.CancellationToken, file: string) {
    const cts = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => cts.cancel());
    try {
      const input = JSON.stringify({ prefix: req.body.prompt, suffix: req.body.suffix, language: doc.languageId, path: relTo(rootFor(doc.uri), file), multiline: req.multiline });
      const r = await runJson<{ text: string; model: string }>(["ide", "complete", "--json"], { input, timeoutMs: SUBSCRIPTION_TIMEOUT_MS, token: cts.token });
      this.record({ ts: Date.now() / 1000, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, usd: 0, model: this.budget.model(), lang: doc.languageId });
      this.lastError = "";
      const out = cleanCompletion(r.text || "", req.lineSuffix, req.multiline);
      this.remember(cacheKey, out);
      log(`tab: ${r.model} → ${JSON.stringify(out.slice(0, 60))}`);
      if (!out || token.isCancellationRequested) return;
      return [new vscode.InlineCompletionItem(out, new vscode.Range(pos, pos))];
    } catch (e) {
      if (token.isCancellationRequested) return;
      this.lastError = (e as Error).message;
      log(`tab: ${this.lastError}`);
      this.changed.fire();
      return;
    } finally {
      sub.dispose();
      cts.dispose();
    }
  }

  private remember(k: string, v: string) {
    this.cache.set(k, v);
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** One line per request, appended without starting a process; `usage add` folds it later. */
  private record(rec: Record<string, unknown>) {
    try {
      const p = idePath("tab-usage.jsonl");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, JSON.stringify(rec) + "\n");
    } catch (e) {
      log(`tab ledger write failed: ${(e as Error).message}`);
    }
    this.budget.add(rec.usd as number);
    this.pending += 1;
    this.changed.fire();
  }

  async dispose() {
    await this.fold();
  }
}

function relTo(root: string | undefined, file: string): string {
  if (!root) return path.basename(file);
  const r = path.relative(root, file);
  return r.startsWith("..") ? path.basename(file) : r.split(path.sep).join("/");
}
