/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Waiting for you (kanban design/task-model/DECISIONS.md; since 2026-11-11 the page of direction A in
 *  design/home-now, task-0v1o9).
 *
 *  - Every 5 s (and when the window comes back) `dispatch.waiting` from dispatch-bridge runs
 *    `dispatch waiting --json`: sessions that stopped for an approval or a decision, unread replies,
 *    and the tasks only the person can do, across every project.
 *  - The entry and this week's newest things are at the top of the sessions list (views/dispatchWaitingSidebar.ts).
 *  - The page: one line on how it is ordered, then This week (the things that moved in the last 7 days, the newest
 *    first) and Older (the rest, closed until opened; dispatchWaitingGroups.ts draws the line). A row is 32 high: a
 *    14px icon for what it is (Older: fainter, and grey words), the title, the project (112 wide), what is asked of the
 *    person in one word (Pick, Only you, Approve, Reply; 64 wide) and how long ago it moved (38 wide, right aligned).
 *    Hovering a row shows its card (dispatchHoverDetails.ts: the whole question or command, Allow, Deny, the options,
 *    Mark read, Done) and lights its row in the side bar; a click opens it as before (openWaitingItem).
 *  - The page's head line (2026-11-15, user, task-ccmyi: put back what 11-11 took out): the line on how it is ordered
 *    and, while replies are unread, a light "Mark all read" at its end. Several rows are picked by their first slot
 *    (its icon turns into a round mark from dispatchMarks.ts: an empty circle, a filled check once picked), ⌘-click
 *    or ⇧-click (a range), or x / ⇧j ⇧k; then the head line says "N selected" with Done and Clear. Only rows Done can
 *    clear are picked: an Only-you task (closed on the board) and an unread reply (marked read); an approval or a
 *    question needs its answer.
 *  - Keys: j k move, a allow, d deny, 1-9 pick, o or Enter open, r mark read or reply, Enter on an Only-you task done,
 *    x select, ⇧j ⇧k select while moving, Enter (with a selection) done, Esc clears it, u undo. Handled rows fade out
 *    (150 ms) and fold (150 ms); Undo for 6 s in the page's last line.
 *  - Open shows the session with a queue bar on top (dispatchWaitingQueue.ts): Prev, Next, and Esc back to the page
 *    where it was, the same row in focus. An Only-you task opens the conversation it came from, or its task page.
 *  - A design direction's prototype opens in the side pane next to the page: the page stays, its row keeps the focus.
 *    When a session takes the page's place any other way, the title bar's ← comes back to it (dispatchCustomViewBack.ts).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchWaiting.css';
// the way back from a page to its session (Esc, the title bar's ←, "‹ session" on the task pages)
import './dispatchCustomViewBack.js';
import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { isDispatchWindowIdle, onDidChangeDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { throttleLeadingTrailing } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdleModel.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { renderWaitingDetail } from '../../dispatchTasks/browser/dispatchHoverDetails.js';
import { stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';
// the queue bar over a session opened from the page, and opening a row
import { openWaitingItem } from './dispatchWaitingQueue.js';
import { waitingAge, waitingAskWord, WAITING_FRESH_DAYS } from './dispatchWaitingGroups.js';
import { onDidChangeDispatchBoard } from '../../dispatchBoard/browser/dispatchBoard.js';
import {
	dispatchWaitingData, dispatchWaitingPageMemory, dispatchWaitingQueue, dispatchWaitingVisible, dispatchWaitingWeek, resetDispatchWaitingPageMemory, hideDispatchWaitingItems,
	dispatchWaitingHover, DispatchWaitingAnswer, enterWaitingHover, IDispatchWaitingData, IDispatchWaitingHover, IDispatchWaitingItem, IDispatchWaitingOption, isDesignDecide, leaveWaitingHover, restoreDispatchWaitingItems, setDispatchWaitingData, unhideDispatchWaitingItems,
	askPickReason, renderWaitingThingIcon, waitingOptionId, waitingTitle
} from './dispatchWaitingModel.js';

const $ = DOM.$;

export const DISPATCH_WAITING_VIEW_ID = 'dispatch.waitingForYou';
const POLL_MS = 5000;
const TOAST_MS = 6000;
const LEAVE_MS = 150;

// ---- the data -------------------------------------------------------------------------------------

/** Ask dispatch-bridge. `undefined` when the bridge is not there yet or the CLI failed. */
async function askBridge(commandService: ICommandService, op?: string, id?: string, extra?: string | IPickAnswer): Promise<unknown> {
	return commandService.executeCommand('dispatch.waiting', op, id, extra);
}

/** A pick: the option (the question's option id, or the direction's letter) and, for a direction, why. */
interface IPickAnswer {
	readonly option: string;
	readonly reason?: string;
}

interface IBridgeAnswer {
	readonly ok?: boolean;
	readonly message?: string;
	readonly project_dir?: string;
	readonly prompt?: string;
	readonly title?: string;
}

let refreshNow: () => Promise<void> = async () => { };
/** "N older" in the side bar asked for Older: the page opens it and brings it into view once it has its rows. */
let olderAsked = false;
/** The page on screen, told to open Older and show it (when it was open already). */
let showOlder: (() => void) | undefined;

/** Fetch now (after an action, or when the page opens). */
export function refreshDispatchWaiting(): Promise<void> {
	return refreshNow();
}

class DispatchWaitingPoller extends Disposable {
	static readonly ID = 'dispatch.contrib.waitingPoller';
	private running: Promise<void> | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ICustomViewService customViewService: ICustomViewService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		refreshNow = () => this.refresh();
		this._register(customViewService.registerCustomView({
			id: DISPATCH_WAITING_VIEW_ID,
			ctor: new SyncDescriptor(DispatchWaitingView),
		}, { restore: false }));
		// sessions that stop for you change outside the board: the timer stays; a board change comes at once (dispatchBoard.ts)
		// after a read already under way (it began before the change), one more
		// (a window nobody looks at, hidden or untouched for 30 s, waits: it asks once when it wakes, dispatchIdle.ts)
		// (ten Agents writing the board: a change every second or two; a refresh at most every 5 s)
		const onBoard = throttleLeadingTrailing({ now: () => Date.now(), setTimeout: (fn, ms) => mainWindow.setTimeout(fn, ms), clearTimeout: h => mainWindow.clearTimeout(h as number) }, () => void (this.running ?? Promise.resolve()).then(() => this.refresh()), 5000);
		this._register(toDisposable(() => onBoard.cancel()));
		this._register(onDidChangeDispatchBoard(() => { if (!isDispatchWindowIdle()) { onBoard.call(); } }));
		this._register(onDidChangeDispatchWindowIdle(idle => { if (!idle) { void this.refresh(); } }));
		const timer = mainWindow.setInterval(() => {
			// hidden too until the first answer came: the first ask goes out before the bridge is up, and a window started
			// hidden or behind others had no rows (the hover card said "Nothing is waiting for you") until it was shown
			if ((mainWindow.document.visibilityState === 'visible' && !isDispatchWindowIdle()) || !dispatchWaitingData.get()) {
				void this.refresh();
			}
		}, POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
		this._register(DOM.addDisposableListener(mainWindow.document, 'visibilitychange', () => {
			if (mainWindow.document.visibilityState === 'visible') {
				void this.refresh();
			}
		}));
		// the bridge activates after the window: first ask a moment later
		const first = mainWindow.setTimeout(() => void this.refresh(), 1500);
		this._register(toDisposable(() => mainWindow.clearTimeout(first)));
	}

	refresh(): Promise<void> {
		this.running ??= (async () => {
			try {
				const answer = await askBridge(this.commandService);
				if (answer && typeof answer === 'object' && Array.isArray((answer as IDispatchWaitingData).items)) {
					setDispatchWaitingData(answer as IDispatchWaitingData);
				}
			} catch (e) {
				// no bridge (yet), or the CLI failed: keep what was shown
				this.logService.trace(`[DispatchWaiting] ${e}`);
			} finally {
				this.running = undefined;
			}
		})();
		return this.running;
	}
}

registerWorkbenchContribution2(DispatchWaitingPoller.ID, DispatchWaitingPoller, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.waiting.show', title: localize2('dispatchWaiting.show', "Waiting for You"), f1: true });
	}
	override run(accessor: ServicesAccessor, how?: { readonly fresh?: boolean; readonly older?: boolean }): void {
		const customViewService = accessor.get(ICustomViewService);
		// the side bar opens the page as it first looks (the top, Older closed), unless the person is still going
		// through its queue (then it is a way back, like Esc: where they were); "N older" opens it on Older
		if (how?.fresh && !dispatchWaitingQueue.get() && customViewService.activeCustomView.get()?.id !== DISPATCH_WAITING_VIEW_ID) {
			resetDispatchWaitingPageMemory();
		}
		if (how?.older) {
			dispatchWaitingPageMemory.olderOpen = true;
			olderAsked = true;
		}
		customViewService.showCustomView(DISPATCH_WAITING_VIEW_ID);
		if (how?.older) {
			showOlder?.();
		}
	}
});

