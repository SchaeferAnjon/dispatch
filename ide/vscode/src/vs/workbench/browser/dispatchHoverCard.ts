/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the hover card, one for every page of ours (kanban DESIGN.md 联动悬停; the left
 *  sidebar's cards on Waiting for you, a project and a session are the model).
 *
 *  - The card: a head (a name, 600, with grey words after it), the whole text wrapped (what a row cuts
 *    off), grey lines under it (a folder, a path), then whatever the caller adds (rows, buttons).
 *  - Where a row of ours cuts its text off, it shows this card instead of the system's grey title
 *    tooltip: {@link setupDispatchTextHover} opens it after the usual hover delay, and only when the text
 *    is cut off (a card that says what the row already says is noise), unless the card has more to offer.
 *  The sessions layer's cards (dispatchWaitingModel.ts renderHoverRow) use the same classes; the styles
 *  live here so the machines panel of the editor window has them too.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchHoverCard.css';
import * as DOM from '../../base/browser/dom.js';
import { HoverPosition } from '../../base/browser/ui/hover/hoverWidget.js';
import { IHoverWidget } from '../../base/browser/ui/hover/hover.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';

const $ = DOM.$;

export interface IDispatchHoverCardText {
	/** The first line, one line in 600: a name, a title. */
	readonly head?: string;
	/** Grey after the head: " · waiting 3 h". */
	readonly headDetail?: string;
	/** The whole text, wrapped. */
	readonly text?: string;
	/** The text is a command or a path: in the editor's monospace font. */
	readonly code?: boolean;
	/** Grey lines under it: a folder, a path, a link. */
	readonly notes?: readonly string[];
}

/** The card: `.dispatch-hover-card` with its head, its text and its grey lines. */
export function renderDispatchHoverCard(c: IDispatchHoverCardText, extraClass?: string): HTMLElement {
	const card = $(`.dispatch-hover-card.dispatch-text-card${extraClass ? `.${extraClass}` : ''}`);
	if (c.head) {
		const head = DOM.append(card, $('.dispatch-hover-head'));
		DOM.append(head, $('span.dispatch-hover-head-name', undefined, c.head));
		if (c.headDetail) {
			DOM.append(head, $('span.dispatch-hover-head-counts', undefined, ` · ${c.headDetail}`));
		}
	}
	if (c.text) {
		DOM.append(card, $(c.code ? '.dispatch-hover-text.code' : '.dispatch-hover-text', undefined, c.text));
	}
	for (const note of c.notes ?? []) {
		if (note) {
			DOM.append(card, $('.dispatch-hover-note', undefined, note));
		}
	}
	return card;
}

/** The element's text does not fit: an ellipsis at the end of a line, or lines clamped off at the bottom. */
export function isDispatchTextCut(el: HTMLElement): boolean {
	return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

export interface IDispatchTextHoverOptions {
	/**
	 * When the card is worth opening: by default when the target's text is cut off; the given elements
	 * (one of them cut off), or a test of the caller's (the card has buttons, a folder the row does not show).
	 */
	readonly when?: readonly HTMLElement[] | (() => boolean);
	/** Default under the target. */
	readonly position?: HoverPosition;
	/** The card has buttons or links: it stays while the pointer is in it. */
	readonly interactive?: boolean;
	/** Called when the card opens (the page lights what goes with it). */
	readonly onShow?: () => void;
}

let cardIds = 0;

/** The pause before a card with buttons opens (DESIGN.md: hover delay 500 ms). */
const INTERACTIVE_DELAY = 500;

/** The widget each open card of ours is shown in, by the card's element. */
const shownCards = new WeakMap<HTMLElement, IHoverWidget>();

/**
 * Keep the card `el` is in open while something hangs off it (the reason card under a picked direction):
 * the pointer leaving it does not close it. Undone by disposing; a click outside still closes it.
 */
export function holdDispatchHoverCard(el: HTMLElement): IDisposable {
	const attached = el.closest<HTMLElement>('.dispatch-hover-detail-panel');
	if (attached && attachedHolds.has(attached)) { return attachedHolds.get(attached)!(); }
	const card = el.closest<HTMLElement>('.dispatch-hover-card');
	const widget = card && shownCards.get(card) as (IHoverWidget & { isLocked?: boolean }) | undefined;
	if (!widget || widget.isDisposed) {
		return toDisposable(() => { });
	}
	widget.isLocked = true;
	return toDisposable(() => {
		if (!widget.isDisposed) {
			widget.isLocked = false;
		}
	});
}

/**
 * Our card on a row whose text is cut off, where the system's grey title tooltip used to be. Returns what
 * to dispose with the row.
 */
export function setupDispatchTextHover(hoverService: IHoverService, target: HTMLElement, content: () => HTMLElement | IDispatchHoverCardText | undefined, options: IDispatchTextHoverOptions = {}): IDisposable {
	const store = new DisposableStore();
	const id = `dispatch-card-${++cardIds}`;
	const worth = () => {
		const when = options.when;
		if (typeof when === 'function') {
			return when();
		}
		return (when ?? [target]).some(isDispatchTextCut);
	};
	let shown: IHoverWidget | undefined;
	let shownContent: HTMLElement | undefined;
	let timer: number | undefined;
	target.dataset.dispatchCard = '';
	store.add(DOM.addDisposableListener(target, DOM.EventType.MOUSE_OVER, e => {
		// a button in the row with its own tooltip (Open the prototype) speaks for itself
		const own = DOM.isHTMLElement(e.target) ? e.target.closest('[title]') : null;
		if (own && own !== target && target.contains(own)) {
			return;
		}
		// so does a piece of the row with a card of its own (a status dot in a row that has a card)
		const inner = DOM.isHTMLElement(e.target) ? e.target.closest('[data-dispatch-card]') : null;
		if (inner && inner !== target && target.contains(inner)) {
			return;
		}
		if (!worth()) {
			return;
		}
		const c = content();
		if (!c) {
			return;
		}
		const hoverOptions = (el: HTMLElement) => ({
			id,
			content: el,
			target,
			position: { hoverPosition: options.position ?? HoverPosition.BELOW },
			appearance: { showPointer: true },
			persistence: { hideOnHover: !options.interactive },
			additionalClasses: ['dispatch-text-hover'],
		});
		if (options.interactive) {
			// a card with buttons is shown as an instant hover after our own pause: the hover service closes its
			// delayed hover the moment any other hover is made, and the reason card under a picked direction is
			// one (askPickReason); this card has to stay under it
			if (timer !== undefined || (shown && !shown.isDisposed)) {
				return;
			}
			timer = DOM.getWindow(target).setTimeout(() => {
				timer = undefined;
				if (!target.isConnected || !target.matches(':hover')) {
					return;
				}
				const fresh = content();
				if (!fresh) {
					return;
				}
				options.onShow?.();
				shownContent = DOM.isHTMLElement(fresh) ? fresh : renderDispatchHoverCard(fresh);
				shown = hoverService.showInstantHover(hoverOptions(shownContent));
				if (shown) {
					shownCards.set(shownContent, shown);
				}
			}, INTERACTIVE_DELAY);
			return;
		}
		options.onShow?.();
		shownContent = DOM.isHTMLElement(c) ? c : renderDispatchHoverCard(c);
		shown = hoverService.showDelayedHover(hoverOptions(shownContent), { groupId: 'dispatch-text-hover' });
		if (shown) {
			shownCards.set(shownContent, shown);
		}
	}));
	store.add(DOM.addDisposableListener(target, DOM.EventType.MOUSE_LEAVE, () => {
		if (timer !== undefined) {
			DOM.getWindow(target).clearTimeout(timer);
			timer = undefined;
		}
	}));
	// a click goes somewhere: this card (and only this one, not a panel the row sits in) does not stay behind
	const close = () => {
		if (timer !== undefined) {
			DOM.getWindow(target).clearTimeout(timer);
			timer = undefined;
		}
		if (shown && !shown.isDisposed) {
			shown.dispose();
		}
		shown = undefined;
	};
	store.add(DOM.addDisposableListener(target, DOM.EventType.MOUSE_DOWN, close));
	// the row goes (its page is drawn again): its card goes too, unless the pointer is in it (someone is about
	// to press one of its buttons); then it goes when the pointer leaves it
	store.add(toDisposable(() => {
		if (!shownContent?.closest('.monaco-hover')?.matches(':hover')) {
			close();
		}
	}));
	return store;
}

/** A detail belongs to its card, not to another hover-service widget. This lets the pointer cross
 * the 4px seam without dismissing the parent, and keeps a diagonal trip from selecting another row. */
export interface IDispatchRowDetailOptions {
	readonly image?: boolean;
	readonly onShow?: () => void;
	readonly onHide?: () => void;
}
interface IDetailRow {
	readonly row: HTMLElement;
	readonly render: (store: DisposableStore) => HTMLElement;
	readonly options: IDispatchRowDetailOptions;
}
const rowDetails = new WeakMap<HTMLElement, DispatchRowDetail>();

export function setupDispatchRowDetail(card: HTMLElement, row: HTMLElement, render: IDetailRow['render'], store: DisposableStore, options: IDispatchRowDetailOptions = {}): void {
	let detail = rowDetails.get(card);
	if (!detail) {
		detail = new DispatchRowDetail(card);
		rowDetails.set(card, detail);
		store.add(detail);
	}
	detail.add({ row, render, options }, store);
}

class DispatchRowDetail implements IDisposable {
	private readonly store = new DisposableStore();
	private readonly contentStore = this.store.add(new MutableDisposable<DisposableStore>());
	private readonly panel = $('.dispatch-hover-detail-panel');
	private readonly seam = $('.dispatch-detail-seam');
	private readonly rows: IDetailRow[] = [];
	private current: IDetailRow | undefined;
	private timer: number | undefined;
	private pinned = 0;
	private ownerDisposed = false;
	private dead = false;
	/**
	 * The pointer has moved since this card came up. A card that opens under a pointer at rest (What's new right
	 * after the first-run setup's Start, kanban task-5dom6) gets mouseenter on the row there without anyone pointing
	 * at it; its detail waits for the first real move. Layout changes move nothing (movementX/Y stay 0).
	 */
	private pointerMoved = false;
	constructor(private readonly card: HTMLElement) {
		this.panel.setAttribute('role', 'group');
		this.panel.setAttribute('aria-label', 'Details');
		const win = DOM.getWindow(card);
		this.store.add(DOM.addDisposableListener(card.ownerDocument, 'mousemove', (e: MouseEvent) => {
			if (e.movementX || e.movementY) { this.pointerMoved = true; }
		}, true));
		this.store.add(DOM.addDisposableListener(this.panel, 'mousedown', e => e.stopPropagation()));
		this.store.add(DOM.addDisposableListener(this.seam, 'mouseenter', () => this.cancel()));
		this.store.add(DOM.addDisposableListener(this.seam, 'mouseleave', () => this.later(() => this.close())));
		this.store.add(DOM.addDisposableListener(this.panel, 'mouseenter', () => this.cancel()));
		this.store.add(DOM.addDisposableListener(this.panel, 'mouseleave', () => this.later(() => this.close())));
		this.store.add(DOM.addDisposableListener(this.panel, 'focusin', () => this.cancel()));
		this.store.add(DOM.addDisposableListener(this.panel, 'focusout', () => this.later(() => {
			if (!this.panel.contains(card.ownerDocument.activeElement)) { this.close(); }
		})));
		// The outer hover handles Escape too; close only the detail on the first press.
		this.store.add(DOM.addDisposableListener(this.panel, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !this.pinned) {
				e.preventDefault(); e.stopPropagation(); if (this.ownerDisposed) { this.destroy(); } else { this.current?.row.focus(); this.close(); }
			}
			e.stopPropagation();
		}));
		this.store.add(DOM.addDisposableListener(win, 'resize', () => this.layout()));
		this.store.add(DOM.addDisposableListener(card.ownerDocument, 'mousedown', e => {
			if (this.ownerDisposed && !this.panel.contains(e.target as Node)) { this.destroy(); }
		}, true));
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.panel);
		this.store.add(toDisposable(() => observer.disconnect()));
		this.store.add(toDisposable(() => this.cancel()));
		attachedDismiss.set(this.panel, () => this.destroy());
		attachedHolds.set(this.panel, () => {
			this.pinned++;
			this.detach();
			return toDisposable(() => { this.pinned--; });
		});
	}
	add(entry: IDetailRow, store: DisposableStore): void {
		this.rows.push(entry);
		entry.row.dataset.dispatchDetailRow = '';
		if (entry.row.tabIndex < 0) { entry.row.tabIndex = 0; }
		const pointAt = () => {
			this.cancel();
			if (!this.pinned && this.current !== entry) {
				this.later(() => this.show(entry));
			}
		};
		store.add(DOM.addDisposableListener(entry.row, 'mouseenter', () => {
			if (this.pointerMoved) { pointAt(); }
		}));
		// the card came up under the pointer: the row's detail once the pointer moves on it
		store.add(DOM.addDisposableListener(entry.row, 'mousemove', (e: MouseEvent) => {
			if ((e.movementX || e.movementY) && this.current !== entry && this.timer === undefined) { pointAt(); }
		}));
		store.add(DOM.addDisposableListener(entry.row, 'mouseleave', () => this.later(() => this.close())));
		store.add(DOM.addDisposableListener(entry.row, 'focus', () => { if (!this.pinned) { this.show(entry); } }));
		store.add(DOM.addDisposableListener(entry.row, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault(); e.stopPropagation();
				const index = this.rows.indexOf(entry) + (e.key === 'ArrowDown' ? 1 : -1);
				this.rows[(index + this.rows.length) % this.rows.length]?.row.focus();
			} else if (e.key === 'Tab' && !e.shiftKey) {
				this.show(entry);
				const first = this.panel.querySelector<HTMLElement>('button:not(:disabled), input, a[href]');
				if (first) { e.preventDefault(); e.stopPropagation(); first.focus(); }
			}
		}));
	}
	private cancel(): void {
		if (this.timer !== undefined) { DOM.getWindow(this.card).clearTimeout(this.timer); this.timer = undefined; }
	}
	private later(fn: () => void): void {
		this.cancel();
		this.timer = DOM.getWindow(this.card).setTimeout(() => { this.timer = undefined; fn(); }, 250);
	}
	private show(entry: IDetailRow): void {
		this.cancel();
		if (this.dead || !entry.row.isConnected || this.pinned || this.current === entry) { return; }
		this.current?.row.classList.remove('detail-active');
		this.current?.options.onHide?.();
		this.contentStore.clear();
		DOM.clearNode(this.panel);
		this.current = entry;
		this.panel.classList.toggle('image-detail', !!entry.options.image);
		const detailStore = new DisposableStore();
		this.contentStore.value = detailStore;
		this.panel.appendChild(entry.render(detailStore));
		// Outside the scrollable .monaco-hover, inside its mouse tracker. No clipping by the card.
		const host = this.card.closest('.workbench-hover-container') ?? this.card;
		if (this.panel.parentElement !== host) { host.append(this.panel, this.seam); }
		entry.row.classList.add('detail-active');
		entry.options.onShow?.();
		this.layout();
	}
	private layout(): void {
		if (!this.current || !this.panel.isConnected) { return; }
		if (this.ownerDisposed) {
			const win = DOM.getWindow(this.panel);
			this.panel.style.left = `${Math.max(8, Math.min(parseFloat(this.panel.style.left), win.innerWidth - this.panel.offsetWidth - 8))}px`;
			this.panel.style.top = `${Math.max(8, Math.min(parseFloat(this.panel.style.top), win.innerHeight - this.panel.offsetHeight - 8))}px`;
			return;
		}
		const win = DOM.getWindow(this.card), margin = 8, gap = 4;
		const shell = this.card.closest('.monaco-hover') ?? this.card;
		const box = shell.getBoundingClientRect(), row = this.current.row.getBoundingClientRect();
		const right = win.innerWidth - box.right - gap - margin, left = box.left - gap - margin;
		const image = !!this.current.options.image;
		const preferred = image ? Number(this.panel.firstElementChild?.getAttribute('data-detail-width')) || 800 : 320;
		const side = image ? (right >= preferred || (right >= 280 && right >= left) ? 'right' : left >= 280 ? 'left' : 'inline') : right >= 280 ? 'right' : left >= 280 ? 'left' : 'inline';
		const available = side === 'left' ? left : side === 'right' ? right : Math.min(box.width, win.innerWidth - 16);
		const width = Math.max(0, Math.min(preferred, available));
		this.panel.dataset.side = side;
		if (side === 'inline') {
			if (this.panel.previousElementSibling !== this.current.row) { this.current.row.after(this.panel); }
		} else {
			const host = this.card.closest('.workbench-hover-container') ?? this.card;
			if (this.panel.parentElement !== host) { host.appendChild(this.panel); }
		}
		this.panel.style.width = `${width}px`;
		this.panel.style.maxHeight = `${side === 'inline' ? Math.min(win.innerHeight - margin * 2, Math.max(120, win.innerHeight - row.bottom - margin)) : win.innerHeight - margin * 2}px`;
		this.panel.style.setProperty('--detail-image-height', `${Math.max(100, win.innerHeight - 160)}px`);
		const x = side === 'right' ? box.right + gap : side === 'left' ? box.left - width - gap : Math.max(margin, Math.min(box.left, win.innerWidth - width - margin));
		const y = Math.max(margin, Math.min(side === 'inline' ? row.bottom : row.top, win.innerHeight - this.panel.offsetHeight - margin));
		this.panel.style.left = `${x}px`;
		this.panel.style.top = `${y}px`;
		const radius = win.getComputedStyle(shell).borderRadius;
		this.panel.style.borderRadius = radius;
		Object.assign(this.seam.style, { left: `${side === 'right' ? x - gap : x + width}px`, top: `${y}px`, height: `${this.panel.offsetHeight}px`, display: side === 'inline' ? 'none' : '' });
	}
	private close(): void {
		this.cancel();
		if (this.pinned || this.panel.matches(':hover') || this.panel.contains(this.card.ownerDocument.activeElement)) { return; }
		if (this.ownerDisposed) { this.destroy(); return; }
		this.current?.row.classList.remove('detail-active');
		this.current?.options.onHide?.();
		this.current = undefined;
		this.panel.remove();
		this.seam.remove();
		this.contentStore.clear();
	}
	private detach(): void {
		if (this.ownerDisposed) { return; }
		// An action owns its result now: sidebar counts and data polls may recycle the source row.
		// The same DOM and listeners survive; outside click, Escape or leaving it dismisses the result.
		this.ownerDisposed = true;
		this.cancel();
		this.panel.classList.add('detached');
		(this.card.ownerDocument.querySelector('.monaco-workbench') ?? this.card.ownerDocument.body).appendChild(this.panel);
		this.seam.remove();
	}
	dispose(): void {
		if (this.dead || this.ownerDisposed) { return; }
		if (this.pinned && this.current) { this.detach(); return; }
		this.destroy();
	}
	private destroy(): void {
		if (this.dead) { return; }
		this.dead = true;
		this.current?.options.onHide?.();
		this.panel.remove();
		this.seam.remove();
		this.store.dispose();
		rowDetails.delete(this.card);
	}
}

const attachedHolds = new WeakMap<HTMLElement, () => IDisposable>();
const attachedDismiss = new WeakMap<HTMLElement, () => void>();

/** Close an action result that outlived its source row, as well as an ordinary attached detail. */
export function dismissDispatchHoverDetail(el: HTMLElement): void {
	const panel = el.closest<HTMLElement>('.dispatch-hover-detail-panel');
	if (panel) { attachedDismiss.get(panel)?.(); }
}
