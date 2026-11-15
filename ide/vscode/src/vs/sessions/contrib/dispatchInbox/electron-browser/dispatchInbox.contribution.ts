/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the bell (kanban app/cli/inbox.py, task-gfhy). What the agents did while you looked
 *  elsewhere: a session that finished, one that needs you, one that stopped without finishing. Each is
 *  decided by the agent's own end-of-turn signal (the session's status from the Agent Host, chatd's
 *  turn_done), never by a silence timer.
 *
 *  - The bell sits in the title bar, left of the phone button (which keeps its place). Its number is the
 *    sessions with something new; the Dock icon shows the same number.
 *  - Clicking a row opens the session and marks it read; right-click (or the row's small button) marks
 *    it unread again, here and in the session list, so it comes back in Waiting for you too.
 *  - A macOS notification only for finished and needs you (VS Code's own notifier for the window's
 *    sessions, minus errors: sessionsWindowNotifier.ts; here for sessions Dispatch runs outside it).
 *  - The panel's foot says who is asleep (dispatchAgentSleep.ts, `dispatch sleep`) and switches it.
 *  - Settings › Notifications says which kinds show a banner on this Mac and its sound (`dispatch inbox prefs`,
 *    kanban app/cli/notify_prefs.py): the policy below applies it to every banner of the window, VS Code's own
 *    notifiers' included (workbench/services/host/browser/dispatchToastPolicy.ts). A stop rings only when the
 *    person turned it on; a finished session that this window did not have loaded still gets its last words
 *    (the CLI reads them from the agent's transcript).
 *
 *  Everything goes through dispatch-bridge's `dispatch.inbox` command (app/ide-ext/src/inbox.ts).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchInbox.css';
import '../../../browser/media/dispatchStatusBlocks.css';

import * as DOM from '../../../../base/browser/dom.js';
import { ensureDispatchDotStyles } from '../../../../base/browser/dispatchDot.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { autorun, autorunDelta, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { setDispatchToastPolicy } from '../../../../workbench/services/host/browser/dispatchToastPolicy.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { createDispatchBlocks } from '../../../browser/dispatchStatusBlocks.js';

const $ = DOM.$;

// the coral dot of a stop is the session list's (sessionStatusIcon.ts does the same)
ensureDispatchDotStyles('.dispatch-status-dot');

const BELL = 'dispatch.inbox.bell';
// this window files its own sessions' events and reads them back at once; the poll is for what Dispatch runs
// outside it (chatd), so it can be slow: one short CLI call every 10 s
const POLL_MS = 10_000;
const SLEEP_POLL_MS = 60_000;
const ASK_MS = 15_000;
/** The same session's status settling (a turn ending and the next queued one starting) is not news yet. */
const SETTLE_MS = 1500;
const EARLIER_MAX = 12;

// ---- the data -----------------------------------------------------------------------------------------

type InboxKind = 'finished' | 'needs_you' | 'stopped';

/** When the window went away (DispatchInboxContribution.goneAt); a gap longer than GONE_MS is not a reload. */
const GONE_KEY = 'dispatch.inbox.windowGoneAt';
const GONE_MS = 10 * 60_000;
/** The session list and its last turn's end arrive a moment after the window starts. */
const GONE_SETTLE_MS = 3000;

interface IInboxEvent {
	readonly id: string;
	readonly at: number;
	readonly kind: InboxKind;
	readonly why?: string;
	readonly ring?: boolean;
	readonly session: string;
	readonly source: 'ide' | 'chat' | 'terminal';
	readonly agent?: string;
	readonly title?: string;
	readonly project?: string;
	readonly text?: string;
	readonly read: boolean;
	readonly read_by?: string | null;
}

interface IInboxData {
	readonly events: readonly IInboxEvent[];
	readonly unread: number;
}

interface ISleepData {
	readonly on: boolean;
	readonly minutes: number;
	readonly count: number;
}

/** What the last poll said; undefined until the first answer. */
const inboxData = observableValue<IInboxData | undefined>('dispatchInbox', undefined);
const sleepData = observableValue<ISleepData | undefined>('dispatchSleep', undefined);

/** Which kinds show a banner on this Mac, and the sound (kanban app/cli/notify_prefs.py). */
interface INotifyPrefs {
	readonly finished: boolean;
	readonly needs_you: boolean;
	readonly stopped: boolean;
	readonly sound: string;
}
const DEFAULT_PREFS: INotifyPrefs = { finished: true, needs_you: true, stopped: false, sound: 'default' };
const prefsData = observableValue<INotifyPrefs>('dispatchNotifyPrefs', DEFAULT_PREFS);
const PREFS_POLL_MS = 120_000;
/** Settings › Notifications saved: read the prefs again now. */
export const DISPATCH_NOTIFY_PREFS_CHANGED = '_dispatch.inbox.prefsChanged';

async function ask<T>(commandService: ICommandService, op: string, arg?: unknown, extra?: unknown): Promise<T | undefined> {
	return raceTimeout(commandService.executeCommand<T>('dispatch.inbox', op, arg, extra), ASK_MS);
}

async function refresh(commandService: ICommandService): Promise<void> {
	const r = await ask<IInboxData>(commandService, 'list');
	if (r && Array.isArray(r.events)) {
		inboxData.set({ events: r.events, unread: r.unread ?? r.events.filter(e => !e.read).length }, undefined);
	}
}

async function refreshPrefs(commandService: ICommandService): Promise<void> {
	const r = await ask<Partial<INotifyPrefs>>(commandService, 'prefs');
	if (r && typeof r.finished === 'boolean') {
		prefsData.set({ finished: r.finished, needs_you: r.needs_you !== false, stopped: r.stopped === true, sound: typeof r.sound === 'string' ? r.sound : 'default' }, undefined);
	}
}

CommandsRegistry.registerCommand(DISPATCH_NOTIFY_PREFS_CHANGED, accessor => refreshPrefs(accessor.get(ICommandService)));

async function refreshSleep(commandService: ICommandService): Promise<void> {
	const r = await ask<ISleepData>(commandService, 'sleep');
	if (r && typeof r.on === 'boolean') {
		sleepData.set({ on: r.on, minutes: r.minutes, count: r.count }, undefined);
	}
}

/** The local copy changes at once (the next poll confirms): rows do not jump back while the CLI writes. */
function setReadLocally(ids: ReadonlySet<string>, read: boolean): void {
	const d = inboxData.get();
	if (!d) {
		return;
	}
	const events = d.events.map(e => ids.has(e.id) ? { ...e, read } : e);
	inboxData.set({ events, unread: events.filter(e => !e.read).length }, undefined);
}

function agentOf(session: ISession): string {
	const t = `${session.sessionType} ${session.resource.scheme}`.toLowerCase();
	return t.includes('codex') ? 'codex' : t.includes('opencode') ? 'opencode' : t.includes('claude') ? 'claude-code' : session.sessionType;
}

/** The window's own session for an event: the same resource, or (chatd's <agent>:<id>) the same id. */
function sessionOf(management: ISessionsManagementService, e: IInboxEvent): ISession | undefined {
	const all = management.getSessions();
	const exact = all.find(s => s.resource.toString() === e.session);
	if (exact) {
		return exact;
	}
	const id = e.session.split(/[:/]/).filter(Boolean).pop();
	return id && id.length >= 8 ? all.find(s => s.resource.path.endsWith(id) || s.sessionId.endsWith(id)) : undefined;
}

// ---- the button ---------------------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({ id: BELL, title: localize2('dispatchInbox.title', "Notifications"), icon: Codicon.bell, f1: true });
	}
	run(): void { mainWindow.document.querySelector<HTMLElement>('.dispatch-inbox-button-label')?.click(); }
});