/**
 * Answer a waiting item from a hover card (the Projects page's line at the right, a project's Now): Allow,
 * Deny, or pick an option; a design direction first asks why on a small card under `anchor`, like the page.
 * The row leaves Waiting for you
 * at once and the bridge does the rest; true when it took.
 */
export async function answerWaitingItem(accessor: ServicesAccessor, item: IDispatchWaitingItem, a: DispatchWaitingAnswer | { readonly act: 'read' | 'done' | 'snooze' }, anchor: HTMLElement): Promise<boolean> {
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const hoverService = accessor.get(IHoverService);
	let extra: IPickAnswer | undefined;
	if (a.act === 'pick') {
		const option = waitingOptionId(a.option);
		if (!option) {
			return false;
		}
		if (isDesignDecide(item)) {
			// asked right under the card it was picked on
			const reason = await askPickReason(hoverService, anchor, a.option);
			if (reason === undefined) {
				return false;
			}
			extra = { option, reason };
		} else {
			extra = { option };
		}
	}
	hideDispatchWaitingItems([item.id]);
	try {
		const answer = await askBridge(commandService, a.act, a.act === 'done' || a.act === 'snooze' ? item.task || item.id : item.id, extra) as IBridgeAnswer | undefined;
		if (answer && typeof answer === 'object' && answer.ok === false) {
			unhideDispatchWaitingItems([item.id]);
			notificationService.warn(answer.message || localize('dispatchWaiting.failed', "That did not work."));
			return false;
		}
		return true;
	} catch (e) {
		unhideDispatchWaitingItems([item.id]);
		notificationService.error(localize('dispatchWaiting.error', "Waiting for you: {0}", String((e as Error)?.message ?? e)));
		return false;
	} finally {
		await refreshDispatchWaiting();
	}
}

// ---- the page --------------------------------------------------------------------------------------

type Act = 'allow' | 'deny' | 'pick' | 'read' | 'done';

/** What Undo takes back: the rows read or done (an unread reply is marked unread again, an Only-you task reopened). */
interface IUndo {
	readonly items: readonly IDispatchWaitingItem[];
}

/** Done can clear it without an answer: an Only-you task (closed on the board) or an unread reply (marked read). */
function canBeDone(item: IDispatchWaitingItem): boolean {
	return (item.kind === 'only_you' && !!item.task) || item.kind === 'unread';
}

const TOAST_WORD: Record<Act, string> = {
	allow: localize('dispatchWaiting.allowed', "Allowed"),
	deny: localize('dispatchWaiting.denied', "Denied"),
	pick: localize('dispatchWaiting.answered', "Answered"),
	read: localize('dispatchWaiting.markedRead', "Marked read"),
	done: localize('dispatchWaiting.doneToast', "Done"),
};

/** Older shows this many rows when it opens; the rest behind "Show N more". */
const OLDER_ROWS = 6;

function kbd(parent: HTMLElement, key: string): HTMLElement {
	return DOM.append(parent, $('kbd.dispatch-waiting-kbd', undefined, key));
}

