/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Waiting for you at the top of the sessions list, with the newest things right under it
 *  (design/home-now direction A, picked 2026-11-11, task-0v1o9). The left side bar speaks for the whole Mac.
 *
 *  - The entry: a 36 high ghost row, the codicon bell (thin, 16px, grey), at the end the number of things that moved
 *    in the last 7 days (dispatchWaitingWeek), none at 0. A click opens the Waiting for you page.
 *  - Under it the newest three of them, one 32 high row each: a 7px amber dot in a 14px slot, the title, how long ago
 *    it moved. A click does what the page does with that row (openWaitingItem); hovering it shows the page's card for
 *    it (renderWaitingDetail: Allow, Deny, the options, Mark read, Done) and lights the session's own row further down,
 *    and the other way round (dispatchWaitingHover, DESIGN.md 联动悬停).
 *  - More than three: "Show N more" opens the rest in place. Older ones (not moved for 7 days): "N older", which opens
 *    the page with its Older group open.
 *  - Another Mac's waiting follows (dispatchPeerWaiting.ts).
 *  sessionsList.ts asks this file for the rows, their heights, how to draw them and what a click does.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { renderWaitingDetail } from '../../../dispatchTasks/browser/dispatchHoverDetails.js';
import { insertPeerWaitingRows, isPeerWaitingRow, openPeerWaitingRow, renderPeerWaitingRow, type ISectionTemplateLike, watchPeerRows } from '../dispatchPeerWaiting.js';
import { waitingAge } from '../dispatchWaitingGroups.js';
import { dispatchWaitingHover, dispatchWaitingWeek, enterWaitingHover, type IDispatchWaitingItem, leaveWaitingHover, renderWaitingThingIcon, waitingTitle } from '../dispatchWaitingModel.js';
import { openWaitingItem } from '../dispatchWaitingQueue.js';

/** The Waiting for you entry's row in the list. */
export const DISPATCH_WAITING_SECTION_ID = 'dispatch-waiting';
/** How many of this week's things show under the entry before "Show N more". */
export const WAITING_SIDEBAR_ROWS = 3;

const ITEM_PREFIX = 'dispatch-wait:';
const MORE_ID = 'dispatch-wait-more';
const OLDER_ID = 'dispatch-wait-older';
const ENTRY_HEIGHT = 36;
const ITEM_HEIGHT = 32;
const FOLD_HEIGHT = 28;

/** "Show N more" was clicked: every one of this week's things shows (for the rest of the window). */
let expanded = false;

function isWaitingRow(id: string): boolean {
	return id.startsWith(ITEM_PREFIX) || id === MORE_ID || id === OLDER_ID;
}

/** The rows this file and dispatchPeerWaiting.ts draw in the sessions list (the entry is the list's own section). */
export function isDispatchSidebarRow(id: string): boolean {
	return isWaitingRow(id) || isPeerWaitingRow(id);
}

/** A row's height, or undefined for the list's own (28). */
export function dispatchSidebarRowHeight(id: string): number | undefined {
	const base = id === DISPATCH_WAITING_SECTION_ID ? ENTRY_HEIGHT : id.startsWith(ITEM_PREFIX) ? ITEM_HEIGHT : id === MORE_ID || id === OLDER_ID ? FOLD_HEIGHT : isPeerWaitingRow(id) ? FOLD_HEIGHT : undefined;
	return base !== undefined && id === groupEnd ? base + GROUP_GAP : base;
}

/** The Waiting for you group's last row (the entry when nothing hangs under it): 8 more below it, before Automations. */
let groupEnd = DISPATCH_WAITING_SECTION_ID;
/** DESIGN.md 留白: 8 between groups (the prototype's gap between Waiting for you and Automations). */
const GROUP_GAP = 8;

/** The group's last row keeps its own height and has the 8 under it, outside its hover (dispatchWaiting.css). */
export function markDispatchSidebarGroupEnd(container: HTMLElement, id: string, store: DisposableStore): void {
	const listRow = container.closest('.monaco-list-row');
	listRow?.classList.toggle('dispatch-group-end', id === groupEnd);
	store.add(toDisposable(() => listRow?.classList.remove('dispatch-group-end')));
}

type IRowElement = { element: { id: string; label: string; sessions: never[] }; children: never[]; collapsible: false };

function row(id: string, label: string): IRowElement {
	return { element: { id, label, sessions: [] }, children: [], collapsible: false };
}

