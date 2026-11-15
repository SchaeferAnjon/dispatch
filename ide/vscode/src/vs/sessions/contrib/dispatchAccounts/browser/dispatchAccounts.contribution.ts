/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchAccounts.css';

import * as DOM from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

// Dispatch IDE: several Claude Code and Codex accounts on this Mac (kanban task-y9u8). The bottom bar always shows
// how much of its allowance the account in use has left (contrib/dispatchStatusBar, kanban task-in8g); the panel behind
// it switches to another saved account in one step, or signs in to one more. When a session stops on a limit, a
// notification offers to switch and go on. Everything goes through the bridge's `dispatch.accounts` command
// (kanban app/ide-ext/src/accounts.ts), which runs `dispatch accounts` (app/cli/accounts.py). How the accounts
// are kept apart and swapped is ported from Orca (MIT); this file is the look, which is Dispatch's own.

const POLL_MS = 30_000;
const ASK_MS = 45_000;
const WARN_AT = 80;

export type Engine = 'claude' | 'codex';
export type Level = 'ok' | 'warn' | 'out' | 'unknown';

export interface IWindow {
	readonly kind: 'session' | 'weekly' | 'weekly_model' | string;
	readonly used_percent: number;
	readonly resets_at?: number | null;
	/** The reset time the way people say it: 18:00, Mon 08:00, Oct 6. */
	readonly resets?: string;
	readonly model?: string;
}

export interface IEngineStatus {
	readonly engine: Engine;
	readonly name: string;
	readonly signed_in: boolean;
	readonly account?: { readonly id?: string; readonly name: string; readonly email?: string; readonly plan?: string; readonly needs_signin?: boolean; readonly unsaved?: boolean } | null;
	readonly windows: readonly IWindow[];
	readonly usage_at?: number | null;
	readonly level: Level;
	readonly line: string;
	readonly others: readonly { readonly id: string; readonly name: string; readonly short?: string; readonly level?: Level; readonly needs_signin?: boolean; readonly top?: IWindow | null }[];
}

interface ILimit {
	readonly engine: Engine;
	readonly session: string;
	readonly message: string;
	readonly held: boolean;
	readonly switch_to?: { readonly id: string; readonly name: string } | null;
}

interface IWatch {
	readonly engines: readonly IEngineStatus[];
	readonly limits: readonly ILimit[];
}

interface IAccountRow {
	readonly id: string;
	readonly engine: Engine;
	readonly name: string;
	readonly email?: string;
	readonly plan?: string;
	readonly needs_signin?: boolean;
	readonly unsaved?: boolean;
	readonly active: boolean;
	readonly windows: readonly IWindow[];
	readonly usage_at?: number | null;
	readonly level: Level;
	readonly short?: string;
}

interface IEngineList {
	readonly engine: Engine;
	readonly name: string;
	readonly signed_in: boolean;
	readonly accounts: readonly IAccountRow[];
	readonly keyring?: boolean;
}

interface IAnswer {
	readonly ok?: boolean;
	readonly message?: string;
}

/** The CLI said no (`{ok: false, message}`): the message, or '' when it gave none. Undefined when it did not. */
function refusal(x: unknown): string | undefined {
	return !!x && typeof x === 'object' && (x as IAnswer).ok === false ? ((x as IAnswer).message ?? '') : undefined;
}

export function engineIcon(engine: Engine): ThemeIcon {
	return engine === 'codex' ? Codicon.openai : Codicon.claude;
}

export function engineName(engine: Engine): string {
	return engine === 'codex' ? localize('dispatchAccounts.codex', "Codex") : localize('dispatchAccounts.claude', "Claude");
}

/** "5h", "wk", "Fable wk": the short names the title bar uses. */
function shortWindow(w: IWindow): string {
	if (w.kind === 'session') {
		return localize('dispatchAccounts.short5h', "5h");
	}
	if (w.kind === 'weekly') {
		return localize('dispatchAccounts.shortWeek', "wk");
	}
	return w.model && /^[\x20-\x7e]+$/.test(w.model) ? localize('dispatchAccounts.shortModelWeek', "{0} wk", w.model) : localize('dispatchAccounts.shortOtherWeek', "model wk");
}