// next to the phone button, on its left: the phone button (order -100) and everything right of it keep their place
MenuRegistry.appendMenuItem(MenuId.for('SessionsTitleBarSessionMenu'), {
	command: { id: BELL, title: localize('dispatchInbox.title', "Notifications"), icon: Codicon.bell },
	group: 'navigation',
	order: -105,
	when: ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated()),
});

// the Dock number is the bell's (below), not VS Code's count of sessions that need input
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: { 'sessions.showApplicationBadge': false } }]);

class DispatchInboxButton extends BaseActionViewItem {

	private readonly panel = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		action: IAction,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('dispatch-inbox-button');
		const button = DOM.append(container, $('a.action-label.dispatch-inbox-button-label'));
		button.setAttribute('role', 'button');
		button.tabIndex = 0;
		const icon = DOM.append(button, $('span.dispatch-inbox-button-icon'));
		const count = DOM.append(button, $('span.dispatch-inbox-count'));
		this._register(autorun(reader => {
			const n = inboxData.read(reader)?.unread ?? 0;
			icon.className = `dispatch-inbox-button-icon ${ThemeIcon.asClassName(Codicon.bell)}`;
			count.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
			button.classList.toggle('has-unread', n > 0);
			const label = n === 0 ? localize('dispatchInbox.none', "Notifications: nothing new")
				: n === 1 ? localize('dispatchInbox.one', "Notifications: 1 session has something new")
					: localize('dispatchInbox.many', "Notifications: {0} sessions have something new", n);
			button.setAttribute('aria-label', label);
			button.title = label;
		}));
		this._register(DOM.addDisposableListener(button, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				DOM.EventHelper.stop(e, true);
				this.toggle(button);
			}
		}));
	}

	override onClick(event: MouseEvent): void {
		DOM.EventHelper.stop(event, true);
		const anchor = this.element?.querySelector<HTMLElement>('.dispatch-inbox-button-label');
		if (anchor) {
			this.toggle(anchor);
		}
	}

	private toggle(anchor: HTMLElement): void {
		if (this.panel.value) {
			this.panel.clear();
			this.hoverService.hideHover(true);
			return;
		}
		this.hoverService.hideHover(true);
		const store = new DisposableStore();
		this.panel.value = store;
		anchor.classList.add('open');
		store.add(toDisposable(() => anchor.classList.remove('open')));
		const close = () => {
			this.panel.clear();
			this.hoverService.hideHover(true);
		};
		const content = this.instantiationService.createInstance(InboxPanel, close).render(store);
		const hover = this.hoverService.showInstantHover({
			content,
			target: anchor,
			additionalClasses: ['dispatch-inbox-panel-hover'],
			position: { hoverPosition: HoverPosition.BELOW },
			persistence: { sticky: true, hideOnHover: false },
			appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.9 },
		}, true);
		if (!hover) {
			this.panel.clear();
			return;
		}
		store.add(hover);
		store.add(DOM.addDisposableListener(mainWindow.document, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				close();
			}
		}, true));
		const timer = mainWindow.setInterval(() => {
			if (!content.isConnected || hover.isDisposed) {
				this.panel.clear();
			}
		}, 400);
		store.add(toDisposable(() => mainWindow.clearInterval(timer)));
	}
}