/** What the rows show: this week's things (the first three unless expanded), whether there are more, how many older. */
function shown(): { items: readonly IDispatchWaitingItem[]; more: number; less: boolean; older: number } {
	const week = dispatchWaitingWeek.get();
	const all = week?.week ?? [];
	// back to three or fewer: the next time there are more, they fold again
	if (all.length <= WAITING_SIDEBAR_ROWS) {
		expanded = false;
	}
	const items = expanded ? all : all.slice(0, WAITING_SIDEBAR_ROWS);
	// opened with "Show N more": the same row folds them again ("Show less")
	return { items, more: all.length - items.length, less: expanded && all.length > WAITING_SIDEBAR_ROWS, older: week?.older.length ?? 0 };
}

/** The lists that show the rows (the Agents window has one). */
const owners = new Set<{ update(): void }>();
/**
 * sessionsList.ts, once: the list builds its rows again when the things shown, the fold, the older count or another
 * Mac's waiting change (a title or a time redraws only its row); all of it ends with the list.
 */
export function bindDispatchSidebarRows(owner: { update(): void }): IDisposable {
	const store = new DisposableStore();
	owners.add(owner);
	store.add(toDisposable(() => owners.delete(owner)));
	store.add(watchPeerRows(owner));
	let key: string | undefined;
	store.add(autorun(reader => {
		dispatchWaitingWeek.read(reader);
		const s = shown();
		const now = JSON.stringify([s.items.map(i => i.id), s.more, s.older]);
		if (key !== undefined && now !== key) {
			key = now;
			owner.update();
		}
		key = now;
	}));
	return store;
}

/**
 * Right under the Waiting for you entry in the list's top-level `children` (sessionsList.ts, after it built them): this
 * week's newest things, "Show N more", "N older", then another Mac's waiting.
 */
export function insertDispatchSidebarRows<T extends { element: unknown }>(children: T[]): void {
	const entry = children.findIndex(c => (c.element as { id?: string }).id === DISPATCH_WAITING_SECTION_ID);
	if (entry < 0) {
		return;
	}
	const s = shown();
	const rows: IRowElement[] = s.items.map(i => row(ITEM_PREFIX + i.id, waitingTitle(i)));
	if (s.more > 0 || s.less) {
		rows.push(row(MORE_ID, s.less ? localize('dispatchWaitingSidebar.less', "Show less") : localize('dispatchWaitingSidebar.more', "Show {0} more", s.more)));
	}
	if (s.older > 0) {
		rows.push(row(OLDER_ID, localize('dispatchWaitingSidebar.older', "{0} older", s.older)));
	}
	children.splice(entry + 1, 0, ...(rows as unknown as T[]));
	const peers = insertPeerWaitingRows(children, entry + 1 + rows.length);
	groupEnd = (children[entry + rows.length + peers].element as { id: string }).id;
}

function itemOf(id: string): IDispatchWaitingItem | undefined {
	const want = id.slice(ITEM_PREFIX.length);
	return dispatchWaitingWeek.get()?.week.find(i => i.id === want);
}

CommandsRegistry.registerCommand('dispatch.sidebarRow.open', (accessor, id: string) => {
	if (isPeerWaitingRow(id)) {
		openPeerWaitingRow(accessor, id);
	} else if (id === MORE_ID) {
		expanded = !expanded;
		for (const owner of owners) {
			owner.update();
		}
	} else if (id === OLDER_ID) {
		void accessor.get(ICommandService).executeCommand('dispatch.waiting.show', { fresh: true, older: true });
	} else {
		const item = itemOf(id);
		if (item) {
			return openWaitingItem(accessor, item);
		}
	}
	return undefined;
});

/** The section template's state before a row of ours drew into it, put back when the template goes to another row. */
function takeTemplate(template: ISectionTemplateLike, cls: readonly string[]): void {
	const { container, icon, label, count, newBadge, chevron, elementDisposables } = template;
	container.classList.remove('session-section-shortcut', 'dispatch-waiting-section', 'dispatch-projects-section', 'active');
	container.classList.add(...cls);
	newBadge.style.display = 'none';
	template.collapsed.set(false, undefined);
	chevron.className = 'session-section-chevron';
	if (template.toolbarContainer) {
		template.toolbarContainer.style.display = 'none';
	}
	icon.className = 'session-section-icon';
	icon.style.display = '';
	count.className = 'session-section-count';
	count.style.display = '';
	elementDisposables.add(toDisposable(() => {
		DOM.clearNode(icon);
		DOM.clearNode(label);
		DOM.clearNode(count);
		icon.className = 'session-section-icon';
		count.className = 'session-section-count';
		container.classList.remove(...cls);
		container.removeAttribute('title');
		container.closest('.monaco-list-row')?.classList.remove('dispatch-linked');
		if (template.toolbarContainer) {
			template.toolbarContainer.style.display = '';
		}
	}));
}

