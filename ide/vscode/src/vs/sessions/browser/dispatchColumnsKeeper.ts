/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a window made narrow and wide again comes back to the columns the person had
 *  (patches/150-side-pane.patch, kanban task-lj06.3, task-m9k4w). workbench.ts calls keep() before and
 *  layOut() after it lays out for a window resize; the arithmetic is dispatchColumns.ts.
 *--------------------------------------------------------------------------------------------*/

import type { ISerializableView, SerializableGrid } from '../../base/browser/ui/grid/grid.js';
import { dispatchColumnsFor, IDispatchColumns } from './dispatchColumns.js';

/** What the keeper reads from and does to the workbench's grid. */
export interface IDispatchColumnsHost {
	grid(): SerializableGrid<ISerializableView> | undefined;
	sideBar(): ISerializableView;
	/** The conversation (the sessions part). */
	chat(): ISerializableView;
	/** Where the side pane can be: the auxiliary bar's own column, or the editor part's when it is docked in it (the single-pane layout). */
	sidePanes(): (ISerializableView | undefined)[];
	isPhone(): boolean;
	/** The side pane shows a file. */
	showsFile(): boolean;
	withEditorResizeSyncSuspended(fn: () => void): void;
	/** Hides or shows the sessions list (fit()). */
	setSideBarHidden(hidden: boolean): void;
}

/**
 * Left alone, every resize starts from the sizes the step before squeezed: the grid hands a growing window's width
 * to the conversation (it has the higher priority), the single-pane layout keeps the chat : side pane ratio of that
 * squeezed step, and the side bar (lowest priority) never gets its width back, so the columns drifted further on
 * each resize. The widths the person set (dragging an edge, opening or closing a pane) are kept as they were before
 * the first resize, and each resize lays the columns out from them: the side bar keeps its width until the window is
 * too narrow for it; the side pane keeps its width (Changes, Files: the conversation takes the rest) or, while it
 * shows a file, its share next to the conversation. Back at the old width every column is what it was.
 */
export class DispatchColumnsKeeper {
	private _anchor: IDispatchColumns | undefined;
	private _laidOut: string | undefined;
	/** The sessions list was folded away because the window had no room for it (fit()). */
	private _sideBarFolded = false;

	constructor(private readonly host: IDispatchColumnsHost) { }

	/** Before a window resize: the person's columns are the ones now, unless they are what the last resize laid out. */
	keep(): void {
		const now = this._columns();
		if (!now || DispatchColumnsKeeper._key(now) !== this._laidOut) {
			this._anchor = now;
		}
	}

	/** After a window resize: the columns again from the person's widths, squeezed only as far as this window needs. */
	layOut(): void {
		const grid = this.host.grid();
		const anchor = this._anchor;
		const now = this._columns();
		if (grid && anchor && now && (anchor.sidebar > 0) === (now.sidebar > 0) && (anchor.pane > 0) === (now.pane > 0) && anchor.shared === now.shared) {
			const sideBar = this.host.sideBar();
			// the grid's own minimums (a side pane with Changes docked in it can be narrower than the detail's width)
			const target = dispatchColumnsFor(anchor, now.sidebar + now.chat + now.pane, {
				sidebar: Math.min(sideBar.minimumWidth, anchor.sidebar),
				chat: Math.min(this.host.chat().minimumWidth, anchor.chat),
				pane: now.pane > 0 ? Math.min(this._sidePane()!.minimumWidth, anchor.pane) : 0,
			});
			try {
				if (target.sidebar > 0 && target.sidebar !== now.sidebar) {
					grid.resizeView(sideBar, { width: target.sidebar, height: grid.getViewSize(sideBar).height });
				}
				const pane = this._sidePane();
				if (pane && target.pane > 0 && target.pane !== grid.getViewSize(pane).width) {
					this.host.withEditorResizeSyncSuspended(() => {
						grid.resizeView(pane, { width: target.pane, height: grid.getViewSize(pane).height });
					});
				}
			} catch {
				// the grid changed under us: it keeps its own layout this time
			}
		}
		this._laidOut = DispatchColumnsKeeper._key(this._columns());
	}

	/**
	 * A window narrower than the columns' minimums together (sessions list 170, conversation 300, side pane 300) made
	 * the grid wider than the window, with a scroll bar along the bottom (user 2026-10-10, a 750 px window). Like a
	 * VS Code side bar that snaps closed when there is no room, the sessions list folds away then; it comes back when
	 * the window has room for it again (unless the person closed it in between).
	 */
	fit(): void {
		const grid = this.host.grid();
		if (!grid || this.host.isPhone()) {
			return;
		}
		try {
			const chat = this.host.chat();
			if (!grid.isViewVisible(chat)) {
				return;
			}
			const sideBar = this.host.sideBar();
			const pane = this._sidePane();
			const others = chat.minimumWidth + (pane ? pane.minimumWidth : 0);
			const shown = grid.isViewVisible(sideBar);
			if (shown && others + sideBar.minimumWidth > grid.width) {
				this._sideBarFolded = true;
				this.host.setSideBarHidden(true);
			} else if (!shown && this._sideBarFolded && others + Math.max(sideBar.minimumWidth, this._anchor?.sidebar ?? 0) <= grid.width) {
				this._sideBarFolded = false;
				this.host.setSideBarHidden(false);
			} else if (shown) {
				this._sideBarFolded = false;
			}
		} catch {
			// the grid changed under us: the next layout fits it
		}
	}

	/** The side pane's grid column, undefined when it is hidden. */
	private _sidePane(): ISerializableView | undefined {
		const grid = this.host.grid();
		if (!grid) {
			return undefined;
		}
		for (const view of this.host.sidePanes()) {
			try {
				if (view && grid.isViewVisible(view)) {
					return view;
				}
			} catch {
				// not a grid view in this layout (the docked auxiliary bar)
			}
		}
		return undefined;
	}

	/** The widths of the side bar, the conversation and the side pane now (0 for one that is hidden). */
	private _columns(): IDispatchColumns | undefined {
		const grid = this.host.grid();
		if (!grid || this.host.isPhone()) {
			return undefined;
		}
		try {
			const chat = this.host.chat();
			if (!grid.isViewVisible(chat)) {
				return undefined;
			}
			const sideBar = this.host.sideBar();
			const pane = this._sidePane();
			return {
				sidebar: grid.isViewVisible(sideBar) ? grid.getViewSize(sideBar).width : 0,
				chat: grid.getViewSize(chat).width,
				pane: pane ? grid.getViewSize(pane).width : 0,
				// a file in the side pane: it keeps its share of the room next to the conversation, as the single-pane layout does
				shared: !!pane && this.host.showsFile(),
			};
		} catch {
			return undefined;
		}
	}

	private static _key(c: IDispatchColumns | undefined): string {
		return c ? `${c.sidebar}:${c.chat}:${c.pane}:${c.shared}` : '';
	}
}