// ---- the panel ----------------------------------------------------------------------------------------


/** Dispatch's icon in miniature (sessionStatusIcon.ts): whole and in colour when done, amber when it waits, faint when asleep or seen. */
function blocks(mode: 'still' | 'waiting' | 'idle'): HTMLElement {
	return createDispatchBlocks(mode).element;
}

function statusIcon(e: IInboxEvent): HTMLElement {
	if (e.kind === 'stopped') {
		// unread: the session list's coral dot; seen: the row's own grey
		const dot = $(e.read ? 'span.dispatch-inbox-stop' : 'span.dispatch-status-dot.error');
		dot.setAttribute('aria-hidden', 'true');
		return dot;
	}
	return blocks(e.read ? 'idle' : e.kind === 'needs_you' ? 'waiting' : 'still');
}

const KIND_WORD: Record<InboxKind, string> = {
	finished: localize('dispatchInbox.finished', "Finished"),
	needs_you: localize('dispatchInbox.needsYou', "Needs you"),
	stopped: localize('dispatchInbox.stopped', "Stopped"),
};

function ago(at: number): string {
	const s = Math.max(0, Math.round(Date.now() / 1000 - at));
	if (s < 60) {
		return localize('dispatchInbox.now', "now");
	}
	if (s < 3600) {
		return localize('dispatchInbox.minutes', "{0}m", Math.floor(s / 60));
	}
	if (s < 86400) {
		return localize('dispatchInbox.hours', "{0}h", Math.floor(s / 3600));
	}
	return localize('dispatchInbox.days', "{0}d", Math.floor(s / 86400));
}