export function renderDispatchSidebarRow(template: ISectionTemplateLike, id: string, instantiationService: IInstantiationService): void {
	markDispatchSidebarGroupEnd(template.container, id, template.elementDisposables);
	if (isPeerWaitingRow(id)) {
		renderPeerWaitingRow(template, id, instantiationService);
		return;
	}
	if (id === MORE_ID || id === OLDER_ID) {
		takeTemplate(template, ['dispatch-wait-fold', id === MORE_ID ? 'more' : 'older']);
		template.icon.style.display = 'none';
		template.count.style.display = 'none';
		template.elementDisposables.add(autorun(reader => {
			dispatchWaitingWeek.read(reader);
			const s = shown();
			template.label.textContent = id === MORE_ID
				? (s.less ? localize('dispatchWaitingSidebar.less', "Show less") : localize('dispatchWaitingSidebar.more', "Show {0} more", s.more))
				: localize('dispatchWaitingSidebar.older', "{0} older", s.older);
		}));
		template.container.title = id === MORE_ID ? '' : localize('dispatchWaitingSidebar.olderTip', "Not touched for 7 days. They do not count; open them on the Waiting for you page.");
		return;
	}
	renderItemRow(template, id, instantiationService);
}

/** One of this week's things: what it is (its icon), its title, how long ago it moved; its card on hover; linked to its session's row. */
function renderItemRow(template: ISectionTemplateLike, id: string, instantiationService: IInstantiationService): void {
	takeTemplate(template, ['dispatch-wait-row']);
	const { container, icon, label, count, elementDisposables } = template;
	const itemId = id.slice(ITEM_PREFIX.length);
	count.classList.add('dispatch-wait-age');
	container.dataset.waitingId = itemId;
	elementDisposables.add(toDisposable(() => delete container.dataset.waitingId));
	elementDisposables.add(autorun(reader => {
		dispatchWaitingWeek.read(reader);
		const item = itemOf(id);
		if (!item) {
			return;
		}
		DOM.clearNode(icon);
		renderWaitingThingIcon(icon, item);
		label.textContent = waitingTitle(item);
		count.textContent = waitingAge(item);
	}));
	// the minute moves on: the age with it
	const tick = DOM.getWindow(container).setInterval(() => {
		const item = itemOf(id);
		if (item) {
			count.textContent = waitingAge(item);
		}
	}, 60_000);
	elementDisposables.add(toDisposable(() => DOM.getWindow(container).clearInterval(tick)));
	// the same thing's session row further down lights up with it, and this row with that one or the page's row
	elementDisposables.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_ENTER, () => enterWaitingHover(itemId, 'sidebar')));
	elementDisposables.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_LEAVE, () => leaveWaitingHover(itemId)));
	elementDisposables.add(toDisposable(() => leaveWaitingHover(itemId)));
	elementDisposables.add(autorun(reader => {
		const hover = dispatchWaitingHover.read(reader);
		container.closest('.monaco-list-row')?.classList.toggle('dispatch-linked', hover?.id === itemId && hover.from !== 'sidebar');
	}));
	// the page's card for it: what it asks and its buttons
	const [hoverService] = instantiationService.invokeFunction(accessor => [accessor.get(IHoverService)] as const);
	let cardStore: DisposableStore | undefined;
	// the row goes to another thing (or away): its card's buttons and listeners with it
	elementDisposables.add(toDisposable(() => cardStore?.dispose()));
	elementDisposables.add(hoverService.setupDelayedHover(container, () => {
		cardStore?.dispose();
		cardStore = new DisposableStore();
		const item = itemOf(id);
		const card = item ? instantiationService.invokeFunction(renderWaitingDetail, item, cardStore) : DOM.$('span', undefined, label.textContent ?? '');
		return { content: card, appearance: { showPointer: true }, position: { hoverPosition: HoverPosition.RIGHT }, persistence: { hideOnHover: false } };
	}, { groupId: 'sessions-list' }));
}
