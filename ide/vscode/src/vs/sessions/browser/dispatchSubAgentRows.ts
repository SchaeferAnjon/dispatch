/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sub-agents a session sent out, as rows under it in the sessions list (kanban
 *  design/terminal-merge, direction A, A3; learned from Orca's session list, which lists them there too).
 *
 *  A sub-agent is a chat of the session that a tool started (ChatOriginKind.Tool): the Agent Host gives a chat
 *  session's sub-agents so, and a terminal session running Claude Code gives its own from Claude Code's record
 *  (contrib/dispatchTerminal). VS Code keeps them out of the list; here they come back as rows under their
 *  session: the status blocks, what it was sent to do, "· model", and how long it has run. The ones still working
 *  come first; finished ones fold into one "Show N finished" row. The row of the session ends with a small count
 *  ("13") that folds them all away and back.
 *
 *  A sub-agent's row starts with Dispatch's state block (contrib/dispatchBlocks, set through `subAgentRowBlocks`):
 *  the purple sub-agent block breathing while it works, the teal done block once it is back, the coral stopped
 *  block when it failed. Pointing at it shows the shared hover card: what it was sent to do, how long, the model,
 *  who sent it.
 *
 *  The sessions list (contrib/sessions/browser/views/sessionsList.ts) calls `withSubAgentRows` for the chats it
 *  shows under a session, `decorateSubAgentRow` when it draws a chat row, `onSubAgentRowClick` before it opens
 *  one, and listens to `onDidChangeSubAgentRows`.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSubAgentRows.css';
import * as DOM from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Codicon } from '../../base/common/codicons.js';
import { Emitter, Event } from '../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { autorun, constObservable, IReader } from '../../base/common/observable.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { HoverPosition } from '../../base/browser/ui/hover/hoverWidget.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { setupDispatchTextHover } from '../../workbench/browser/dispatchHoverCard.js';
import { ChatInteractivity, ChatOriginKind, IChat, ISession, SessionStatus } from '../services/sessions/common/session.js';

/** A sub-agent's state as a block: set by contrib/dispatchBlocks (this layer does not import contrib). */
export type SubAgentRowState = 'sub-agent' | 'done' | 'stopped';
export const subAgentRowBlocks: { render?: (state: SubAgentRowState) => HTMLElement } = {};

/**
 * Set by the sessions list (contrib/sessions/browser/views/dispatchProjectWork.ts): `elsewhere` says a working
 * sub-agent is listed under the project it works for instead of under its session (one sent out from another project
 * or from the Assistant), `notes` what its hover card adds (the task it is on).
 */
export const subAgentRowWork: {
	elsewhere?: (session: ISession, chat: IChat, reader?: IReader) => boolean;
	notes?: (chat: IChat) => readonly string[];
} = {};

const MORE_SCHEME = 'dispatch-subagents';

/** Sessions whose sub-agents are folded away (the count on the row), and those showing their finished ones too. */
const folded = new Set<string>();
const showingFinished = new Set<string>();
const onDidChange = new Emitter<void>();
/** The rows changed without the sessions changing (a fold, "Show N finished"): the list draws them again. */
export const onDidChangeSubAgentRows: Event<void> = onDidChange.event;

export function isSubAgentChat(chat: IChat, reader?: IReader): boolean {
	return chat.origin?.kind === ChatOriginKind.Tool && chat.interactivity.read(reader) !== ChatInteractivity.Hidden;
}

function isMoreRow(chat: IChat): boolean {
	return chat.resource.scheme === MORE_SCHEME;
}

function working(chat: IChat, reader?: IReader): boolean {
	const s = chat.status.read(reader);
	return s === SessionStatus.InProgress || s === SessionStatus.NeedsInput;
}