class InboxPanel {

	private readonly store = new DisposableStore();
	private list!: HTMLElement;
	private foot!: HTMLElement;
	private markAll!: HTMLButtonElement;

	constructor(
		private readonly close: () => void,
		@ICommandService private readonly commandService: ICommandService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@INotificationService private readonly notificationService: INotificationService,
	) { }

	render(store: DisposableStore): HTMLElement {
		store.add(this.store);
		const panel = $('.dispatch-inbox-panel');
		const head = DOM.append(panel, $('.dispatch-inbox-head'));
		DOM.append(head, $('span.dispatch-inbox-title', undefined, localize('dispatchInbox.panelTitle', "Notifications")));
		DOM.append(head, $('span.dispatch-inbox-sp'));
		this.markAll = DOM.append(head, $<HTMLButtonElement>('button.dispatch-inbox-text-button', { type: 'button' }, localize('dispatchInbox.markAll', "Mark all read")));
		this.store.add(DOM.addDisposableListener(this.markAll, DOM.EventType.CLICK, () => this.readAll()));
		this.list = DOM.append(panel, $('.dispatch-inbox-list'));
		this.list.setAttribute('role', 'list');
		this.foot = DOM.append(panel, $('.dispatch-inbox-foot'));
		this.store.add(autorun(reader => this.renderList(inboxData.read(reader))));
		this.store.add(autorun(reader => this.renderFoot(sleepData.read(reader))));
		void refresh(this.commandService).catch(onUnexpectedError);
		void refreshSleep(this.commandService).catch(onUnexpectedError);
		// relative times stay right while it is open
		const tick = mainWindow.setInterval(() => this.renderList(inboxData.get()), 30_000);
		this.store.add(toDisposable(() => mainWindow.clearInterval(tick)));
		return panel;
	}

	private rowsStore = new DisposableStore();

	private renderList(data: IInboxData | undefined): void {
		this.rowsStore.dispose();
		this.rowsStore = new DisposableStore();
		this.store.add(this.rowsStore);
		DOM.clearNode(this.list);
		const events = data?.events ?? [];
		this.markAll.style.visibility = data && data.unread > 0 ? 'visible' : 'hidden';
		if (!data) {
			DOM.append(this.list, $('.dispatch-inbox-empty-line', undefined, localize('dispatchInbox.loading', "Loading…")));
			return;
		}
		const fresh = events.filter(e => !e.read);
		// one row per session: a session with something new is under New only, and under Earlier only its newest shows
		const seen = new Set(fresh.map(e => e.session));
		const earlier: IInboxEvent[] = [];
		for (const e of events) {
			if (e.read && !seen.has(e.session) && earlier.length < EARLIER_MAX) {
				seen.add(e.session);
				earlier.push(e);
			}
		}
		if (!fresh.length && !earlier.length) {
			const empty = DOM.append(this.list, $('.dispatch-inbox-empty'));
			DOM.append(empty, blocks('idle'));
			DOM.append(empty, $('.dispatch-inbox-empty-title', undefined, localize('dispatchInbox.emptyTitle', "Nothing new")));
			DOM.append(empty, $('.dispatch-inbox-empty-line', undefined, localize('dispatchInbox.emptyLine', "When an agent finishes or needs you, it shows up here.")));
			return;
		}
		if (fresh.length) {
			DOM.append(this.list, $('.dispatch-inbox-section', undefined, localize('dispatchInbox.new', "New")));
			for (const e of fresh) {
				this.renderRow(e);
			}
		}
		if (earlier.length) {
			DOM.append(this.list, $('.dispatch-inbox-section', undefined, localize('dispatchInbox.earlier', "Earlier")));
			for (const e of earlier) {
				this.renderRow(e);
			}
		}
	}

