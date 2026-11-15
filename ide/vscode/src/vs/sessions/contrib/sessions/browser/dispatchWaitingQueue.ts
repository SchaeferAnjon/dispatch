/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the queue bar over a session opened from Waiting for you (design/waiting/redesign,
 *  direction A: "‹ Waiting for you · 2 of 6 · Prev · Next").
 *
 *  32 high, the first thing in the session view's header: back to the page, where this session stands
 *  in the queue (the sessions that wait, in the page's order) and which agent runs it (its Claude or
 *  Codex icon), then "esc back", Prev and Next. Next turns solid once the session no longer waits (the
 *  person answered it here). Esc goes back to the page, where it was and with the same row in focus,
 *  while the chat input is empty. The bar goes when the person opens another session or a page.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { CustomViewVisibleContext } from '../../../common/contextkeys.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { DISPATCH_OPEN_TASK_COMMAND, sessionForTask } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { backToDispatchWaiting, setDispatchWaitingReturn } from './dispatchCustomViewBack.js';
import { dispatchWaitingQueue, dispatchWaitingVisible, hideDispatchWaitingItems, IDispatchWaitingItem, isDesignDecide, waitingQueueItems, waitingSessionKey } from './dispatchWaitingModel.js';

const $ = DOM.$;

/** True while a session opened from Waiting for you shows its queue bar. */
export const DispatchWaitingQueueContext = new RawContextKey<boolean>('dispatchWaitingQueue', false, localize('dispatchWaitingQueue', "Whether the session was opened from Waiting for you"));

// ---- opening a row --------------------------------------------------------------------------------

/** The Agents-window session of a waiting row. */
function sessionOf(sessionsManagementService: ISessionsManagementService, item: IDispatchWaitingItem) {
	const key = waitingSessionKey(item.resource);
	return key ? sessionsManagementService.getSessions().find(s => waitingSessionKey(s.resource) === key) : undefined;
}

/**
 * Open a row: a session that waits shows with the queue bar over it; an Only-you task shows the
 * conversation it came from (what led to it), or its task page when that conversation is not here.
 */
export async function openWaitingItem(accessor: ServicesAccessor, item: IDispatchWaitingItem): Promise<void> {
	const management = accessor.get(ISessionsManagementService);
	const sessionsService = accessor.get(ISessionsService);
	const customViewService = accessor.get(ICustomViewService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const order = waitingQueueItems(dispatchWaitingVisible.get()).map(i => i.id);
	if (item.kind === 'only_you') {
		const origin = item.session ? sessionForTask(management, item.session) : undefined;
		if (origin) {
			dispatchWaitingQueue.set({ current: item.id, resource: origin.resource.toString(), order }, undefined);
			customViewService.hideCustomView();
			await sessionsService.openSession(origin.resource);
			return;
		}
		if (item.task) {
			// the task page, "‹ Waiting for you" on top
			setDispatchWaitingReturn(true);
			await commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, item.task, 'waiting');
		}
		return;
	}
	if (isDesignDecide(item)) {
		// a design direction to pick (`dispatch flow design`): its prototype in the side pane, next to the page
		// (which stays where it is: dispatchOpenPath), or its task page when it has none
		if (item.open) {
			await commandService.executeCommand('_dispatch.openPath', item.open, { fromDocs: true, task: item.task });
		} else if (item.task) {
			setDispatchWaitingReturn(true);
			await commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, item.task, 'waiting');
		}
		return;
	}
	const session = item.source === 'ide' ? sessionOf(management, item) : undefined;
	if (!session) {
		notificationService.info(localize('dispatchWaiting.noSession', "This session is not in the Agents window."));
		return;
	}
	dispatchWaitingQueue.set({ current: item.id, resource: session.resource.toString(), order }, undefined);
	// the page goes first: a page still up would redraw without the row and forget where the person was
	customViewService.hideCustomView();
	if (item.kind === 'unread') {
		// opening it is reading it
		hideDispatchWaitingItems([item.id]);
	}
	await sessionsService.openSession(session.resource);
}

