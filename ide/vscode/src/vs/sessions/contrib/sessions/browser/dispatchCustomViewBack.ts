/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the way back from a page in the middle of the Agents window (Waiting for you,
 *  Projects, a project, the task graph, a task, an Archive) to the session it was opened over
 *  (patches/425-waiting.patch).
 *
 *  When a custom view comes up over a session, that session is remembered. `dispatch.customView.back`
 *  closes the page and shows that session again (the chat keeps its scroll: it was only hidden). Esc
 *  runs it while a page is shown and no input has the focus, and the title bar's ← (sessions.goBack)
 *  runs it too while a page is shown (sessionsActions.ts). The task page and the task graph put the
 *  same thing at their top: "‹ <session title>".
 *
 *  A page opened from Waiting for you (an Only-you task's task page) goes back to Waiting for you
 *  instead: the page it came from, where it was (setDispatchWaitingReturn).
 *
 *  Waiting for you replaced by something else (a session opened from the sidebar, a new session, a
 *  reply): the title bar's ← goes back to it, where it was and with the same row in focus, for as
 *  long as the session that took its place is still the one shown. A session opened from the page
 *  itself (its queue bar) goes back the same way: ←, Esc and "‹ Waiting for you" all end in
 *  {@link backToDispatchWaiting}.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AuxiliaryBarFocusContext, EditorAreaFocusContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { CustomViewVisibleContext } from '../../../common/contextkeys.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export const DISPATCH_CUSTOM_VIEW_BACK_COMMAND = 'dispatch.customView.back';

export interface IDispatchCustomViewOrigin {
	readonly resource: URI;
	readonly title: string;
}

const origin = observableValue<IDispatchCustomViewOrigin | undefined>('dispatchCustomViewOrigin', undefined);

/** The shown page was opened from Waiting for you: back goes there (the Waiting for you view's id). */
const DISPATCH_WAITING_VIEW_ID = 'dispatch.waitingForYou';
let waitingReturn = false;
export function setDispatchWaitingReturn(value: boolean): void {
	waitingReturn = value;
}
/** The session the shown page was opened over (undefined: none, e.g. the new-session view). */
export const dispatchCustomViewOrigin: IObservable<IDispatchCustomViewOrigin | undefined> = origin;

/** The title bar's ← goes back to Waiting for you (it was replaced, or a session was opened from it). */
export const DispatchBackToWaitingContext = new RawContextKey<boolean>('dispatchBackToWaiting', false, localize('dispatchBackToWaiting', "Whether Back goes to Waiting for you"));
/** Set by the queue bar over a session opened from Waiting for you (dispatchWaitingQueue.ts). */
const WAITING_QUEUE_CONTEXT = 'dispatchWaitingQueue';

/**
 * Waiting for you was replaced by something other than a way back: the session shown instead (its
 * resource, '' for the new-session view). It settles on the session that took the page's place a
 * moment after; once another session shows, the way back is over.
 */
interface IWaitingReplaced {
	session: string;
	settled: boolean;
}
let replaced: IWaitingReplaced | undefined;
/** A way back is closing the page right now: that is not "replaced". */
let leavingBack = false;
const SETTLE_MS = 1500;
let backToWaitingKey: IContextKey<boolean> | undefined;

function setReplaced(value: IWaitingReplaced | undefined): void {
	replaced = value;
	backToWaitingKey?.set(!!value);
}

class DispatchCustomViewOriginTracker extends Disposable {
	static readonly ID = 'dispatch.contrib.customViewOrigin';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
		@ISessionsService sessionsService: ISessionsService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		backToWaitingKey = DispatchBackToWaitingContext.bindTo(contextKeyService);
		this._register(toDisposable(() => backToWaitingKey = undefined));
		let shown: string | undefined;
		let settleTimer: number | undefined;
		this._register(toDisposable(() => mainWindow.clearTimeout(settleTimer)));
		const sessionKey = () => sessionsService.activeSession.get()?.resource.toString() ?? '';
		this._register(autorun(reader => {
			const view = customViewService.activeCustomView.read(reader);
			if (view && !shown) {
				// a page comes up over a session: remember that session (one page leading to another keeps it)
				const session = sessionsService.activeSession.get();
				origin.set(session ? { resource: session.resource, title: session.title.get() } : undefined, undefined);
			}
			if (!view || view.id === DISPATCH_WAITING_VIEW_ID) {
				// closed, or back on Waiting for you: nothing to return to any more
				waitingReturn = false;
			}
			if (view) {
				// a page is shown (Waiting for you again, or another one): no way back to remember
				setReplaced(undefined);
			} else if (shown === DISPATCH_WAITING_VIEW_ID && !leavingBack) {
				// Waiting for you gave way to a session: ← comes back to it
				setReplaced({ session: sessionKey(), settled: false });
				mainWindow.clearTimeout(settleTimer);
				settleTimer = mainWindow.setTimeout(() => {
					if (replaced && !replaced.settled) {
						replaced.session = sessionKey();
						replaced.settled = true;
					}
				}, SETTLE_MS);
			}
			shown = view?.id;
		}));
		// the session that took Waiting for you's place: another one after it ends the way back
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			const key = session?.resource.toString() ?? '';
			if (!replaced || customViewService.activeCustomView.get()) {
				return;
			}
			if (!replaced.settled) {
				replaced.session = key;
			} else if (key !== replaced.session) {
				setReplaced(undefined);
			}
		}));
		// a session opened while a page is shown (a task's session, a session's graph) is where back goes
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			if (session && customViewService.activeCustomView.get()) {
				origin.set({ resource: session.resource, title: session.title.get() }, undefined);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchCustomViewOriginTracker.ID, DispatchCustomViewOriginTracker, WorkbenchPhase.AfterRestored);

