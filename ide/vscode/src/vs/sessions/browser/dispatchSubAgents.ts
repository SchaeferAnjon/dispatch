/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sub-agents a session sent out and how each is doing, for the three places that show them
 *  (task-518qw): the rows under the session in the sidebar (dispatchSubAgentRows.ts), the strip above the message box
 *  (contrib/dispatchSubagents) and the Now tab (contrib/dispatchNow). Each draws them as VS Code's own sub-agent pill
 *  (dispatchSubAgentPill.ts).
 *
 *  A sub-agent is a chat of the session that a tool started (ChatOriginKind.Tool): the Agent Host gives a chat
 *  session's so, and a terminal session running Claude Code gives its own from Claude Code's record
 *  (contrib/dispatchTerminal, which opens them itself through `registerSubAgentOpener`). Whether one works is its chat's
 *  status, which the Agent Host ends when the engine says it ended (dispatchSubagentEnd.ts for Claude's background ones).
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IReader } from '../../base/common/observable.js';
import { ChatInteractivity, ChatOriginKind, IChat, ISession, SessionStatus } from '../services/sessions/common/session.js';

/** Working, back, or stopped with an error. */
export type SubAgentState = 'sub-agent' | 'done' | 'stopped';

export function isSubAgentChat(chat: IChat, reader?: IReader): boolean {
	return chat.origin?.kind === ChatOriginKind.Tool && chat.interactivity.read(reader) !== ChatInteractivity.Hidden;
}

export function isSubAgentWorking(chat: IChat, reader?: IReader): boolean {
	const s = chat.status.read(reader);
	return s === SessionStatus.InProgress || s === SessionStatus.NeedsInput;
}

/** The session's sub-agents (all of them), oldest first. */
export function subAgentsOf(session: ISession, reader?: IReader): IChat[] {
	const subs = session.chats.read(reader).filter(c => isSubAgentChat(c, reader));
	subs.forEach(c => subAgentStart(c, reader)); // note when each is first seen working, drawn or not
	return subs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function subAgentState(chat: IChat, reader?: IReader): SubAgentState {
	return isSubAgentWorking(chat, reader) ? 'sub-agent' : chat.status.read(reader) === SessionStatus.Error ? 'stopped' : 'done';
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

/** True when the sub-agent's session kind opened it itself. */
export function openSubAgentElsewhere(session: ISession, chat: IChat): boolean {
	return openers.some(open => open(session, chat));
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

/**
 * When a sub-agent started. A terminal session's sub-agents carry it from Claude Code's record; the Agent Host gives
 * a chat's sub-agent the time its summary was made, which can be the session's, so a sub-agent first seen working
 * counts from then (kept for as long as the window is open).
 */
const firstSeenWorking = new Map<string, number>();
/** And when such a one was first seen back (the Agent Host's end of a sub-agent's turn can be its summary's time too). */
const firstSeenBack = new Map<string, number>();
export function subAgentStart(chat: IChat, reader?: IReader): number {
	const created = chat.createdAt.getTime();
	if (chat.resource.scheme === 'dispatch-terminal') {
		return created;
	}
	const key = chat.resource.toString();
	const busy = isSubAgentWorking(chat, reader);
	if (!firstSeenWorking.has(key) && busy) {
		firstSeenWorking.set(key, Math.max(created, Date.now()));
	} else if (firstSeenWorking.has(key) && !busy && !firstSeenBack.has(key)) {
		firstSeenBack.set(key, Date.now());
	}
	return firstSeenWorking.get(key) ?? created;
}

/** How long it has run, counting while it works. */
export function subAgentElapsed(chat: IChat, reader?: IReader): number {
	const start = subAgentStart(chat, reader);
	const said = (chat.lastTurnEnd.read(reader) ?? chat.updatedAt.read(reader)).getTime();
	const end = isSubAgentWorking(chat, reader) ? Date.now() : Math.max(said, firstSeenBack.get(chat.resource.toString()) ?? 0);
	return Math.max(0, end - start);
}