/** Where Prev / Next go: the row before or after this one in the queue (a handled one keeps its place). */
function neighbour(dir: 1 | -1): IDispatchWaitingItem | undefined {
	const queue = dispatchWaitingQueue.get();
	const live = waitingQueueItems(dispatchWaitingVisible.get());
	if (!queue || !live.length) {
		return undefined;
	}
	const at = live.findIndex(i => i.id === queue.current);
	if (at >= 0) {
		return live[at + dir];
	}
	// this one was handled (or is an Only-you task): step from where it stood in the page's order
	const pos = queue.order.indexOf(queue.current);
	const liveIds = new Set(live.map(i => i.id));
	if (pos >= 0) {
		const around = dir > 0 ? queue.order.slice(pos + 1) : queue.order.slice(0, pos).reverse();
		const id = around.find(x => liveIds.has(x));
		if (id) {
			return live.find(i => i.id === id);
		}
	}
	return dir > 0 ? live[0] : undefined;
}

async function go(accessor: ServicesAccessor, dir: 1 | -1): Promise<void> {
	const next = neighbour(dir);
	if (!next) {
		if (dir > 0) {
			// nothing left to walk through: back to the page
			backToDispatchWaiting(accessor);
		}
		return;
	}
	await openWaitingItem(accessor, next);
}

function backToPage(accessor: ServicesAccessor): void {
	backToDispatchWaiting(accessor);
}

class DispatchWaitingQueueBar extends Disposable {
	static readonly ID = 'dispatch.contrib.waitingQueueBar';

	private readonly bar: HTMLElement;
	private readonly pos: HTMLElement;
	private readonly prev: HTMLButtonElement;
	private readonly next: HTMLButtonElement;
	/** The row whose session showed: from then on another session means the person left the queue. */
	private matched: string | undefined;
	private retry: number | undefined;

