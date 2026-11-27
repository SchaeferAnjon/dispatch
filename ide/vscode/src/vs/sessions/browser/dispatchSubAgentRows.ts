/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sub-agents a session sent out, as rows under it in the sessions list (task-518qw; the person
 *  2026-11-16: which sub-agents run now, under the session, like Orca, drawn like the block in the conversation).
 *
 *  Under its session, always (it never moves to another project's group): one row per sub-agent that works, VS Code's
 *  sub-agent pill (dispatchSubAgentPill.ts: the spinner, what it was sent to do, "Working for 3m 40s", the step it is
 *  on under it); the ones back fold into one "N finished" row, which opens them in place and has an × that puts them
 *  away; an opened finished one has its own ×. Put away is kept for the window's profile. A click on a row opens the
 *  sub-agent read only in a tab next to its session's conversation, as "Open Subagent" in the block does.
 *
 *  The sessions list (contrib/sessions/browser/views/sessionsList.ts) calls `withSubAgentRows` for the chats it
 *  shows under a session, `subAgentRowHeight` for a row's height, `decorateSubAgentRow` when it draws a chat row,
 *  `onSubAgentRowClick` before it opens one, and listens to `onDidChangeSubAgentRows`.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSubAgentRows.css';
import * as DOM from '../../base/browser/dom.js';
import { Codicon } from '../../base/common/codicons.js';
import { Emitter, Event } from '../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { autorun, constObservable, IReader } from '../../base/common/observable.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ChatInteractivity, ChatOriginKind, IChat, ISession, SessionStatus } from '../services/sessions/common/session.js';
import { DispatchSubAgentPill, renderFinishedToggle } from './dispatchSubAgentPill.js';
import { isSubAgentChat, isSubAgentWorking, subAgentsOf, subAgentState } from './dispatchSubAgents.js';

const MORE_SCHEME = 'dispatch-subagents';

/** The heights of the rows (the list's row gap comes on top): a working one has the step line under its pill. */
const WORKING_HEIGHT = 56;
const BACK_HEIGHT = 28;
const MORE_HEIGHT = 28;

/** Sessions showing their finished sub-agents. */
const showingFinished = new Set<string>();
/** Sub-agents put away (their chat resource), kept by `bindSubAgentRowStorage`. */
let putAway = new Set<string>();
let savePutAway: ((ids: readonly string[]) => void) | undefined;
const onDidChange = new Emitter<void>();
/** The rows changed without the sessions changing ("N finished" opened, one put away): the list draws them again. */
export const onDidChangeSubAgentRows: Event<void> = onDidChange.event;

/** How a row opens its sub-agent: set by contrib/dispatchSubagents (dispatchSubAgentPill.openSubAgent). */
export const subAgentRowOpen: { open?: (session: ISession, chat: IChat) => void } = {};

/** Where what was put away is kept (contrib/dispatchSubagents gives it the storage). */
export function bindSubAgentRowStorage(ids: readonly string[], save: (ids: readonly string[]) => void): void {
	putAway = new Set(ids);
	savePutAway = save;
}

function putAwayChats(chats: readonly IChat[]): void {
	for (const chat of chats) {
		putAway.add(chat.resource.toString());
	}
	// the newest few hundred are enough: an old sub-agent's chat is not shown again anyway
	savePutAway?.([...putAway].slice(-300));
	onDidChange.fire();
}

function isMoreRow(chat: IChat): boolean {
	return chat.resource.scheme === MORE_SCHEME;
}

const moreRows = new Map<string, IChat>();

/** A row that is not a chat: "N finished". Its click opens or closes them (onSubAgentRowClick). */
function moreRow(session: ISession, count: number): IChat {
	const key = `${session.sessionId}:${count}`;
	let row = moreRows.get(key);
	if (!row) {
		const now = new Date(0);
		row = {
			resource: URI.from({ scheme: MORE_SCHEME, path: `/${session.sessionId}`, fragment: String(count) }),
			createdAt: now,
			title: constObservable(localize('dispatchSubAgentRows.finished', "{0} finished", count)),
			updatedAt: constObservable(now),
			status: constObservable(SessionStatus.Completed),
			changes: constObservable([]),
			checkpoints: constObservable(undefined),
			modelId: constObservable(undefined),
			modelSource: constObservable(undefined),
			mode: constObservable(undefined),
			isArchived: constObservable(false),
			isRead: constObservable(true),
			interactivity: constObservable(ChatInteractivity.ReadOnly),
			description: constObservable(undefined),
			lastTurnEnd: constObservable(undefined),
			origin: { kind: ChatOriginKind.Tool },
			capabilities: constObservable({ canRename: false, canDelete: false }),
		};
		moreRows.set(key, row);
	}
	return row;
}