/** The session's sub-agents (all of them), oldest first. */
export function subAgentsOf(session: ISession, reader?: IReader): IChat[] {
	const subs = session.chats.read(reader).filter(c => isSubAgentChat(c, reader));
	subs.forEach(c => startOf(c, reader)); // note when each is first seen working, drawn or folded away
	return subs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function subAgentCounts(session: ISession, reader?: IReader): { total: number; working: number } {
	const subs = subAgentsOf(session, reader);
	return { total: subs.length, working: subs.filter(c => working(c, reader)).length };
}

const moreRows = new Map<string, IChat>();

/** A row that is not a chat: "Show 8 finished". Its click shows them (onSubAgentRowClick). */
function moreRow(session: ISession, count: number): IChat {
	const key = `${session.sessionId}:${count}`;
	let row = moreRows.get(key);
	if (!row) {
		const now = new Date(0);
		row = {
			resource: URI.from({ scheme: MORE_SCHEME, path: `/${session.sessionId}`, fragment: 'finished' }),
			createdAt: now,
			title: constObservable(count === 1 ? 'Show 1 finished' : `Show ${count} finished`),
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

/**
 * The chats the list shows under `session`: the ones it shows already (`chats`), then the sub-agents still working,
 * then the finished ones, or one "Show N finished" row for them. None while the session's count is folded.
 */
export function withSubAgentRows(session: ISession, chats: readonly IChat[], reader?: IReader): readonly IChat[] {
	const subs = subAgentsOf(session, reader);
	// a sub-agent that was opened can be among the session's own chats too: its row is this list's, so the fold takes
	// it away as well and an unfolded list does not show it twice (10-08: the count no longer folded an opened one)
	const own = new Set(subs.map(c => c.resource.toString()));
	chats = chats.filter(c => !own.has(c.resource.toString()) && !isSubAgentChat(c));
	if (!subs.length || folded.has(session.sessionId)) {
		return chats;
	}
	const busy = subs.filter(c => working(c, reader) && !subAgentRowWork.elsewhere?.(session, c, reader));
	const done = subs.filter(c => !working(c, reader)).reverse();
	if (showingFinished.has(session.sessionId) || !done.length) {
		return [...chats, ...busy, ...done];
	}
	return [...chats, ...busy, moreRow(session, done.length)];
}

type SubAgentOpener = (session: ISession, chat: IChat) => boolean;
const openers: SubAgentOpener[] = [];

/**
 * A session kind that opens its sub-agents itself (a terminal session shows the record in its own view, it has no
 * chat for it): returns true when it did.
 */
export function registerSubAgentOpener(opener: SubAgentOpener): IDisposable {
	openers.push(opener);
	return toDisposable(() => {
		const i = openers.indexOf(opener);
		if (i >= 0) {
			openers.splice(i, 1);
		}
	});
}

/**
 * A click on a row under a session: true when it was handled here ("Show N finished", or a sub-agent its session kind
 * opens itself), false when the list opens the chat as usual.
 */
export function onSubAgentRowClick(session: ISession, chat: IChat): boolean {
	if (isMoreRow(chat)) {
		showingFinished.add(session.sessionId);
		onDidChange.fire();
		return true;
	}
	return isSubAgentChat(chat) && openers.some(open => open(session, chat));
}

/** The count at the end of a session's row: folds its sub-agents away and back. */
export function toggleSubAgents(sessionId: string): void {
	if (!folded.delete(sessionId)) {
		folded.add(sessionId);
	}
	onDidChange.fire();
}

/**
 * "claude-opus-5" reads "Opus 5", "claude-sonnet-4-5-20250929" "Sonnet 4.5"; a provider's prefix goes
 * ("zhipuai-coding-plan/glm-5.3-flash" reads "glm-5.3-flash"); other names as they are.
 */
export function modelLabel(id: string | undefined): string {
	if (!id) {
		return '';
	}
	id = id.slice(id.lastIndexOf('/') + 1);
	const m = /^(?:claude-)?(opus|sonnet|haiku|fable)((?:-\d{1,2})*)(?:-\d{8})?(?:\[.*\])?$/i.exec(id.trim());
	if (m) {
		const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
		const version = m[2].split('-').filter(Boolean).join('.');
		return version ? `${name} ${version}` : name;
	}
	return id;
}

/** "40s", "12m", "1h 5m". */
export function elapsedLabel(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.floor(s / 60);
	if (m < 60) {
		return `${m}m`;
	}
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Working, back, or stopped with an error (also the Now tab's Agents, contrib/dispatchNow). */
export function subAgentState(chat: IChat, reader?: IReader): SubAgentRowState {
	return working(chat, reader) ? 'sub-agent' : chat.status.read(reader) === SessionStatus.Error ? 'stopped' : 'done';
}

/**
 * The sub-agent's model, else its session's (a harness that does not name the sub-agent's runs it on the session's):
 * the session's chosen model, else the model its last request went to (`lastModel`, from the list).
 */
function modelOf(chat: IChat, session: ISession | undefined, lastModel: (() => string | undefined) | undefined, reader?: IReader): string {
	return modelLabel(chat.modelId.read(reader) ?? session?.mainChat.read(reader).modelId.read(reader) ?? session?.modelId.read(reader) ?? lastModel?.());
}

/**
 * When a sub-agent started. A terminal session's sub-agents carry it from Claude Code's record; the Agent Host gives
 * a chat's sub-agent the time its summary was made, which can be the session's, so a sub-agent first seen working
 * counts from then (kept for as long as the window is open).
 */
const firstSeenWorking = new Map<string, number>();
/** And when such a one was first seen back (the Agent Host's end of a sub-agent's turn can be its summary's time too). */
const firstSeenBack = new Map<string, number>();
function startOf(chat: IChat, reader?: IReader): number {
	const created = chat.createdAt.getTime();
	if (chat.resource.scheme === 'dispatch-terminal') {
		return created;
	}
	const key = chat.resource.toString();
	const busy = working(chat, reader);
	if (!firstSeenWorking.has(key) && busy) {
		firstSeenWorking.set(key, Math.max(created, Date.now()));
	} else if (firstSeenWorking.has(key) && !busy && !firstSeenBack.has(key)) {
		firstSeenBack.set(key, Date.now());
	}
	return firstSeenWorking.get(key) ?? created;
}

/** How long it has run, counting while it works (also the Now tab's Agents). */
export function subAgentElapsed(chat: IChat, reader?: IReader): number {
	const start = startOf(chat, reader);
	const said = (chat.lastTurnEnd.read(reader) ?? chat.updatedAt.read(reader)).getTime();
	const end = working(chat, reader) ? Date.now() : Math.max(said, firstSeenBack.get(chat.resource.toString()) ?? 0);
	return Math.max(0, end - start);
}

/**
 * A chat row under a session as the list draws it: a sub-agent gets its state block in front, "· model" after its
 * name and how long it has run at the end (counting while it works), and the hover card; "Show N finished" is drawn
 * as a plain link row.
 */
export function decorateSubAgentRow(container: HTMLElement, chat: IChat, store: DisposableStore, session?: ISession, hoverService?: IHoverService, lastModel?: () => string | undefined): void {
	const sub = isSubAgentChat(chat) && !isMoreRow(chat);
	container.classList.toggle('dispatch-subagent', sub);
	container.classList.toggle('dispatch-subagent-more', isMoreRow(chat));
	const titleRow = container.querySelector<HTMLElement>('.session-chat-title-row');
	titleRow?.querySelectorAll('.dispatch-subagent-model, .dispatch-subagent-time, .dispatch-subagent-block').forEach(e => e.remove());
	container.removeAttribute('title');
	container.removeAttribute('aria-label');
	delete container.dataset.dispatchCard;
	if (!sub || !titleRow) {
		return;
	}
	const title = titleRow.querySelector('.session-chat-title');
	const model = DOM.$('span.dispatch-subagent-model');
	title?.after(model);
	const time = DOM.append(titleRow, DOM.$('span.dispatch-subagent-time'));
	// the state block takes the place of the row's status icon (hidden for sub-agent rows in the css)
	const slot = DOM.$('span.dispatch-subagent-block');
	slot.setAttribute('aria-hidden', 'true');
	titleRow.prepend(slot);
	store.add(toDisposable(() => { model.remove(); time.remove(); slot.remove(); }));
	let drawn: SubAgentRowState | undefined;
	let summary = '';
	const draw = (reader?: IReader) => {
		const label = modelOf(chat, session, lastModel, reader);
		model.textContent = label ? `· ${label}` : '';
		const elapsed = elapsedLabel(subAgentElapsed(chat, reader));
		time.textContent = elapsed;
		const state = subAgentState(chat, reader);
		if (state !== drawn && subAgentRowBlocks.render) {
			drawn = state;
			DOM.clearNode(slot);
			slot.appendChild(subAgentRowBlocks.render(state));
		}
		const said = state === 'sub-agent' ? `Working for ${elapsed}` : state === 'stopped' ? `Stopped after ${elapsed}` : `Finished, took ${elapsed}`;
		summary = said;
		container.setAttribute('aria-label', [chat.title.read(reader), label, said].filter(Boolean).join(', '));
		if (!hoverService) {
			container.title = [chat.title.read(reader), label && `Model: ${label}`, said].filter(Boolean).join('\n');
		}
	};
	store.add(autorun(reader => draw(reader)));
	// the time counts on while it works
	const timer = mainWindow.setInterval(() => { if (working(chat)) { draw(); } }, 15_000);
	store.add(toDisposable(() => mainWindow.clearInterval(timer)));
	if (hoverService) {
		store.add(setupDispatchTextHover(hoverService, container, () => {
			const label = modelOf(chat, session, lastModel);
			const title = session?.title.get().replace(/\s+/g, ' ').trim();
			const owner = title && title.length > 48 ? `${title.slice(0, 47).replace(/[\s,.;:!?]+$/, '')}…` : title;
			return {
				head: chat.title.get(),
				headDetail: summary,
				notes: [
					...(subAgentRowWork.notes?.(chat) ?? []),
					label ? `Model: ${label}` : '',
					owner ? `Sent by: ${owner}` : '',
					owner ? 'Click to read what it did. A sub-agent is read only: to steer it, talk to the session that sent it.' : 'Click to read what it did. A sub-agent is read only.',
				].filter(Boolean),
			};
		}, { when: () => true, position: HoverPosition.RIGHT }));
	}
}

/**
 * The count at the end of a session's row: how many sub-agents it sent out ("13"), and how many work, in its tooltip;
 * a click folds them away and back. Empty for a session without any.
 */
export function renderSubAgentCount(container: HTMLElement, session: ISession, store: DisposableStore | undefined): void {
	// right after the session's name (design A3), not at the row's end where the row's own buttons come on hover
	const row = container.parentElement;
	// one button per row, kept across the row's redraws: a click that redraws the row (it selects it) must not lose
	// the button it started on
	let button = row?.querySelector<HTMLButtonElement>(':scope > .dispatch-subagent-count') ?? undefined;
	if (!button) {
		button = DOM.$<HTMLButtonElement>('button.dispatch-subagent-count', { type: 'button' });
		DOM.append(button, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		DOM.append(button, DOM.$('span.dispatch-subagent-count-n'));
		const title = row?.querySelector(':scope > .session-title');
		if (title) {
			title.after(button);
		} else {
			container.prepend(button);
		}
	}
	const b = button;
	const chevron = b.firstElementChild as HTMLElement;
	const number = b.lastElementChild as HTMLElement;
	const draw = (reader?: IReader) => {
		const { total, working: busy } = subAgentCounts(session, reader);
		b.style.display = total ? '' : 'none';
		row?.classList.toggle('dispatch-has-subagents', !!total);
		number.textContent = String(total);
		const shut = folded.has(session.sessionId);
		chevron.classList.toggle('shut', shut);
		const what = `${total} sub-agent${total === 1 ? '' : 's'}, ${busy} working`;
		b.title = `${what}. Click to ${shut ? 'show' : 'hide'} them.`;
		b.setAttribute('aria-label', b.title);
	};
	b.onclick = e => {
		e.stopPropagation();
		e.preventDefault();
		toggleSubAgents(session.sessionId);
		draw();
	};
	// the row opens its session when it is pressed: the count keeps the press to itself
	b.onpointerdown = e => e.stopPropagation();
	b.onmousedown = e => e.stopPropagation();
	if (store) {
		store.add(autorun(reader => draw(reader)));
	} else {
		draw();
	}
}