class DispatchWaitingView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchWaiting.title', "Waiting for you"));
	override readonly maxWidth = 880;

	private root: HTMLElement | undefined;
	private scroller: HTMLElement | undefined;
	private toast: HTMLElement | undefined;
	private toastTimer: number | undefined;
	private readonly renderStore = this._register(new DisposableStore());

	private focusId: string | undefined = dispatchWaitingPageMemory.focusId;
	/** The first render with data after the page was rebuilt (back from a session): the focus may need its place. */
	private returning = dispatchWaitingPageMemory.focusId !== undefined;
	private undoable: IUndo | undefined;
	/** The last action on its way to the bridge: Undo waits for it (a reopen before the close would lose). */
	private lastRun: Promise<void> = Promise.resolve();
	/** A row coming back (Undo): it takes the focus once it is on the page again. */
	private pendingFocus: string | undefined;
	/** A row leaving: renders wait for it (a poll would cut its fade short). */
	private leaving = 0;
	private renderPending = false;
	private lastKey = '';
	/** "Show N more" in Older was clicked. */
	private olderAll = false;
	private rendered = new Set<string>();
	private firstRender = true;
	private scrollRestored = false;
	/** An item was opened from here: the memory is what the way back needs, this page no longer writes it. */
	private handedOff = false;
	/** Where the list was before the side bar pointed at a row and scrolled it into view (back there after). */
	private linkedScrollTop: number | undefined;
	/** The rows picked for Done (ids), and where a ⇧-click's range starts. */
	private readonly selected = new Set<string>();
	private anchorId: string | undefined;
	/** The head line: how the page is ordered and Mark all read, or the selection and its Done. */
	private head: HTMLElement | undefined;
	private readonly headStore = this._register(new DisposableStore());

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		const root = this.root = DOM.append(container, $('.dispatch-waiting-page.dispatch-waiting-a'));
		root.tabIndex = -1;
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', localize('dispatchWaiting.title', "Waiting for you"));
		this.scroller = container.parentElement ?? undefined;
		// the toast lives in the page's last line (the key row, sticky at the bottom); it outlives the renders
		const frame = container.closest('.custom-view-node') ?? container;
		this.toast = $('.dispatch-waiting-toast');
		this.toast.setAttribute('role', 'status');
		this._register(toDisposable(() => {
			this.toast?.remove();
			if (this.toastTimer !== undefined) {
				mainWindow.clearTimeout(this.toastTimer);
			}
		}));
		// the keys work wherever the focus is on the page (a click on its empty part focuses the host's content)
		this._register(DOM.addDisposableListener(frame as HTMLElement, DOM.EventType.KEY_DOWN, e => this.onKey(e)));
		if (this.scroller) {
			this._register(DOM.addDisposableListener(this.scroller, DOM.EventType.SCROLL, () => {
				if (this.scrollRestored && !this.handedOff) {
					dispatchWaitingPageMemory.scrollTop = this.scroller!.scrollTop;
				}
			}));
		}
		// the page goes (a session took its place, a way back later rebuilds it): it comes back where it was
		this._register(toDisposable(() => this.remember()));
		// the page is open: what is here now is seen (the CLI's own count for the phone and other Macs)
		void askBridge(this.commandService, 'seen').then(() => refreshDispatchWaiting()).catch(() => undefined);
		this._register(toDisposable(() => void askBridge(this.commandService, 'seen').catch(() => undefined)));
		void refreshDispatchWaiting();
		// the queue ends here: the person is back on the page
		dispatchWaitingQueue.set(undefined, undefined);
		this._register(autorun(reader => {
			dispatchWaitingWeek.read(reader);
			this.requestRender();
		}));
		// the side bar points at a row (a row under Waiting for you, the session's own row): show it here
		this._register(autorun(reader => this.applyLinked(dispatchWaitingHover.read(reader), true)));
		// how long ago each row moved keeps moving: only the text, a redraw would drop the hover and the focus
		const tick = mainWindow.setInterval(() => this.tickAges(), 30_000);
		this._register(toDisposable(() => mainWindow.clearInterval(tick)));
		// "N older" in the side bar while the page is open already
		showOlder = () => {
			this.renderNow(true);
			this.revealOlder();
		};
		this._register(toDisposable(() => { showOlder = undefined; }));
		// opened (from the side bar, the command, back from a session): the page takes the keyboard, like an
		// editor does when it opens, so j / k / a … act on it right away
		const first = mainWindow.requestAnimationFrame(() => {
			if (root.isConnected) {
				root.focus({ preventScroll: true });
			}
		});
		this._register(toDisposable(() => mainWindow.cancelAnimationFrame(first)));
	}

	/** Where the page is, for the way back: the row in focus and where it stands. */
	private remember(): void {
		if (this.handedOff) {
			// open() already wrote what the way back needs
			return;
		}
		if (this.focusId) {
			const at = this.itemElements().findIndex(el => el.dataset.id === this.focusId);
			if (at >= 0) {
				dispatchWaitingPageMemory.focusIndex = at;
			}
		}
		// the scroll is written as it changes (a page already taken out of the window reads 0)
	}

	layout(_width: number, _height: number): void {
		this.restoreScroll();
		this.takeFocusIfLost();
	}

	/** Shown again (back from a session or a task page) with the focus nowhere: the page takes it, so the keys work. */
	private takeFocusIfLost(): void {
		const root = this.root;
		if (!root?.isConnected) {
			return;
		}
		const active = DOM.getActiveElement();
		if (!active || active === root.ownerDocument.body) {
			root.focus({ preventScroll: true });
		}
	}

	/** Back from a session: the list where it was (once the page has its rows and its height). */
	private restoreScroll(): void {
		const scroller = this.scroller;
		if (this.scrollRestored || !scroller || !dispatchWaitingVisible.get() || !scroller.clientHeight) {
			return;
		}
		this.scrollRestored = true;
		if (olderAsked) {
			olderAsked = false;
			this.revealOlder();
			return;
		}
		const top = dispatchWaitingPageMemory.scrollTop;
		if (top) {
			scroller.scrollTop = top;
		}
	}

	/** Older's heading at the top of the view (asked for by "N older" in the side bar). */
	private revealOlder(): void {
		const head = this.root?.querySelector<HTMLElement>('.dispatch-waiting-fold[data-group="older"]');
		if (head && this.scroller) {
			this.scroller.scrollTop += head.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - 8;
		}
	}

	override focus(): void {
		this.root?.focus({ preventScroll: true });
		this.applyFocus(false);
	}

	// ---- rendering -------------------------------------------------------------------------------

	private requestRender(): void {
		if (this.leaving > 0) {
			this.renderPending = true;
			return;
		}
		this.renderNow();
	}

	private items(): readonly IDispatchWaitingItem[] {
		return dispatchWaitingVisible.get()?.items ?? [];
	}

	private renderNow(force = false): void {
		const root = this.root;
		if (!root) {
			return;
		}
		const split = dispatchWaitingWeek.get();
		const olderOpen = dispatchWaitingPageMemory.olderOpen;
		const key = JSON.stringify([split?.week, split?.older, olderOpen, this.olderAll]);
		if (!force && key === this.lastKey) {
			return;
		}
		this.lastKey = key;
		this.renderStore.clear();
		DOM.clearNode(root);
		const store = this.renderStore;
		const previous = this.rendered;
		const current = new Set<string>();
		const entering = (id: string) => {
			current.add(id);
			return !this.firstRender && !previous.has(id);
		};

		if (!split) {
			this.renderSkeleton(root);
			return;
		}
		const { week, older } = split;
		// a picked row that is gone (done elsewhere, answered) is not picked any more
		for (const id of [...this.selected]) {
			if (![...week, ...older].some(i => i.id === id && canBeDone(i))) {
				this.selected.delete(id);
			}
		}
		// the head line: how the page is ordered and Mark all read, or the selection and Done
		this.head = DOM.append(root, $('.dispatch-waiting-head'));
		this.renderHead();

		if (week.length) {
			const head = DOM.append(root, $('.dispatch-waiting-group-head'));
			head.dataset.group = 'week';
			DOM.append(head, $('span', undefined, localize('dispatchWaiting.thisWeek', "This week")));
			DOM.append(head, $('span.dispatch-waiting-group-count', undefined, String(week.length)));
			const list = DOM.append(root, $('.dispatch-waiting-rows'));
			list.dataset.group = 'week';
			for (const item of week) {
				this.renderRow(list, item, false, entering(item.id), store);
			}
		}

		if (older.length) {
			const fold = DOM.append(root, $<HTMLButtonElement>('button.dispatch-waiting-fold', { type: 'button' }));
			fold.dataset.group = 'older';
			fold.setAttribute('aria-expanded', String(olderOpen));
			fold.classList.toggle('open', olderOpen);
			const arrow = renderIcon(Codicon.chevronRight);
			arrow.classList.add('dispatch-waiting-fold-arrow');
			fold.appendChild(arrow);
			DOM.append(fold, $('span', undefined, localize('dispatchWaiting.older', "Older")));
			DOM.append(fold, $('span.dispatch-waiting-group-count', undefined, String(older.length)));
			fold.title = localize('dispatchWaiting.olderTip', "Not touched for {0} days. They do not count in the side bar.", WAITING_FRESH_DAYS);
			store.add(DOM.addDisposableListener(fold, DOM.EventType.CLICK, () => {
				dispatchWaitingPageMemory.olderOpen = !dispatchWaitingPageMemory.olderOpen;
				this.renderNow(true);
			}));
			if (olderOpen) {
				const list = DOM.append(root, $('.dispatch-waiting-rows.older'));
				list.dataset.group = 'older';
				const shown = this.olderAll ? older : older.slice(0, OLDER_ROWS);
				for (const item of shown) {
					this.renderRow(list, item, true, entering(item.id), store);
				}
				if (shown.length < older.length) {
					const more = DOM.append(root, $<HTMLButtonElement>('button.dispatch-waiting-more', { type: 'button' }, localize('dispatchWaiting.showMore', "Show {0} more", older.length - shown.length)));
					store.add(DOM.addDisposableListener(more, DOM.EventType.CLICK, () => {
						this.olderAll = true;
						this.renderNow(true);
					}));
				}
			}
		}

		this.bottomBar(root, week.length + older.length > 0);
		// a task id in a title reads as that task's title (the person never reads task-xxxx)
		store.add(linkifyDispatchTasksWith(this.commandService, root));
		this.rendered = current;
		this.firstRender = false;
		const items = this.items();
		if (this.pendingFocus && items.some(i => i.id === this.pendingFocus)) {
			this.focusId = dispatchWaitingPageMemory.focusId = this.pendingFocus;
			this.pendingFocus = undefined;
		}
		if (this.focusId && !this.itemElements().some(el => el.dataset.id === this.focusId)) {
			// back from a session whose row is gone (read, answered): the row now in its place
			const index = this.returning ? dispatchWaitingPageMemory.focusIndex : undefined;
			const els = this.itemElements();
			this.focusId = index !== undefined && els.length ? els[Math.min(index, els.length - 1)].dataset.id : undefined;
			if (!this.handedOff) {
				dispatchWaitingPageMemory.focusId = this.focusId;
			}
		}
		this.returning = false;
		this.applyFocus(false);
		this.applyLinked(dispatchWaitingHover.get(), false);
		// a handled row took the keyboard focus with it: give it back to the page
		this.takeFocusIfLost();
		mainWindow.requestAnimationFrame(() => {
			this.restoreScroll();
			this.takeFocusIfLost();
		});
	}

	/**
	 * The page's first line, sticky at the top of the view. Nothing picked: one line on how the page is ordered and, while
	 * replies are unread, a light "Mark all read" at its end. Rows picked: "N selected", Done, Clear.
	 */
	private renderHead(): void {
		const head = this.head;
		const split = dispatchWaitingWeek.get();
		if (!head || !split) {
			return;
		}
		this.headStore.clear();
		DOM.clearNode(head);
		const all = [...split.week, ...split.older];
		const picked = all.filter(i => this.selected.has(i.id));
		head.classList.toggle('selecting', picked.length > 0);
		this.root?.classList.toggle('selecting', picked.length > 0);
		if (picked.length) {
			const n = DOM.append(head, $('span.dispatch-waiting-selinfo', undefined, localize('dispatchWaiting.nSelected', "{0} selected", picked.length)));
			n.setAttribute('role', 'status');
			DOM.append(head, $('span.dispatch-waiting-sp'));
			const done = this.headButton(head, localize('dispatchWaiting.bulkDone', "Done"), 'xs outline', () => this.bulkDone());
			done.title = localize('dispatchWaiting.bulkDoneTip', "Close the picked Only-you tasks and mark the picked replies read");
			const clear = this.headButton(head, localize('dispatchWaiting.clearSelection', "Clear"), 'xs ghost', () => this.clearSelection());
			clear.title = localize('dispatchWaiting.clearSelectionTip', "Pick nothing (Esc)");
			return;
		}
		DOM.append(head, $('span.dispatch-waiting-intro', undefined, split.week.length
			? localize('dispatchWaiting.intro', "Newest first. Anything you have not touched for {0} days moves to Older and stops counting.", WAITING_FRESH_DAYS)
			: localize('dispatchWaiting.introNone', "Nothing new needs you.")));
		const unread = all.filter(i => i.kind === 'unread');
		if (unread.length) {
			const b = this.headButton(head, localize('dispatchWaiting.markAllRead', "Mark all read"), 'xs ghost', () => this.act(unread, 'read', undefined, true));
			b.classList.add('dispatch-waiting-readall');
			b.title = localize('dispatchWaiting.markAllReadTitle', "Mark every unread reply read");
		}
	}

	private headButton(parent: HTMLElement, label: string, cls: string, onClick: () => void): HTMLButtonElement {
		const b = DOM.append(parent, $<HTMLButtonElement>(`button.dispatch-waiting-btn.${cls.split(' ').join('.')}`, { type: 'button' }, label));
		this.headStore.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, e => {
			e.stopPropagation();
			onClick();
		}));
		return b;
	}

	// ---- picking several -----------------------------------------------------------------------------

	private toggleSelect(id: string, on = !this.selected.has(id)): void {
		const item = this.items().find(i => i.id === id);
		if (!item || !canBeDone(item)) {
			return;
		}
		if (on) {
			this.selected.add(id);
		} else {
			this.selected.delete(id);
		}
		this.anchorId = id;
		this.applySelection();
	}

	/** ⇧-click: every row Done can clear from the last one picked to this one is picked. */
	private selectRange(id: string): void {
		const els = this.itemElements();
		const from = els.findIndex(el => el.dataset.id === this.anchorId);
		const to = els.findIndex(el => el.dataset.id === id);
		if (from < 0 || to < 0) {
			this.toggleSelect(id, true);
			return;
		}
		const byId = new Map(this.items().map(i => [i.id, i] as const));
		for (const el of els.slice(Math.min(from, to), Math.max(from, to) + 1)) {
			const item = byId.get(el.dataset.id ?? '');
			if (item && canBeDone(item)) {
				this.selected.add(item.id);
			}
		}
		this.applySelection();
	}

	private clearSelection(): void {
		this.selected.clear();
		this.anchorId = undefined;
		this.applySelection();
	}

	/** The rows show what is picked (their first slot and their background), the head line says how many. */
	private applySelection(): void {
		for (const el of this.root?.querySelectorAll<HTMLElement>('.dispatch-waiting-item') ?? []) {
			const on = this.selected.has(el.dataset.id ?? '');
			el.classList.toggle('selected', on);
			el.querySelector('.dispatch-waiting-check')?.setAttribute('aria-checked', String(on));
		}
		if (this.selected.size) {
			// picking: a row's card is out of the way (none come back until nothing is picked)
			this.hoverService.hideHover(true);
		}
		this.renderHead();
		this.applyFocus(false);
		// Clear or Done took the keyboard focus with it: back to the page
		this.takeFocusIfLost();
	}

	private bulkDone(): void {
		const items = this.items().filter(i => this.selected.has(i.id) && canBeDone(i));
		this.selected.clear();
		this.anchorId = undefined;
		this.applySelection();
		this.act(items, 'done');
		this.root?.focus({ preventScroll: true });
	}

	private renderSkeleton(root: HTMLElement): void {
		const sk = DOM.append(root, $('.dispatch-waiting-skeleton'));
		sk.setAttribute('aria-busy', 'true');
		sk.setAttribute('aria-label', localize('dispatchWaiting.loading', "Looking…"));
		for (const w of [38, 72, 64, 80]) {
			const bar = DOM.append(sk, $('.dispatch-waiting-skeleton-bar'));
			bar.style.width = `${w}%`;
		}
	}

	/**
	 * One row, three columns after the title: what it is (an icon in the first slot; Older: fainter), the title, the
	 * project, what is asked in one word, how long ago it moved. Its card on hover, a click opens it.
	 */
	private renderRow(parent: HTMLElement, item: IDispatchWaitingItem, older: boolean, entering: boolean, store: DisposableStore): void {
		const row = DOM.append(parent, $('.dispatch-waiting-row.dispatch-waiting-item', { role: 'button', tabindex: '-1' }));
		row.dataset.id = item.id;
		row.dataset.kind = item.kind;
		row.classList.toggle('older', older);
		row.classList.toggle('entering', entering);
		const slot = DOM.append(row, $('span.dispatch-waiting-slot'));
		renderWaitingThingIcon(slot, item);
		if (canBeDone(item)) {
			// the first slot picks it: its icon turns into a round mark (empty, a check once picked) on hover or while
			// rows are picked (DESIGN.md 符号表: VS Code's round icons, from dispatchMarks.ts)
			row.classList.add('selectable');
			row.classList.toggle('selected', this.selected.has(item.id));
			const check = DOM.append(slot, $<HTMLButtonElement>('button.dispatch-waiting-check', { type: 'button', tabindex: '-1' }));
			check.setAttribute('role', 'checkbox');
			check.setAttribute('aria-checked', String(this.selected.has(item.id)));
			check.setAttribute('aria-label', localize('dispatchWaiting.selectRow', "Select {0}", waitingTitle(item)));
			check.append(stateMark('todo'), stateMark('seen'));
			// the slot takes the click (its hit area reaches the row's edge and the gap: a 14px target is too small)
			store.add(DOM.addDisposableListener(slot, DOM.EventType.CLICK, e => {
				e.stopPropagation();
				if (e.shiftKey) {
					this.selectRange(item.id);
				} else {
					this.toggleSelect(item.id);
				}
			}));
		}
		DOM.append(row, $('span.dispatch-waiting-title', undefined, waitingTitle(item)));
		const project = item.project || localize('dispatchWaiting.noProject', "No project");
		DOM.append(row, $('span.dispatch-waiting-project', undefined, project));
		DOM.append(row, $('span.dispatch-waiting-ask', undefined, waitingAskWord(item)));
		const age = DOM.append(row, $('span.dispatch-waiting-age', undefined, waitingAge(item)));
		age.dataset.id = item.id;
		row.setAttribute('aria-label', `${waitingTitle(item)}, ${project}, ${waitingAskWord(item)}, ${waitingAge(item)}`);
		store.add(DOM.addDisposableListener(row, DOM.EventType.MOUSE_DOWN, e => {
			if (e.shiftKey) {
				// a range, not a text selection
				e.preventDefault();
			}
			this.focusId = dispatchWaitingPageMemory.focusId = item.id;
			this.applyFocus(false);
		}));
		store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => {
			// ⌘-click picks it, ⇧-click picks the range; a plain click opens it as always
			if ((e.metaKey || e.ctrlKey) && canBeDone(item)) {
				this.toggleSelect(item.id);
			} else if (e.shiftKey && canBeDone(item)) {
				this.selectRange(item.id);
			} else if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
				this.open(item);
			}
		}));
		store.add(DOM.addDisposableListener(row, DOM.EventType.MOUSE_ENTER, () => enterWaitingHover(item.id, 'page')));
		store.add(DOM.addDisposableListener(row, DOM.EventType.MOUSE_LEAVE, () => leaveWaitingHover(item.id)));
		// no card while picking, or over the slot that picks (it would cover the rows a ⇧-click is after): the row does
		// not hear the pointer come, and a card on its way is called off
		store.add(DOM.addDisposableListener(row, DOM.EventType.MOUSE_OVER, e => {
			if (this.selected.size || (canBeDone(item) && (e.target as HTMLElement).closest('.dispatch-waiting-slot'))) {
				e.stopImmediatePropagation();
				this.hoverService.hideHover(true);
			}
		}));
		// its card: what it asks in full and its buttons (the same card as in the side bar)
		let cardStore: DisposableStore | undefined;
		store.add(toDisposable(() => cardStore?.dispose()));
		store.add(this.hoverService.setupDelayedHover(row, () => {
			cardStore?.dispose();
			cardStore = new DisposableStore();
			const card = this.instantiationService.invokeFunction(renderWaitingDetail, item, cardStore);
			return { content: card, appearance: { showPointer: true }, position: { hoverPosition: HoverPosition.BELOW }, persistence: { hideOnHover: false } };
		}));
	}

	private tickAges(): void {
		const byId = new Map(this.items().map(i => [i.id, i] as const));
		for (const el of this.root?.querySelectorAll<HTMLElement>('.dispatch-waiting-age') ?? []) {
			const item = byId.get(el.dataset.id ?? '');
			const text = item ? waitingAge(item) : '';
			if (item && el.textContent !== text) {
				el.textContent = text;
			}
		}
	}

	/**
	 * Scroll so `el` shows above the page's last line (the keys, sticky at the bottom: a row behind it can be
	 * neither read nor pointed at).
	 */
	private reveal(el: HTMLElement): void {
		const scroller = this.scroller;
		if (!scroller) {
			return;
		}
		const view = scroller.getBoundingClientRect();
		const bar = this.root?.querySelector<HTMLElement>('.dispatch-waiting-bar')?.offsetHeight ?? 0;
		const r = el.getBoundingClientRect();
		const above = view.top - r.top;
		const below = r.bottom - (view.bottom - bar);
		if (above > 0) {
			scroller.scrollTop -= above;
		} else if (below > 0) {
			scroller.scrollTop += below;
		}
	}

	/**
	 * The side bar points at a row (a row under Waiting for you, the session's own row): its row here looks hovered
	 * and comes into view; when the pointer leaves, the highlight goes and the list goes back to where it was.
	 */
	private applyLinked(hover: IDispatchWaitingHover | undefined, scroll: boolean): void {
		const root = this.root;
		if (!root) {
			return;
		}
		for (const el of root.querySelectorAll('.dispatch-waiting-item.linked')) {
			el.classList.remove('linked');
		}
		const scroller = this.scroller;
		const el = hover && hover.from !== 'page' ? root.querySelector<HTMLElement>(`.dispatch-waiting-item[data-id="${CSS.escape(hover.id)}"]`) : null;
		if (el) {
			el.classList.add('linked');
			if (scroll && scroller) {
				if (this.linkedScrollTop === undefined) {
					this.linkedScrollTop = scroller.scrollTop;
				}
				this.reveal(el);
			}
		} else if (scroll && scroller && this.linkedScrollTop !== undefined) {
			scroller.scrollTop = this.linkedScrollTop;
			this.linkedScrollTop = undefined;
		}
	}

	/** The page's last line, sticky at the bottom of the view: the keys on the left, the toast at the right end. */
	private bottomBar(root: HTMLElement, withKeys: boolean): void {
		const bar = DOM.append(root, $('.dispatch-waiting-bar'));
		const keys = DOM.append(bar, $('.dispatch-waiting-keys'));
		keys.setAttribute('aria-hidden', 'true');
		if (withKeys) {
			this.renderKeys(keys);
		}
		if (this.toast) {
			bar.appendChild(this.toast);
		}
	}

	private renderKeys(parent: HTMLElement): void {
		const k = this.items().find(i => i.id === this.focusId)?.kind;
		const add = (keys: string[], label: string) => {
			const span = DOM.append(parent, $('span.dispatch-waiting-key'));
			for (const key of keys) {
				kbd(span, key);
			}
			DOM.append(span, $('span', undefined, label));
		};
		add(['j', 'k'], localize('dispatchWaiting.keyMove', "move"));
		if (this.selected.size) {
			add(['x'], localize('dispatchWaiting.keySelect', "select"));
			add(['⏎'], localize('dispatchWaiting.keyDoneSelected', "done"));
			add(['esc'], localize('dispatchWaiting.keyClear', "clear"));
			add(['u'], localize('dispatchWaiting.keyUndo', "undo"));
			return;
		}
		if (k === 'approve') {
			add(['a'], localize('dispatchWaiting.keyAllow', "allow"));
			add(['d'], localize('dispatchWaiting.keyDeny', "deny"));
			add(['o'], localize('dispatchWaiting.keyOpen', "open"));
		} else if (k === 'decide') {
			add(['1', '2', '3'], localize('dispatchWaiting.keyPick', "pick"));
			add(['o'], localize('dispatchWaiting.keyOpen', "open"));
		} else if (k === 'unread') {
			add(['o'], localize('dispatchWaiting.keyOpen', "open"));
			add(['r'], localize('dispatchWaiting.keyMarkRead', "mark read"));
			add(['x'], localize('dispatchWaiting.keySelect', "select"));
		} else if (k === 'only_you') {
			add(['⏎'], localize('dispatchWaiting.keyDone', "done"));
			add(['r'], localize('dispatchWaiting.keyReply', "reply"));
			add(['o'], localize('dispatchWaiting.keyOpenTask', "open"));
			add(['x'], localize('dispatchWaiting.keySelect', "select"));
		} else {
			add(['o'], localize('dispatchWaiting.keyOpen', "open"));
			add(['a'], localize('dispatchWaiting.keyAllow', "allow"));
			add(['1', '2', '3'], localize('dispatchWaiting.keyPick', "pick"));
			add(['r'], localize('dispatchWaiting.keyReadOrReply', "read or reply"));
		}
		add(['u'], localize('dispatchWaiting.keyUndo', "undo"));
	}

	// ---- focus and keys -----------------------------------------------------------------------------

	private itemElements(): HTMLElement[] {
		return this.root ? [...this.root.querySelectorAll<HTMLElement>('.dispatch-waiting-item:not(.leaving)')] : [];
	}

	private applyFocus(scroll: boolean): void {
		if (!this.root) {
			return;
		}
		for (const el of this.root.querySelectorAll('.dispatch-waiting-item.focus')) {
			el.classList.remove('focus');
		}
		const el = this.focusId ? this.root.querySelector<HTMLElement>(`.dispatch-waiting-item[data-id="${CSS.escape(this.focusId)}"]`) : null;
		if (el) {
			el.classList.add('focus');
			if (scroll) {
				this.reveal(el);
			}
		}
		const keys = this.root.querySelector<HTMLElement>('.dispatch-waiting-keys');
		if (keys) {
			DOM.clearNode(keys);
			this.renderKeys(keys);
		}
	}

	private setFocus(id: string | undefined): void {
		this.focusId = dispatchWaitingPageMemory.focusId = id;
		this.applyFocus(true);
	}

	private onKey(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey) {
			return;
		}
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
			return;
		}
		const key = e.key;
		if ((key === 'Enter' || key === ' ') && target?.tagName === 'BUTTON') {
			return; // the button's own click
		}
		const handled = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (key === 'Escape') {
			// a selection first; otherwise on to the window: back to the session
			if (this.selected.size) {
				handled();
				this.clearSelection();
			}
			return;
		}
		if (key === 'u') {
			handled();
			void this.undo();
			return;
		}
		const els = this.itemElements();
		if (!els.length) {
			return;
		}
		let i = els.findIndex(el => el.dataset.id === this.focusId);
		const down = key === 'j' || key === 'J' || key === 'ArrowDown';
		if (down || key === 'k' || key === 'K' || key === 'ArrowUp') {
			handled();
			const from = els[i]?.dataset.id;
			i = down ? Math.min(els.length - 1, i + 1) : Math.max(0, i - 1);
			const to = els[i].dataset.id;
			this.setFocus(to);
			if (e.shiftKey) {
				// ⇧ while moving picks the row left and the one reached
				for (const id of [from, to]) {
					if (id) {
						this.toggleSelect(id, true);
					}
				}
			}
			return;
		}
		if (key === 'Enter' && this.selected.size) {
			handled();
			this.bulkDone();
			return;
		}
		if (i < 0) {
			return;
		}
		const item = this.items().find(x => x.id === els[i].dataset.id);
		if (!item) {
			return;
		}
		if (key === 'x' && canBeDone(item)) {
			handled();
			this.toggleSelect(item.id);
		} else if (key === 'a' && item.kind === 'approve' && item.actions.includes('allow')) {
			handled();
			this.act([item], 'allow');
		} else if (key === 'd' && item.kind === 'approve' && item.actions.includes('deny')) {
			handled();
			this.act([item], 'deny');
		} else if (/^[1-9]$/.test(key) && item.kind === 'decide' && item.actions.includes('pick') && item.options?.[+key - 1]) {
			handled();
			void this.pick(item, item.options[+key - 1]);
		} else if (key === 'o' || (key === 'Enter' && item.kind !== 'only_you')) {
			handled();
			this.open(item);
		} else if (key === 'r' && item.kind === 'unread') {
			handled();
			this.act([item], 'read');
		} else if (key === 'r' && item.kind === 'only_you') {
			handled();
			void this.reply(item);
		} else if (key === 'Enter' && item.kind === 'only_you') {
			handled();
			this.act([item], 'done');
		}
	}

	// ---- acting ------------------------------------------------------------------------------------

	/** Pick an option. A design direction first asks why on a small card under its row (optional; Esc keeps the row): it goes into the person's design preferences. */
	private async pick(item: IDispatchWaitingItem, o: IDispatchWaitingOption): Promise<void> {
		const option = waitingOptionId(o);
		if (!option) {
			return;
		}
		if (!isDesignDecide(item)) {
			this.act([item], 'pick', { option });
			return;
		}
		const row = this.root?.querySelector<HTMLElement>(`.dispatch-waiting-item[data-id="${CSS.escape(item.id)}"]`);
		if (!row) {
			return;
		}
		const reason = await askPickReason(this.hoverService, row, o);
		if (reason === undefined) {
			this.takeFocusIfLost();
			return;
		}
		this.act([item], 'pick', { option, reason });
		this.root?.focus({ preventScroll: true });
	}

	private open(item: IDispatchWaitingItem): void {
		if (isDesignDecide(item) && item.open) {
			// the prototype opens in the side pane next to the page: the page stays, this row keeps the focus
			this.focusId = dispatchWaitingPageMemory.focusId = item.id;
			this.applyFocus(false);
			this.root?.focus({ preventScroll: true });
			this.instantiationService.invokeFunction(accessor => openWaitingItem(accessor, item)).catch(onUnexpectedError);
			return;
		}
		this.handedOff = true;
		dispatchWaitingPageMemory.focusId = item.id;
		dispatchWaitingPageMemory.focusIndex = Math.max(0, this.itemElements().findIndex(el => el.dataset.id === item.id));
		if (this.scroller) {
			dispatchWaitingPageMemory.scrollTop = this.scroller.scrollTop;
		}
		this.instantiationService.invokeFunction(accessor => openWaitingItem(accessor, item)).catch(onUnexpectedError);
	}

	/** Handle a row in place: it fades out and folds, the next one takes the focus, the bridge does the rest. */
	private act(items: readonly IDispatchWaitingItem[], act: Act, option?: IPickAnswer, all = false): void {
		if (!items.length) {
			return;
		}
		const ids = items.map(i => i.id);
		// the focus moves to the row after the last one leaving (or before, at the end)
		const els = this.itemElements();
		const last = Math.max(...ids.map(id => els.findIndex(el => el.dataset.id === id)));
		const gone = (el: HTMLElement) => ids.includes(el.dataset.id!);
		const next = els.slice(last + 1).find(el => !gone(el)) ?? [...els.slice(0, Math.max(0, last))].reverse().find(el => !gone(el));
		this.focusId = dispatchWaitingPageMemory.focusId = next?.dataset.id;
		const leavingEls = ids.map(id => this.root?.querySelector<HTMLElement>(`.dispatch-waiting-item[data-id="${CSS.escape(id)}"]`)).filter((el): el is HTMLElement => !!el);
		this.leave(leavingEls, () => hideDispatchWaitingItems(ids));
		const title = items.length === 1 ? waitingTitle(items[0]) : localize('dispatchWaiting.nItems', "{0} items", items.length);
		const undo: IUndo | undefined = act === 'read' || act === 'done' ? { items } : undefined;
		// a design direction says which one it took ("Picked A: …"); the rest say what happened to what
		const picked = act === 'pick' && option && items.length === 1 && isDesignDecide(items[0]);
		this.showToast(picked ? localize('dispatchWaiting.picked', "Picked {0}: {1}", option.option, title) : `${TOAST_WORD[act]}: ${title}`, undo);
		this.lastRun = this.run(items, act, option, all);
	}

	private async run(items: readonly IDispatchWaitingItem[], act: Act, option: IPickAnswer | undefined, all: boolean): Promise<void> {
		try {
			let answers: unknown[];
			if (act === 'done') {
				// Done on several: the Only-you tasks close on the board in one go, the unread replies are marked read
				const tasks = items.map(i => i.kind === 'only_you' ? i.task : undefined).filter((t): t is string => !!t);
				const reads = items.filter(i => i.kind === 'unread');
				answers = await Promise.all([
					...(tasks.length ? [askBridge(this.commandService, 'done', tasks.join(','))] : []),
					...reads.map(i => askBridge(this.commandService, 'read', i.id)),
				]);
			} else if (act === 'read' && all) {
				answers = [await askBridge(this.commandService, 'readAll')];
			} else {
				answers = await Promise.all(items.map(i => askBridge(this.commandService, act, i.id, option)));
			}
			const failed = answers.find(a => a && typeof a === 'object' && (a as IBridgeAnswer).ok === false) as IBridgeAnswer | undefined;
			if (failed) {
				// Mark all read marks what it can; the rows it could not come back, with a hint to press it again
				const left = (failed as IBridgeAnswer & { failed?: { id?: string }[] }).failed;
				const back = act === 'read' && all && left?.length && left.every(f => f.id) ? items.filter(i => left.some(f => f.id === i.id)) : items;
				unhideDispatchWaitingItems(back.map(i => i.id));
				this.notificationService.warn(act === 'read' && all
					? localize('dispatchWaiting.readAllRetry', "{0} could not be marked read. Press Mark all read again.", back.length === 1 ? localize('dispatchWaiting.oneReply', "1 reply") : localize('dispatchWaiting.nReplies', "{0} replies", back.length))
					: failed.message || localize('dispatchWaiting.failed', "That did not work."));
			}
		} catch (e) {
			unhideDispatchWaitingItems(items.map(i => i.id));
			this.notificationService.error(localize('dispatchWaiting.error', "Waiting for you: {0}", String((e as Error)?.message ?? e)));
		} finally {
			await refreshDispatchWaiting();
		}
	}

	private async undo(): Promise<void> {
		const u = this.undoable;
		if (!u) {
			return;
		}
		this.undoable = undefined;
		this.hideToast();
		// back on the page at once, the first one in focus
		this.pendingFocus = u.items[0]?.id;
		restoreDispatchWaitingItems(u.items);
		this.renderNow(true);
		try {
			// the action itself first: undoing a close that has not happened yet would be lost
			await this.lastRun;
			// a reply read is unread again (the Agents window's own sessions), an Only-you task done is open again
			const tasks = u.items.map(i => i.kind === 'only_you' ? i.task : undefined).filter((t): t is string => !!t);
			await Promise.all([
				...u.items.filter(i => i.kind === 'unread' && i.source === 'ide').map(i => askBridge(this.commandService, 'unread', i.id)),
				...(tasks.length ? [askBridge(this.commandService, 'reopen', tasks.join(','))] : []),
			]);
		} catch (e) {
			this.notificationService.error(localize('dispatchWaiting.error', "Waiting for you: {0}", String((e as Error)?.message ?? e)));
		} finally {
			await refreshDispatchWaiting();
		}
	}

	/** Reply to an Only-you task: a new session in its project, its input started with the task. */
	private async reply(item: IDispatchWaitingItem): Promise<void> {
		if (!item.task) {
			return;
		}
		try {
			const ans = await askBridge(this.commandService, 'reply', item.task) as IBridgeAnswer | undefined;
			if (!ans || ans.ok === false || !ans.project_dir) {
				this.notificationService.info(ans?.message || localize('dispatchWaiting.noFolder', "This task's project has no folder here."));
				return;
			}
			dispatchWaitingPageMemory.focusId = item.id;
			this.customViewService.hideCustomView();
			const { session } = await this.sessionsService.openNewSession({ folderUri: URI.file(ans.project_dir) });
			// the new session's view comes up a moment later
			for (let i = 0; i < 20; i++) {
				const view = this.sessionsPartService.getSessionView(session?.sessionId);
				if (view) {
					view.prefillInput(ans.prompt ?? '');
					return;
				}
				await new Promise(resolve => mainWindow.setTimeout(resolve, 100));
			}
		} catch (e) {
			this.notificationService.error(localize('dispatchWaiting.error', "Waiting for you: {0}", String((e as Error)?.message ?? e)));
		}
	}

	private leave(els: HTMLElement[], done: () => void): void {
		const reduced = mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!els.length || reduced) {
			done();
			return;
		}
		this.leaving++;
		for (const el of els) {
			el.style.height = `${el.getBoundingClientRect().height}px`;
			el.classList.add('leaving');
		}
		mainWindow.setTimeout(() => {
			for (const el of els) {
				el.classList.add('collapsing');
			}
		}, LEAVE_MS);
		mainWindow.setTimeout(() => {
			this.leaving--;
			done();
			if (this.leaving === 0 && this.renderPending) {
				this.renderPending = false;
				this.renderNow();
			}
		}, LEAVE_MS * 2);
	}

	private showToast(text: string, undo: IUndo | undefined): void {
		const toast = this.toast;
		if (!toast) {
			return;
		}
		this.undoable = undo;
		DOM.clearNode(toast);
		DOM.append(toast, $('span.dispatch-waiting-toast-text', undefined, text));
		if (undo) {
			const b = DOM.append(toast, $<HTMLButtonElement>('button.dispatch-waiting-toast-undo', { type: 'button' }));
			b.textContent = localize('dispatchWaiting.undo', "Undo");
			b.addEventListener('click', () => void this.undo(), { once: true });
		}
		toast.classList.add('on');
		if (this.toastTimer !== undefined) {
			mainWindow.clearTimeout(this.toastTimer);
		}
		this.toastTimer = mainWindow.setTimeout(() => {
			this.hideToast();
			this.undoable = undefined;
		}, TOAST_MS);
	}

	private hideToast(): void {
		this.toast?.classList.remove('on');
	}
}