	private renderRow(e: IInboxEvent): void {
		const row = DOM.append(this.list, $<HTMLElement>(`.dispatch-inbox-row.${e.kind}${e.read ? '.read' : ''}`));
		row.setAttribute('role', 'listitem');
		row.tabIndex = 0;
		const icon = DOM.append(row, $('span.dispatch-inbox-row-icon'));
		icon.appendChild(statusIcon(e));
		const body = DOM.append(row, $('span.dispatch-inbox-row-body'));
		const title = e.title || e.project || localize('dispatchInbox.untitled', "A session");
		DOM.append(body, $('span.dispatch-inbox-row-title', undefined, title));
		// one thing on the second line: the last words, the question, or why it stopped; the icon says which kind
		const detail = (e.kind === 'stopped' ? e.why : e.text) || KIND_WORD[e.kind];
		DOM.append(body, $('span.dispatch-inbox-row-line', undefined, detail));
		const where = e.project && e.project !== title ? e.project : '';
		row.title = [`${KIND_WORD[e.kind]}: ${title}`, where].filter(Boolean).join(' · ');
		const rest = [where, detail].filter(Boolean).join(', ');
		const end = DOM.append(row, $('span.dispatch-inbox-row-end'));
		DOM.append(end, $('span.dispatch-inbox-row-time', undefined, ago(e.at)));
		const toggle = DOM.append(end, $<HTMLButtonElement>('button.dispatch-inbox-row-toggle', { type: 'button' }));
		const toggleLabel = e.read ? localize('dispatchInbox.markUnread', "Mark as Unread") : localize('dispatchInbox.markRead', "Mark as Read");
		toggle.setAttribute('aria-label', toggleLabel);
		toggle.title = toggleLabel;
		DOM.append(toggle, $(`span${ThemeIcon.asCSSSelector(e.read ? Codicon.mail : Codicon.check)}`));
		row.setAttribute('aria-label', `${KIND_WORD[e.kind]}: ${title}${rest ? `, ${rest}` : ''}, ${ago(e.at)}`);
		this.rowsStore.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, ev => {
			DOM.EventHelper.stop(ev, true);
			void this.setRead(e, !e.read);
		}));
		this.rowsStore.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => void this.open(e)));
		this.rowsStore.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, ev => {
			if (ev.key === 'Enter') {
				DOM.EventHelper.stop(ev, true);
				void this.open(e);
			}
		}));
		this.rowsStore.add(DOM.addDisposableListener(row, DOM.EventType.CONTEXT_MENU, ev => {
			DOM.EventHelper.stop(ev, true);
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: ev.clientX, y: ev.clientY }),
				// over the panel: the panel is a hover (layer 1), a menu is layer 0 by default and would open behind it
				layer: 2,
				getActions: () => [
					new Action('dispatchInbox.open', localize('dispatchInbox.openSession', "Open Session"), undefined, true, () => this.open(e)),
					new Action('dispatchInbox.toggleRead', e.read ? localize('dispatchInbox.markUnread', "Mark as Unread") : localize('dispatchInbox.markRead', "Mark as Read"), undefined, true, () => this.setRead(e, !e.read)),
				],
			});
		}));
	}

	private renderFoot(s: ISleepData | undefined): void {
		DOM.clearNode(this.foot);
		if (!s) {
			return;
		}
		const line = DOM.append(this.foot, $('.dispatch-inbox-foot-line'));
		DOM.append(line, blocks('idle'));
		const text = !s.on ? localize('dispatchInbox.sleepOff', "Idle agents stay awake.")
			: s.count === 0 ? localize('dispatchInbox.sleepNone', "Agents that finish and sit for {0} min go to sleep to free memory.", s.minutes)
				: s.count === 1 ? localize('dispatchInbox.sleepOne', "1 agent is asleep to free memory. Open it and it picks up where it left off.")
					: localize('dispatchInbox.sleepMany', "{0} agents are asleep to free memory. Open one and it picks up where it left off.", s.count);
		DOM.append(line, $('span.dispatch-inbox-foot-text', undefined, text));
		const sw = DOM.append(this.foot, $<HTMLButtonElement>('button.dispatch-inbox-switch', { type: 'button', role: 'switch' }));
		sw.setAttribute('aria-checked', String(s.on));
		DOM.append(sw, $('span.dispatch-inbox-switch-thumb'));
		const label = DOM.append(this.foot, $('span.dispatch-inbox-switch-label', undefined, localize('dispatchInbox.sleepSwitch', "Let idle agents sleep")));
		sw.setAttribute('aria-label', label.textContent ?? '');
		const flip = async () => {
			sw.disabled = true;
			sleepData.set({ ...s, on: !s.on }, undefined);
			try {
				await ask(this.commandService, s.on ? 'sleepOff' : 'sleepOn');
			} finally {
				await refreshSleep(this.commandService);
			}
		};
		this.store.add(DOM.addDisposableListener(sw, DOM.EventType.CLICK, () => void flip().catch(onUnexpectedError)));
		this.store.add(DOM.addDisposableListener(label, DOM.EventType.CLICK, () => void flip().catch(onUnexpectedError)));
	}

	private async open(e: IInboxEvent): Promise<void> {
		const session = sessionOf(this.management, e);
		if (!e.read) {
			setReadLocally(new Set([e.id]), true);
			void ask(this.commandService, 'read', [e.id]).then(() => refresh(this.commandService)).catch(onUnexpectedError);
		}
		if (!session) {
			this.notificationService.info(e.source === 'chat'
				? localize('dispatchInbox.notHere', "This conversation runs in Dispatch outside this window (an agent another agent started, or one from your phone).")
				: localize('dispatchInbox.gone', "This session is no longer in the Agents window."));
			return;
		}
		this.close();
		await this.sessionsService.openSession(session.resource);
	}

	private async setRead(e: IInboxEvent, read: boolean): Promise<void> {
		setReadLocally(new Set([e.id]), read);
		const session = sessionOf(this.management, e);
		if (session) {
			// the session list and Waiting for you say the same
			void this.management.setSessionReadState(session, read).catch(onUnexpectedError);
		}
		await ask(this.commandService, read ? 'read' : 'unread', [e.id]);
		await refresh(this.commandService);
	}

	private async readAll(): Promise<void> {
		const unread = (inboxData.get()?.events ?? []).filter(e => !e.read);
		setReadLocally(new Set(unread.map(e => e.id)), true);
		const sessions = unread.map(e => sessionOf(this.management, e)).filter((s): s is ISession => !!s);
		if (sessions.length) {
			void this.management.markAllRead(sessions).catch(onUnexpectedError);
		}
		await ask(this.commandService, 'readAll');
		await refresh(this.commandService);
	}
}

