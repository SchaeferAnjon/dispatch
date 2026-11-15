/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session that works or waits for the person is never folded away in the sessions list (design/
 *  home-now direction A, 2026-11-11, task-0v1o9: the left side bar says what goes on on the whole Mac). It does not
 *  go into a group's "+N more" (sessionsList.ts passes `isLiveSession` to limitSessionsForList), and while its folder
 *  (a project, Chats) is closed it stays in sight right under the folder's row (`liftLiveSessions`), where the folder's
 *  own rows start (the list has no indent per level); once the folder opens it is back in its place.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';

/** Works (InProgress) or waits for the person (NeedsInput), and is not archived. */
export function isLiveSession(session: ISession): boolean {
	const status = session.status.get();
	return !session.isArchived.get() && (status === SessionStatus.InProgress || status === SessionStatus.NeedsInput);
}

interface ITreeChild {
	readonly element: unknown;
	children?: Iterable<ITreeChild>;
	collapsed?: unknown;
}

/**
 * For every closed folder in the list's top-level `children` (a project, its Worktrees, Chats: `isFolder`), its sessions
 * that work or wait move from inside it to right after it, with their own rows (chats, sub-agents) still under them.
 * `isClosed` says whether the folder is closed (the list's saved state, else how it starts).
 */
export function liftLiveSessions(children: ITreeChild[], isFolder: (element: unknown) => boolean, isClosed: (child: ITreeChild) => boolean, isSession: (element: unknown) => element is ISession): void {
	const walk = (list: ITreeChild[]): void => {
		for (let i = 0; i < list.length; i++) {
			const child = list[i];
			if (!child.children || !isFolder(child.element)) {
				continue;
			}
			const inner = [...child.children];
			if (!isClosed(child)) {
				walk(inner);
				child.children = inner;
				continue;
			}
			// a closed folder: its live sessions, and the live ones of the closed groups inside it
			const out: ITreeChild[] = [];
			const take = (rows: ITreeChild[]): ITreeChild[] => rows.filter(r => {
				if (isSession(r.element) && isLiveSession(r.element)) {
					out.push(r);
					return false;
				}
				if (r.children && isFolder(r.element)) {
					r.children = take([...r.children]);
				}
				return true;
			});
			child.children = take(inner);
			list.splice(i + 1, 0, ...out);
			i += out.length;
		}
	};
	walk(children);
}

const watching = new WeakMap<object, IDisposable>();

/** The list goes: its watch with it. */
export function unwatchLiveSessions(owner: object): void {
	watching.get(owner)?.dispose();
	watching.delete(owner);
}
/**
 * The list builds its rows again when one of `sessions` (the ones it just put in) starts or stops working or waiting:
 * it may leave or join a fold. Called on every build, so a new session is followed from its first build on.
 */
export function watchLiveSessions(owner: { update(): void }, sessions: readonly ISession[]): void {
	watching.get(owner)?.dispose();
	let key: string | undefined;
	watching.set(owner, autorun(reader => {
		const live = sessions.filter(s => {
			const status = s.status.read(reader);
			return !s.isArchived.read(reader) && (status === SessionStatus.InProgress || status === SessionStatus.NeedsInput);
		}).map(s => s.sessionId).sort().join('|');
		if (key !== undefined && live !== key) {
			key = live;
			// after this run: the build starts a new watch and ends this one
			setTimeout(() => owner.update(), 0);
		}
		key = live;
	}));
}
