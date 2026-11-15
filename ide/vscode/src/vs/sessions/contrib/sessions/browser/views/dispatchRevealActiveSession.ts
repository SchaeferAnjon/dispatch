/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session you are on, or one you just sent, is never hidden in a closed group of the
 *  side bar (patches/130-session-rows.patch). When it lands in a group (its project,
 *  Worktrees once its own copy is made, a time section) that is closed, or under a closed section, the
 *  groups open; the row scrolls into view while it is the session shown. Each session is followed for two
 *  minutes after it was last the one shown (it may move, say into Worktrees, after you went elsewhere), and
 *  only a move to a new place opens anything: a group the person closes afterwards stays closed.
 *--------------------------------------------------------------------------------------------*/

const FOLLOW_MS = 2 * 60_000;

/** The part of the side bar's tree this needs. */
export interface IDispatchRevealTree<T> {
	hasElement(element: T): boolean;
	getParentElement(element: T): T | null;
	isCollapsed(element: T): boolean;
	expand(element: T): boolean;
	getRelativeTop(element: T): number | null;
	reveal(element: T, relativeTop?: number): void;
}

export class DispatchRevealActiveSession {

	/** Session id: where it was last opened up to, and until when it is followed. */
	private readonly _followed = new Map<string, { place: string; until: number }>();

	/**
	 * After the tree was filled: opens the groups above the active session, and above a session that was
	 * active a moment ago when it moved. `placeOf` names a group or section (its id).
	 */
	run<T>(tree: IDispatchRevealTree<T>, sessions: readonly T[], idOf: (session: T) => string, activeId: string | undefined, placeOf: (element: T) => string, now = Date.now()): void {
		if (activeId) {
			const f = this._followed.get(activeId);
			this._followed.set(activeId, { place: f?.place ?? '', until: now + FOLLOW_MS });
		}
		for (const [id, f] of [...this._followed]) {
			if (f.until < now) {
				this._followed.delete(id);
				continue;
			}
			const session = sessions.find(s => idOf(s) === id);
			if (!session || !tree.hasElement(session)) {
				continue;
			}
			const above: T[] = [];
			for (let p = tree.getParentElement(session); p; p = tree.getParentElement(p)) {
				above.unshift(p);
			}
			const place = above.map(placeOf).join('/');
			if (place === f.place) {
				continue;
			}
			f.place = place;
			for (const group of above) {
				if (tree.isCollapsed(group)) {
					tree.expand(group);
				}
			}
			if (id === activeId && tree.getRelativeTop(session) === null) {
				tree.reveal(session, 0.5);
			}
		}
	}
}