/** The finished sub-agents of `session` not put away, in the order they were sent out. */
function finishedOf(session: ISession, reader?: IReader): IChat[] {
	return subAgentsOf(session, reader).filter(c => !isSubAgentWorking(c, reader) && !putAway.has(c.resource.toString()));
}

/**
 * The chats the list shows under `session`: the ones it shows already (`chats`), then the sub-agents that work, then
 * one "N finished" row and, opened, the finished ones.
 */
export function withSubAgentRows(session: ISession, chats: readonly IChat[], reader?: IReader): readonly IChat[] {
	const subs = subAgentsOf(session, reader);
	// a sub-agent that was opened can be among the session's own chats too: its row is this list's
	const own = new Set(subs.map(c => c.resource.toString()));
	chats = chats.filter(c => !own.has(c.resource.toString()) && !isSubAgentChat(c));
	const busy = subs.filter(c => isSubAgentWorking(c, reader));
	const done = finishedOf(session, reader);
	if (!done.length) {
		return [...chats, ...busy];
	}
	return [...chats, ...busy, moreRow(session, done.length), ...(showingFinished.has(session.sessionId) ? done : [])];
}

/** A row's height under a session; undefined for a chat that is not a sub-agent. */
export function subAgentRowHeight(chat: IChat): number | undefined {
	if (isMoreRow(chat)) {
		return MORE_HEIGHT;
	}
	if (!isSubAgentChat(chat)) {
		return undefined;
	}
	return isSubAgentWorking(chat) ? WORKING_HEIGHT : BACK_HEIGHT;
}

/**
 * A click on a row under a session: true when it was handled here ("N finished", or a sub-agent, which opens next to
 * the conversation), false when the list opens the chat as usual.
 */
export function onSubAgentRowClick(session: ISession, chat: IChat): boolean {
	if (isMoreRow(chat)) {
		if (!showingFinished.delete(session.sessionId)) {
			showingFinished.add(session.sessionId);
		}
		onDidChange.fire();
		return true;
	}
	if (isSubAgentChat(chat) && subAgentRowOpen.open) {
		subAgentRowOpen.open(session, chat);
		return true;
	}
	return false;
}

/**
 * A chat row under a session as the list draws it: a sub-agent is VS Code's pill in place of the row's title line
 * (a finished one with an × that puts it away); "N finished" is the same toggle as in the strip and Now.
 */
export function decorateSubAgentRow(container: HTMLElement, chat: IChat, store: DisposableStore, session: ISession, instantiationService: IInstantiationService): void {
	container.querySelectorAll(':scope > .dispatch-subagent-pill, :scope > .dispatch-subagent-finished, :scope > .dispatch-subagent-dismiss').forEach(e => e.remove());
	const sub = isSubAgentChat(chat) && !isMoreRow(chat);
	container.classList.toggle('dispatch-subagent', sub);
	container.classList.toggle('dispatch-subagent-more', isMoreRow(chat));
	if (isMoreRow(chat)) {
		const open = showingFinished.has(session.sessionId);
		const row = renderFinishedToggle(container, finishedOf(session).length, open, store,
			() => onSubAgentRowClick(session, chat),
			() => putAwayChats(finishedOf(session)));
		store.add(toDisposable(() => row.remove()));
		return;
	}
	if (!sub) {
		return;
	}
	const pill = store.add(instantiationService.createInstance(DispatchSubAgentPill, session, chat));
	container.appendChild(pill.element);
	store.add(toDisposable(() => pill.element.remove()));
	const drawnWorking = isSubAgentWorking(chat);
	container.classList.toggle('working', drawnWorking);
	if (!drawnWorking) {
		const dismiss = DOM.append(container, DOM.$<HTMLButtonElement>(`button.dispatch-subagent-dismiss${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button' }));
		dismiss.title = localize('dispatchSubAgentRows.dismiss', "Clear this sub-agent");
		dismiss.setAttribute('aria-label', dismiss.title);
		store.add(DOM.addDisposableListener(dismiss, DOM.EventType.MOUSE_DOWN, e => DOM.EventHelper.stop(e, true)));
		store.add(DOM.addDisposableListener(dismiss, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			putAwayChats([chat]);
		}));
		store.add(toDisposable(() => dismiss.remove()));
	}
	// the pill follows its state and step; once it ends the row moves into "N finished" (the list draws it again)
	store.add(autorun(reader => {
		subAgentState(chat, reader);
		chat.title.read(reader);
		pill.update();
	}));
	const timer = DOM.getWindow(container).setInterval(() => isSubAgentWorking(chat) && pill.update(), 1000);
	store.add(toDisposable(() => DOM.getWindow(container).clearInterval(timer)));
}