/** "5-hour", "Weekly", "Fable · weekly": the names the panel uses (as the account panel's limit rows do). */
export function longWindow(w: IWindow): string {
	if (w.kind === 'session') {
		return localize('dispatchAccounts.long5h', "5-hour");
	}
	if (w.kind === 'weekly') {
		return localize('dispatchAccounts.longWeek', "Weekly");
	}
	return w.model && /^[\x20-\x7e]+$/.test(w.model) ? localize('dispatchAccounts.longModelWeek', "{0} · weekly", w.model) : localize('dispatchAccounts.longOtherWeek', "Model · weekly");
}

export function pct(w: IWindow): number {
	return Math.max(0, Math.min(100, Math.round(w.used_percent)));
}

function windowLevel(w: IWindow): Level {
	const p = pct(w);
	return p >= 100 ? 'out' : p >= WARN_AT ? 'warn' : 'ok';
}

/** The windows still running (a window past its reset time says nothing about now), weekly model windows only
 *  when they are the ones running out. */
export function liveWindows(windows: readonly IWindow[]): IWindow[] {
	const now = Date.now() / 1000;
	const live = windows.filter(w => typeof w.used_percent === 'number' && !(w.resets_at && w.resets_at < now));
	const order = (w: IWindow) => w.kind === 'session' ? 0 : w.kind === 'weekly' ? 1 : 2;
	return live.filter(w => w.kind === 'session' || w.kind === 'weekly' || windowLevel(w) !== 'ok').sort((a, b) => order(a) - order(b));
}

export function ago(epochSeconds: number | null | undefined): string {
	if (!epochSeconds) {
		return '';
	}
	const m = Math.max(0, Math.round((Date.now() / 1000 - epochSeconds) / 60));
	if (m < 60) {
		return localize('dispatchAccounts.agoMinutes', "{0} min ago", m);
	}
	const h = Math.round(m / 60);
	return h < 48 ? localize('dispatchAccounts.agoHours', "{0} h ago", h) : localize('dispatchAccounts.agoDays', "{0} days ago", Math.round(h / 24));
}

// ---- what the title bar and the panel share: one poll per window ----------------------------------------

export class AccountsModel extends Disposable {

	private static instance: AccountsModel | undefined;

	static get(commandService: ICommandService): AccountsModel {
		if (!AccountsModel.instance) {
			AccountsModel.instance = new AccountsModel(commandService);
		}
		return AccountsModel.instance;
	}

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidStop = this._register(new Emitter<ILimit>());
	/** A session stopped on a limit (each stop once, across windows: the CLI hands each one out once). */
	readonly onDidStop: Event<ILimit> = this._onDidStop.event;

	engines: readonly IEngineStatus[] | undefined;
	/** The last ask failed (the bridge is not there, the CLI did not answer). */
	failed = false;
	private busy = false;
	private timer: number | undefined;

	private constructor(private readonly commandService: ICommandService) {
		super();
	}

	start(): void {
		if (this.timer !== undefined) {
			return;
		}
		this.timer = mainWindow.setInterval(() => void this.refresh(), POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(this.timer)));
		void this.refresh();
	}

	ask<T>(op: string, ...args: unknown[]): Promise<T | undefined> {
		return raceTimeout(this.commandService.executeCommand<T>('dispatch.accounts', op, ...args), ASK_MS);
	}

	async refresh(): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		try {
			const w = await this.ask<IWatch>('watch');
			if (!w || refusal(w) !== undefined || !Array.isArray(w.engines)) {
				this.failed = true;
			} else {
				this.failed = false;
				this.engines = w.engines;
				for (const stop of w.limits ?? []) {
					this._onDidStop.fire(stop);
				}
			}
		} catch {
			this.failed = true;
		} finally {
			this.busy = false;
			this._onDidChange.fire();
		}
	}
}

// ---- the panel's place: the bottom bar's allowance gauges open it (contrib/dispatchStatusBar) ----------------------------

/**
 * The Accounts panel under (or over) `anchor`, owned by `store`: the title bar's usage strip and the bottom bar's
 * allowance gauges open the same one. `clear` is called when it closes by itself (Escape, a click outside).
 */