	constructor(
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@ICustomViewService customViewService: ICustomViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const context = DispatchWaitingQueueContext.bindTo(contextKeyService);
		const store = this._register(new DisposableStore());
		this.bar = $('.dispatch-waiting-queue');
		this.bar.setAttribute('role', 'navigation');
		this.bar.setAttribute('aria-label', localize('dispatchWaitingQueue.aria', "Waiting for you queue"));
		const back = DOM.append(this.bar, $<HTMLButtonElement>('button.dispatch-waiting-btn.xs.ghost.dispatch-waiting-queue-back', { type: 'button' }));
		back.appendChild(renderIcon(Codicon.arrowLeft));
		DOM.append(back, $('span', undefined, localize('dispatchWaitingQueue.back', "Waiting for you")));
		this.pos = DOM.append(this.bar, $('span.dispatch-waiting-queue-pos'));
		DOM.append(this.bar, $('span.dispatch-waiting-sp'));
		const hint = DOM.append(this.bar, $('span.dispatch-waiting-queue-hint'));
		DOM.append(hint, $('kbd.dispatch-waiting-kbd', undefined, 'esc'));
		DOM.append(hint, $('span', undefined, localize('dispatchWaitingQueue.escBack', "back")));
		this.prev = DOM.append(this.bar, $<HTMLButtonElement>('button.dispatch-waiting-btn.xs.ghost.dispatch-waiting-queue-prev', { type: 'button' }));
		// a narrow session keeps only the arrow (the CSS decides): the word goes, the button stays
		this.prev.appendChild(renderIcon(Codicon.chevronLeft));
		DOM.append(this.prev, $('span', undefined, localize('dispatchWaitingQueue.prev', "Prev")));
		this.prev.title = localize('dispatchWaitingQueue.prevTitle', "Previous");
		this.next = DOM.append(this.bar, $<HTMLButtonElement>('button.dispatch-waiting-btn.xs.outline.dispatch-waiting-queue-next', { type: 'button' }));
		DOM.append(this.next, $('span', undefined, localize('dispatchWaitingQueue.next', "Next")));
		this.next.appendChild(renderIcon(Codicon.chevronRight));
		store.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => instantiationService.invokeFunction(backToPage)));
		store.add(DOM.addDisposableListener(this.prev, DOM.EventType.CLICK, () => instantiationService.invokeFunction(a => go(a, -1)).catch(onUnexpectedError)));
		store.add(DOM.addDisposableListener(this.next, DOM.EventType.CLICK, () => instantiationService.invokeFunction(a => go(a, 1)).catch(onUnexpectedError)));
		// Esc goes back to the page (the bar says so), also from inside the question the agent asked: that card
		// takes Esc as "skip the question" (chatQuestionCarouselPart.ts), and the agent would go on without an answer
		this._register(DOM.addDisposableListener(mainWindow, DOM.EventType.KEY_DOWN, e => {
			if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !context.get()) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (!target?.closest?.('.chat-question-carousel-container')) {
				return;
			}
			e.preventDefault();
			e.stopImmediatePropagation();
			instantiationService.invokeFunction(backToPage);
		}, true));
		this._register(toDisposable(() => {
			this.bar.remove();
			if (this.retry !== undefined) {
				mainWindow.clearTimeout(this.retry);
			}
		}));

		this._register(autorun(reader => {
			const queue = dispatchWaitingQueue.read(reader);
			const active = this.sessionsService.activeSession.read(reader);
			const page = customViewService.activeCustomView.read(reader);
			dispatchWaitingVisible.read(reader);
			if (!queue) {
				this.matched = undefined;
			}
			const same = !!active && !!queue?.resource && waitingSessionKey(active.resource) === waitingSessionKey(queue.resource);
			if (queue && !page && active && !same && this.matched === queue.current) {
				// the person opened another session: the queue is over
				dispatchWaitingQueue.set(undefined, undefined);
				return;
			}
			if (!queue || page || !same || !active) {
				this.detach();
				context.set(false);
				return;
			}
			this.matched = queue.current;
			context.set(true);
			this.update(queue.current);
			this.attach(active.sessionId, 0);
		}));
	}

	private update(current: string): void {
		const live = waitingQueueItems(dispatchWaitingVisible.get());
		const at = live.findIndex(i => i.id === current);
		this.pos.textContent = at >= 0
			? localize('dispatchWaitingQueue.pos', "{0} of {1}", at + 1, live.length)
			: live.length ? localize('dispatchWaitingQueue.left', "{0} left", live.length) : localize('dispatchWaitingQueue.none', "Nothing left");
		this.prev.disabled = !neighbour(-1);
		// handled here: Next is the way on
		this.next.classList.toggle('fill', at < 0);
		this.next.classList.toggle('outline', at >= 0);
		this.next.title = neighbour(1) ? localize('dispatchWaitingQueue.nextTitle', "The next one waiting") : localize('dispatchWaitingQueue.backTitle', "Nothing else waits: back to the page");
	}

	/** The bar goes first in the session view's header, so the view lays the chat out below it. */
	private attach(sessionId: string, attempt: number): void {
		if (this.retry !== undefined) {
			mainWindow.clearTimeout(this.retry);
			this.retry = undefined;
		}
		const header = this.sessionsPartService.getSessionView(sessionId)?.element.querySelector<HTMLElement>('.chat-composite-bar.session-header-bar');
		if (!header) {
			// the session's view is still coming up
			if (attempt < 20) {
				this.retry = mainWindow.setTimeout(() => this.attach(sessionId, attempt + 1), 100);
			}
			return;
		}
		if (this.bar.parentElement !== header) {
			header.insertBefore(this.bar, header.firstChild);
		}
	}

	private detach(): void {
		if (this.retry !== undefined) {
			mainWindow.clearTimeout(this.retry);
			this.retry = undefined;
		}
		this.bar.remove();
	}
}

registerWorkbenchContribution2(DispatchWaitingQueueBar.ID, DispatchWaitingQueueBar, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.waiting.queueBack',
			title: localize2('dispatchWaitingQueue.backAction', "Back to Waiting for You"),
			precondition: DispatchWaitingQueueContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				// the chat input keeps Esc while it holds text or a suggestion is open
				when: ContextKeyExpr.and(IsSessionsWindowContext, DispatchWaitingQueueContext, CustomViewVisibleContext.negate(),
					ChatContextKeys.inputHasText.negate(), ContextKeyExpr.not('suggestWidgetVisible')),
			},
		});
	}
	override run(accessor: ServicesAccessor): void {
		backToPage(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.waiting.queueNext', title: localize2('dispatchWaitingQueue.nextAction', "Next Waiting for You"), precondition: DispatchWaitingQueueContext });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return go(accessor, 1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.waiting.queuePrev', title: localize2('dispatchWaitingQueue.prevAction', "Previous Waiting for You"), precondition: DispatchWaitingQueueContext });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return go(accessor, -1);
	}
});