// ---- recording, polling, the Dock -------------------------------------------------------------------

class DispatchInboxContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchInbox';

	// by object: a new session's draft and the session it becomes can share a resource
	private readonly tracked = this._register(new DisposableMap<ISession>());
	private readonly toasted = new Set<string>();
	private readonly started = Date.now() / 1000;
	private lastBadge = -1;
	/** When this window last went away (a reload, a quit), if that was a moment ago: a session that finished then was
	 *  never seen working by this window, so its status change below never comes (10-08, notify-prefs). */
	private readonly goneAt: number | undefined;

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IChatService private readonly chatService: IChatService,
		@IHostService private readonly hostService: IHostService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		const gone = storageService.getNumber(GONE_KEY, StorageScope.PROFILE);
		this.goneAt = gone !== undefined && Date.now() - gone < GONE_MS ? gone : undefined;
		storageService.remove(GONE_KEY, StorageScope.PROFILE);
		this._register(lifecycleService.onWillShutdown(() => storageService.store(GONE_KEY, Date.now(), StorageScope.PROFILE, StorageTarget.MACHINE)));
		this._register(actionViewItemService.register(MenuId.for('SessionsTitleBarSessionMenu'), BELL, action => instantiationService.createInstance(DispatchInboxButton, action)));

		for (const s of this.management.getSessions()) {
			this.track(s);
		}
		this._register(this.management.onDidChangeSessions(e => {
			for (const s of e.removed) {
				this.tracked.deleteAndDispose(s);
			}
			for (const s of [...e.added, ...e.changed]) {
				this.track(s);
			}
		}));
		// a session started from the new-session page is a draft first, then the session it becomes: neither
		// necessarily comes through onDidChangeSessions
		this._register(this.management.onDidStartSession(s => this.track(s)));
		this._register(this.management.onDidReplaceSession(({ to }) => this.track(to)));
		this._register(this.management.onDidReplaceNewDraftSession(({ to }) => this.track(to)));

		const poll = () => void refresh(this.commandService).catch(() => undefined);
		poll();
		const timer = mainWindow.setInterval(poll, POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
		// every banner of the window: the kinds the person turned off stay quiet, the sound is theirs
		this._register(setDispatchToastPolicy((options, kind) => {
			const p = prefsData.get();
			// what the last banner did, for a test to read (no other use)
			mainWindow.document.body.dataset.dispatchLastBanner = `${kind} ${p[kind] ? 'shown' : 'off'} ${p.sound}`;
			if (!p[kind]) {
				return undefined;
			}
			if (p.sound === 'default') {
				return options;
			}
			if (p.sound !== 'none') {
				void ask(this.commandService, 'sound', p.sound).catch(() => undefined);
			}
			return { ...options, silent: true };
		}));
		const pollPrefs = () => void refreshPrefs(this.commandService).catch(() => undefined);
		pollPrefs();
		const prefsTimer = mainWindow.setInterval(pollPrefs, PREFS_POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(prefsTimer)));
		const pollSleep = () => void refreshSleep(this.commandService).catch(() => undefined);
		pollSleep();
		const sleepTimer = mainWindow.setInterval(pollSleep, SLEEP_POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(sleepTimer)));
		this._register(this.hostService.onDidChangeFocus(focused => focused && poll()));

		// the Dock icon: the bell's number
		this._register(autorun(reader => {
			const n = inboxData.read(reader)?.unread ?? 0;
			this.setBadge(n);
		}));
		this._register(toDisposable(() => this.setBadge(0)));

		// what Dispatch runs outside this window (chatd) only reaches the person through here
		this._register(autorun(reader => {
			for (const e of inboxData.read(reader)?.events ?? []) {
				this.maybeToast(e);
			}
		}));
	}

	private track(session: ISession): void {
		if (this.tracked.has(session)) {
			return;
		}
		const store = new DisposableStore();
		let pending: number | undefined;
		store.add(toDisposable(() => pending !== undefined && mainWindow.clearTimeout(pending)));
		const firstStatus = session.status.get();
		let moved = false; // the status changed while this window watched: the usual way below records it
		store.add(autorunDelta(session.status, ({ lastValue, newValue }) => {
			// a terminal's agent files its own turns (its hooks, kanban app/cli/terminal_hook.py), with Dispatch closed too
			if (lastValue === undefined || lastValue === newValue || session.providerId === 'dispatch-terminal') {
				return;
			}
			moved = true;
			if (pending !== undefined) {
				mainWindow.clearTimeout(pending);
				pending = undefined;
			}
			if (newValue === SessionStatus.InProgress) {
				// working again: whatever it had for the person has been seen
				this.readSession(session, 'working');
				return;
			}
			const wasActive = lastValue === SessionStatus.InProgress || lastValue === SessionStatus.NeedsInput;
			const status = newValue === SessionStatus.NeedsInput ? 'needs_input'
				: newValue === SessionStatus.Error ? 'error'
					: newValue === SessionStatus.Completed && wasActive ? 'completed'
						: undefined;
			if (!status) {
				return;
			}
			// a finish settles first: the next queued message may start the session again at once
			pending = mainWindow.setTimeout(() => {
				pending = undefined;
				if (session.status.get() !== newValue) {
					return;
				}
				this.record(session, status);
			}, status === 'completed' ? SETTLE_MS : 0);
		}));
		// finished while this window was away (a reload): first seen here as done, never as working
		const goneAt = this.goneAt;
		if (goneAt !== undefined && session.providerId !== 'dispatch-terminal' && Date.now() / 1000 - this.started < 60) {
			const t = mainWindow.setTimeout(() => {
				const end = session.lastTurnEnd.get()?.getTime();
				if (!moved && firstStatus === SessionStatus.Completed && session.status.get() === SessionStatus.Completed && !session.isRead.get()
					&& end !== undefined && end > goneAt && end <= Date.now()) {
					this.record(session, 'completed');
				}
			}, GONE_SETTLE_MS);
			store.add(toDisposable(() => mainWindow.clearTimeout(t)));
		}
		store.add(autorunDelta(session.isRead, ({ lastValue, newValue }) => {
			if (lastValue === false && newValue === true) {
				this.readSession(session, 'you');
			}
		}));
		this.tracked.set(session, store);
	}

	private record(session: ISession, status: 'completed' | 'needs_input' | 'error'): void {
		const model = this.chatService.getSession(session.resource);
		const last = model?.getRequests().at(-1)?.response;
		const kind = status === 'completed' && last?.isCanceled ? 'cancelled' : status;
		let text = '';
		try {
			text = last && kind !== 'error' ? last.response.getMarkdown().trim().split('\n').filter(Boolean).pop() ?? '' : '';
		} catch {
			text = '';
		}
		const why = kind === 'error' ? session.description.get()?.value ?? '' : '';
		const workspace = session.workspace.get();
		void ask(this.commandService, 'add', {
			status: kind,
			session: session.resource.toString(),
			agent: agentOf(session),
			title: session.title.get(),
			project: workspace?.label ?? '',
			cwd: workspace?.folders[0]?.workingDirectory.fsPath ?? '',
			text,
			why,
		}).then(async () => {
			// the person is looking at it right now: nothing new for them
			if (this.hostService.hasFocus && this.sessionsService.activeSession.get()?.resource.toString() === session.resource.toString() && kind !== 'needs_input') {
				await ask(this.commandService, 'readSession', session.resource.toString(), 'you');
			}
			await refresh(this.commandService);
		}).catch(onUnexpectedError);
	}

	private readSession(session: ISession, by: 'you' | 'working'): void {
		const key = session.resource.toString();
		if (!(inboxData.get()?.events ?? []).some(e => e.session === key && !e.read)) {
			return;
		}
		const ids = new Set((inboxData.get()?.events ?? []).filter(e => e.session === key && !e.read).map(e => e.id));
		setReadLocally(ids, true);
		void ask(this.commandService, 'readSession', key, by).then(() => refresh(this.commandService)).catch(onUnexpectedError);
	}

	private maybeToast(e: IInboxEvent): void {
		// VS Code's notifiers announce the window's own sessions finishing or needing you; this one adds what
		// Dispatch runs outside the window needing you, and a stop from anywhere (rings only when turned on)
		const ours = e.kind === 'stopped' || (e.kind === 'needs_you' && e.ring && e.source !== 'ide');
		if (this.toasted.has(e.id) || e.read || !ours || e.at < this.started) {
			return;
		}
		this.toasted.add(e.id);
		// in front: quiet, unless the person asked for banners always (VS Code's own setting for the same kind)
		const always = this.configurationService.getValue<string>(e.kind === 'needs_you' ? 'chat.notifyWindowOnConfirmation' : 'chat.notifyWindowOnResponseReceived') === 'always';
		if (this.hostService.hasFocus && !always) {
			return;
		}
		const title = e.title || e.project || localize('dispatchInbox.untitled', "A session");
		void this.hostService.showToast({
			dedupeKey: `dispatch-inbox:${e.kind}:${e.session}`,
			title: e.kind === 'stopped' ? localize('dispatchInbox.toastStopped', "Stopped: {0}", title) : localize('dispatchInbox.toastTitle', "Needs you: {0}", title),
			body: (e.kind === 'stopped' ? e.why : e.text) || e.project || '',
		}, CancellationToken.None).then(r => {
			if (r.clicked) {
				return this.hostService.focus(mainWindow).then(() => {
					mainWindow.document.querySelector<HTMLElement>('.dispatch-inbox-button-label')?.click();
				});
			}
			return undefined;
		}).catch(onUnexpectedError);
	}

	private setBadge(n: number): void {
		if (n === this.lastBadge) {
			return;
		}
		this.lastBadge = n;
		const description = n === 1 ? localize('dispatchInbox.badgeOne', "1 session has something new") : localize('dispatchInbox.badgeMany', "{0} sessions have something new", n);
		this.nativeHostService.setApplicationBadge(n > 0 ? { count: n, description } : undefined).catch(onUnexpectedError);
	}
}
// before the title bar draws itself (as Machines): registered later, a reloaded window kept a plain bell
registerWorkbenchContribution2(DispatchInboxContribution.ID, DispatchInboxContribution, WorkbenchPhase.BlockRestore);