/**
 * Back to Waiting for you, where it was: the page rebuilds from its memory (dispatchWaitingPageMemory:
 * the scroll, the row in focus, Only you expanded). Every way back to it ends here.
 */
export function backToDispatchWaiting(accessor: ServicesAccessor): void {
	waitingReturn = false;
	setReplaced(undefined);
	accessor.get(ICustomViewService).showCustomView(DISPATCH_WAITING_VIEW_ID);
}

/**
 * The title bar's ← with no page shown: back to Waiting for you when a session was opened from it
 * (its queue bar is up) or took its place. False when neither, and Back goes on through the sessions.
 */
export function backToDispatchWaitingIfLeft(accessor: ServicesAccessor): boolean {
	const fromQueue = !!accessor.get(IContextKeyService).getContextKeyValue<boolean>(WAITING_QUEUE_CONTEXT);
	if (!fromQueue && !replaced) {
		return false;
	}
	backToDispatchWaiting(accessor);
	return true;
}

/** Close the shown page and show the session it was opened over. */
export async function backFromCustomView(accessor: ServicesAccessor): Promise<void> {
	const customViewService = accessor.get(ICustomViewService);
	const sessionsService = accessor.get(ISessionsService);
	const from = origin.get();
	if (waitingReturn && customViewService.activeCustomView.get()?.id !== DISPATCH_WAITING_VIEW_ID) {
		backToDispatchWaiting(accessor);
		return;
	}
	waitingReturn = false;
	leavingBack = true;
	try {
		customViewService.hideCustomView();
	} finally {
		leavingBack = false;
	}
	if (from && sessionsService.activeSession.get()?.resource.toString() !== from.resource.toString()) {
		await sessionsService.openSession(from.resource);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_CUSTOM_VIEW_BACK_COMMAND,
			title: localize2('dispatchCustomViewBack', "Back to the Session"),
			precondition: CustomViewVisibleContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				// not while the side pane next to the page has the keyboard (a document, a web page there takes its own Esc)
				when: ContextKeyExpr.and(IsSessionsWindowContext, CustomViewVisibleContext, InputFocusedContext.negate(), EditorAreaFocusContext.negate(), AuxiliaryBarFocusContext.negate()),
			},
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return backFromCustomView(accessor);
	}
});