export function showDispatchAccountsPanel(instantiationService: IInstantiationService, hoverService: IHoverService, model: AccountsModel, anchor: HTMLElement, position: HoverPosition, store: DisposableStore, clear: () => void): boolean {
	hoverService.hideHover(true);
	anchor.classList.add('open');
	store.add(toDisposable(() => {
		anchor.classList.remove('open');
		hoverService.hideHover(true);
	}));
	const content = instantiationService.createInstance(AccountsPanel, model, clear).render(store);
	const hover = hoverService.showInstantHover({
		content,
		target: anchor,
		additionalClasses: ['dispatch-accounts-panel-hover'],
		position: { hoverPosition: position },
		persistence: { sticky: true, hideOnHover: false },
		appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.9 },
	}, true);
	if (!hover) {
		clear();
		return false;
	}
	store.add(hover);
	store.add(DOM.addDisposableListener(mainWindow.document, DOM.EventType.KEY_DOWN, e => {
		if (e.key === 'Escape') {
			clear();
		}
	}, true));
	const timer = mainWindow.setInterval(() => {
		if (!content.isConnected || hover.isDisposed) {
			clear();
		}
	}, 400);
	store.add(toDisposable(() => mainWindow.clearInterval(timer)));
	return true;
}

// ---- the panel: every saved account, switch in one step -------------------------------------------------------

class AccountsPanel {

	private body!: HTMLElement;
	private error!: HTMLElement;
	private list: readonly IEngineList[] | undefined;
	private busy: string | undefined;
	private closed = false;

	constructor(
		private readonly model: AccountsModel,
		private readonly close: () => void,
		@IDialogService private readonly dialogService: IDialogService,
	) { }

	render(store: DisposableStore): HTMLElement {
		store.add(toDisposable(() => this.closed = true));
		const panel = DOM.$('.dispatch-accounts-panel', { 'aria-label': localize('dispatchAccounts.panelTitle', "Accounts") });
		this.body = DOM.append(panel, DOM.$('.dispatch-accounts-body'));
		this.error = DOM.append(panel, DOM.$('.dispatch-accounts-error'));
		this.error.setAttribute('role', 'alert');
		this.drawFromStatus();
		void this.load();
		return panel;
	}

	private async load(): Promise<void> {
		const list = await this.model.ask<IEngineList[]>('list');
		if (this.closed) {
			return;
		}
		if (!Array.isArray(list)) {
			this.showError(refusal(list) || localize('dispatchAccounts.listFailed', "Dispatch could not read your accounts just now."));
			return;
		}
		this.list = list;
		this.draw();
	}

	/** Drawn at once from what the title bar already knows; the full list replaces it when it comes. */
	private drawFromStatus(): void {
		const engines = this.model.engines;
		if (!engines) {
			DOM.clearNode(this.body);
			DOM.append(this.body, DOM.$('.dispatch-accounts-loading', undefined, localize('dispatchAccounts.loading', "Reading your accounts…")));
			return;
		}
		this.list = engines.map(e => ({
			engine: e.engine, name: e.name, signed_in: e.signed_in,
			accounts: [
				...(e.account ? [{ ...e.account, id: e.account.id ?? '', engine: e.engine, active: true, windows: e.windows, usage_at: e.usage_at, level: e.level }] : []),
				...e.others.map(o => ({ ...o, engine: e.engine, active: false, windows: o.top ? [o.top] : [], level: o.level ?? 'unknown' as Level })),
			],
		}));
		this.draw();
	}

	private showError(message: string): void {
		this.error.textContent = message;
		this.error.classList.toggle('visible', !!message);
	}

	private draw(): void {
		DOM.clearNode(this.body);
		for (const e of this.list ?? []) {
			const section = DOM.append(this.body, DOM.$('.dispatch-accounts-section', { 'aria-label': engineName(e.engine) }));
			section.dataset.engine = e.engine;
			if (e.keyring) {
				DOM.append(section, DOM.$('.dispatch-accounts-line', undefined, localize('dispatchAccounts.keyring',
					"Codex: its sign-in is in the macOS keychain on this Mac, so Dispatch cannot switch it.")));
				continue;
			}
			if (!e.accounts.length) {
				DOM.append(section, DOM.$('.dispatch-accounts-line', undefined, localize('dispatchAccounts.signedOut', "{0}: not signed in.", engineName(e.engine))));
				this.addRow(section, e.engine, localize('dispatchAccounts.signIn', "Sign in to {0}…", engineName(e.engine)), true);
				continue;
			}
			for (const a of e.accounts) {
				this.accountRow(section, a);
			}
			this.addRow(section, e.engine, localize('dispatchAccounts.addAnother', "Add {0} account…", engineName(e.engine)), false);
		}
	}

