/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Agents window's columns after a window resize (patches/150-side-pane.patch,
 *  kanban task-lj06.3, task-m9k4w). Pure: workbench.ts measures the grid and applies what this returns.
 *--------------------------------------------------------------------------------------------*/

/** Widths of the side bar, the conversation and the side pane (0: hidden). */
export interface IDispatchColumns {
	readonly sidebar: number;
	readonly chat: number;
	readonly pane: number;
	/** The side pane shows a file: it keeps its share next to the conversation rather than its width. */
	readonly shared: boolean;
}

/**
 * The columns for a window whose three columns have `total` pixels, from the widths the person set (`anchor`).
 * The side bar keeps its width until the conversation and the side pane are down to their minimums; then the side
 * pane keeps its width (or, `shared`, its share of the room next to the conversation) and the conversation takes the
 * rest, never less than its minimum. With `total` as it was when the person set them, the result is `anchor`.
 */
export function dispatchColumnsFor(anchor: IDispatchColumns, total: number, min: { readonly sidebar: number; readonly chat: number; readonly pane: number }): IDispatchColumns {
	const paneMin = anchor.pane > 0 ? min.pane : 0;
	const sidebar = anchor.sidebar > 0 ? Math.max(min.sidebar, Math.min(anchor.sidebar, total - min.chat - paneMin)) : 0;
	const rest = total - sidebar;
	let pane = 0;
	if (anchor.pane > 0) {
		const want = anchor.shared && anchor.chat + anchor.pane > 0 ? Math.round(rest * anchor.pane / (anchor.chat + anchor.pane)) : anchor.pane;
		pane = Math.max(paneMin, Math.min(want, rest - min.chat));
	}
	return { sidebar, chat: total - sidebar - pane, pane, shared: anchor.shared };
}