	/** One account, one row as in the machine panel: the engine's icon, the name and plan; at the right "✓ In use",
	 *  or how much is used (the trash can in its place on hover) and Switch. The account in use lists each allowance. */
	private accountRow(section: HTMLElement, a: IAccountRow): void {
		const row = DOM.append(section, DOM.$('.dispatch-accounts-row'));
		row.classList.toggle('active', a.active);
		row.dataset.account = a.id;
		DOM.append(row, DOM.$(`span.dispatch-accounts-row-slot${ThemeIcon.asCSSSelector(engineIcon(a.engine))}`, { 'aria-hidden': 'true' }));
		const text = DOM.append(row, DOM.$('span.dispatch-accounts-row-text'));
		DOM.append(text, DOM.$('span.dispatch-accounts-row-name', { title: a.email && a.email !== a.name ? `${a.name} (${a.email})` : a.name }, a.name));
		if (a.plan) {
			DOM.append(text, DOM.$('span.dispatch-accounts-row-plan', undefined, a.plan.charAt(0).toUpperCase() + a.plan.slice(1)));
		}
		if (a.active) {
			const state = DOM.append(row, DOM.$('span.dispatch-accounts-row-state'));
			DOM.append(state, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.check)}`, { 'aria-hidden': 'true' }));
			DOM.append(state, DOM.$('span', undefined, a.unsaved
				? localize('dispatchAccounts.inUseUnsaved', "In use, not saved yet")
				: localize('dispatchAccounts.inUse', "In use")));
			const wins = liveWindows(a.windows);
			const limits = DOM.append(section, DOM.$('.dispatch-accounts-limits'));
			if (!wins.length) {
				DOM.append(limits, DOM.$('.dispatch-accounts-limit-none', undefined, a.usage_at
					? localize('dispatchAccounts.usageStale', "Could not read the usage just now. Last read {0}.", ago(a.usage_at))
					: localize('dispatchAccounts.usageNone', "No usage numbers yet.")));
			}
			for (const w of wins) {
				const level = windowLevel(w);
				const line = DOM.append(limits, DOM.$(`.dispatch-accounts-limit.${level}`));
				DOM.append(line, DOM.$('span.dispatch-accounts-limit-label', undefined, longWindow(w)));
				DOM.append(line, DOM.$('span.dispatch-accounts-limit-reset', undefined, w.resets ? localize('dispatchAccounts.limitResets', "resets {0}", w.resets) : ''));
				const value = DOM.append(line, DOM.$('span.dispatch-accounts-limit-value'));
				if (level !== 'ok') {
					DOM.append(value, DOM.$(`span.dispatch-accounts-limit-warn${ThemeIcon.asCSSSelector(Codicon.warning)}`, { 'aria-hidden': 'true' }));
				}
				DOM.append(value, DOM.$('span', undefined, level === 'out'
					? localize('dispatchAccounts.limitOut', "used up")
					: localize('dispatchAccounts.limitUsed', "{0}%", pct(w))));
			}
			return;
		}
		// the usage, and the trash can in the same place on hover (as a list row's time gives way to its ⋯)
		const swap = DOM.append(row, DOM.$('span.dispatch-accounts-row-swap'));
		const wins = liveWindows(a.windows);
		const top = wins.length ? wins.reduce((x, y) => pct(y) > pct(x) ? y : x) : undefined;
		DOM.append(swap, DOM.$(`span.dispatch-accounts-row-usage.${top ? windowLevel(top) : 'unknown'}`, undefined, top
			? localize('dispatchAccounts.rowUsage', "{0} {1}%", shortWindow(top), pct(top))
			: (a.short || '–')));
		const remove = DOM.append(swap, DOM.$('button.dispatch-accounts-icon-button', {
			title: localize('dispatchAccounts.remove', "Remove {0} from this Mac", a.name),
			'aria-label': localize('dispatchAccounts.remove', "Remove {0} from this Mac", a.name),
		}));
		DOM.append(remove, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
		DOM.addDisposableListener(remove, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			void this.remove(a);
		});
		if (a.needs_signin) {
			this.pill(row, localize('dispatchAccounts.signInAgain', "Sign in again"), () => this.add(a.engine, false));
		} else {
			this.pill(row, localize('dispatchAccounts.switch', "Switch"), () => this.use(a)).title = localize('dispatchAccounts.switchTitle',
				"Switch to {0}. Sessions in Dispatch move to it with their next message; a session in a terminal keeps its account until it restarts.", a.name);
		}
	}

	private pill(parent: HTMLElement, text: string, run: () => void): HTMLElement {
		const b = DOM.append(parent, DOM.$('button.dispatch-accounts-pill', undefined, text));
		DOM.addDisposableListener(b, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			if (!this.busy) {
				run();
			}
		});
		return b;
	}

	private addRow(section: HTMLElement, engine: Engine, text: string, use: boolean): void {
		const b = DOM.append(section, DOM.$('button.dispatch-accounts-add'));
		DOM.append(b, DOM.$(`span.dispatch-accounts-add-icon${ThemeIcon.asCSSSelector(Codicon.add)}`));
		DOM.append(b, DOM.$('span', undefined, text));
		DOM.addDisposableListener(b, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this.add(engine, use);
		});
	}

	private setBusy(id: string | undefined): void {
		this.busy = id;
		this.body.classList.toggle('busy', !!id);
	}

	private async use(a: IAccountRow): Promise<void> {
		this.setBusy(a.id);
		this.showError('');
		try {
			const r = await this.model.ask<IAnswer>('use', a.engine, a.id);
			if (this.closed) {
				return;
			}
			if (!r || refusal(r) !== undefined) {
				this.showError(refusal(r) || localize('dispatchAccounts.useFailed', "Dispatch could not switch accounts just now."));
				return;
			}
			await this.model.refresh();
			await this.load();
		} finally {
			this.setBusy(undefined);
		}
	}

	private async remove(a: IAccountRow): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('dispatchAccounts.removeConfirm', "Remove {0} from this Mac?", a.name),
			detail: localize('dispatchAccounts.removeDetail', "Dispatch forgets this account and its sign-in. To use it again, sign in to it again."),
			primaryButton: localize({ key: 'dispatchAccounts.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
		});
		if (!confirmed || this.closed) {
			return;
		}
		const r = await this.model.ask<IAnswer>('remove', a.engine, a.id);
		if (this.closed) {
			return;
		}
		if (!r || refusal(r) !== undefined) {
			this.showError(refusal(r) || localize('dispatchAccounts.removeFailed', "Dispatch could not remove the account just now."));
			return;
		}
		await this.model.refresh();
		await this.load();
	}

	/** The sign-in happens in a terminal (the engine's own login opens the browser): the panel steps aside. */
	private add(engine: Engine, use: boolean): void {
		this.close();
		const model = this.model;
		void model.ask<IAnswer>('add', engine, use).then(() => model.refresh(), () => model.refresh());
	}
}

// ---- a session stopped on a limit: offer the other account --------------------------------------------------

class DispatchAccountsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchAccounts';

	constructor(
		@ICommandService commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		const model = AccountsModel.get(commandService);
		this._register(model.onDidStop(stop => this.offer(model, stop)));
		model.start();
	}

	private offer(model: AccountsModel, stop: ILimit): void {
		const to = stop.switch_to;
		if (!to) {
			this.notificationService.prompt(Severity.Warning, stop.message, [{
				label: localize('dispatchAccounts.offerAdd', "Add {0} account…", engineName(stop.engine)),
				run: () => void model.ask('add', stop.engine, true).then(() => model.refresh()),
			}]);
			return;
		}
		this.notificationService.prompt(Severity.Warning, stop.message, [{
			label: stop.held
				? localize('dispatchAccounts.offerContinue', "Switch to {0} and continue", to.name)
				: localize('dispatchAccounts.offerSwitch', "Switch to {0}", to.name),
			run: () => void this.switchAndContinue(model, stop, to),
		}]);
	}

	private async switchAndContinue(model: AccountsModel, stop: ILimit, to: { readonly id: string; readonly name: string }): Promise<void> {
		const r = await model.ask<IAnswer & { continued?: boolean; note?: string }>('continue', stop.engine, stop.session, to.id);
		await model.refresh();
		if (!r || refusal(r) !== undefined) {
			this.notificationService.error(refusal(r) || localize('dispatchAccounts.continueFailed', "Dispatch could not switch accounts just now."));
			return;
		}
		this.notificationService.info(r.continued
			? localize('dispatchAccounts.continued', "{0} now uses {1}. The session goes on.", engineName(stop.engine), to.name)
			: localize('dispatchAccounts.switched', "{0} now uses {1}. Send a message to go on.", engineName(stop.engine), to.name));
	}
}
registerWorkbenchContribution2(DispatchAccountsContribution.ID, DispatchAccountsContribution, WorkbenchPhase.AfterRestored);
