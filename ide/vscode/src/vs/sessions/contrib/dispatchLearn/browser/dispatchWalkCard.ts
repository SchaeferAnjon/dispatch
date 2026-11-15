/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Walk me through's pill and card (direction B「Talk while new」 frames 5 and 6, user 2026-11-15,
 *  task-fktjx, kanban design/learn-scene). The side chat card's family, in the same corner of the side pane:
 *
 *  - the pill: "Walk me through  4 stops  ×", 32 high, where the side chat's pill sits; it never takes the keyboard
 *    and stays until it is clicked, sent away or the next turn begins (dispatchWalk.ts says when);
 *  - the card: its head "Walk me through · this turn, 4 stops" and ×; the stop's file, what kind of change and which
 *    lines; one sentence about it; Ask about this; at the foot "Stop 1 of 4", Back and Next (Done on the last).
 *    ← and → go back and on, Esc ends.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { stopsLabel, WalkSource, walkKey } from '../common/dispatchWalkModel.js';

/** The walk's own mark, on its pill, its card and the Now tab's button. */
export const WALK_ICON = Codicon.compass;

export interface IWalkCardStop {
	readonly path: string;
	readonly rel: string;
	readonly name: string;
	readonly isNew: boolean;
	readonly start: number;
	readonly end: number;
	/** "New file", "2 lines added". */
	readonly tag: string;
	/** "lines 1–2". */
	readonly lines: string;
	readonly text: string;
	readonly source: WalkSource;
}

export interface IWalkCardHost {
	next(): void;
	back(): void;
	end(): void;
	ask(): void;
	/** "and N more in Changes": the Changes tab. */
	openChanges(): void;
}

export class DispatchWalkCard extends Disposable {

	readonly element: HTMLElement;
	private readonly _from: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _page: HTMLElement;
	private readonly _back: HTMLButtonElement;
	private readonly _next: HTMLButtonElement;
	private readonly _stopStore = this._register(new DisposableStore());

	constructor(container: HTMLElement, private readonly _host: IWalkCardHost) {
		super();
		this.element = dom.$('.dispatch-walk-card', { role: 'dialog', 'data-part': 'walk-card' });
		this.element.setAttribute('aria-label', localize('dispatchWalk.aria', "Walk me through this turn"));
		this.element.tabIndex = 0;
		container.appendChild(this.element);
		this._register(toDisposable(() => this.element.remove()));

		const head = dom.append(this.element, dom.$('.dwk-head'));
		dom.append(head, dom.$(`span.dwk-ic${ThemeIcon.asCSSSelector(WALK_ICON)}`, { 'aria-hidden': 'true' }));
		dom.append(head, dom.$('span.dwk-t', undefined, localize('dispatchWalk.title', "Walk me through")));
		this._from = dom.append(head, dom.$('span.dwk-from'));
		const close = dom.append(head, dom.$<HTMLButtonElement>('button.dwk-ib', { type: 'button', 'data-part': 'walk-close' }));
		close.title = close.ariaLabel = localize('dispatchWalk.close', "End the Walk (Escape)");
		dom.append(close, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.close)}`, { 'aria-hidden': 'true' }));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._host.end(); }));

		this._body = dom.append(this.element, dom.$('.dwk-body', { 'aria-live': 'polite' }));

		const nav = dom.append(this.element, dom.$('.dwk-nav'));
		this._page = dom.append(nav, dom.$('span.dwk-pg', { 'data-part': 'walk-page' }));
		dom.append(nav, dom.$('span.dwk-sp'));
		this._back = dom.append(nav, dom.$<HTMLButtonElement>('button.dwk-btn.ghost', { type: 'button', 'data-part': 'walk-back' }, localize('dispatchWalk.back', "Back")));
		this._next = dom.append(nav, dom.$<HTMLButtonElement>('button.dwk-btn.solid', { type: 'button', 'data-part': 'walk-next' }));
		this._back.title = localize('dispatchWalk.backTip', "The stop before (Left Arrow)");
		this._register(dom.addDisposableListener(this._back, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._host.back(); }));
		this._register(dom.addDisposableListener(this._next, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._host.next(); }));

		// ← → Esc while the card has the keyboard; the editor keeps its own keys
		this._register(dom.addStandardDisposableListener(this.element, dom.EventType.KEY_DOWN, e => {
			const what = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ? undefined : walkKey(e.browserEvent.key);
			if (!what) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (what === 'next') {
				this._host.next();
			} else if (what === 'back') {
				this._host.back();
			} else {
				this._host.end();
			}
		}));
	}

	show(stop: IWalkCardStop, index: number, count: number, more: number, writing: boolean): void {
		this._from.textContent = localize('dispatchWalk.from', "· this turn, {0}", stopsLabel(count));
		const el = this.element;
		el.dataset.index = String(index);
		el.dataset.count = String(count);
		el.dataset.path = stop.path;
		el.dataset.start = String(stop.start);
		el.dataset.end = String(stop.end);
		el.dataset.source = stop.source;

		this._stopStore.clear();
		dom.clearNode(this._body);
		const file = dom.append(this._body, dom.$('.dwk-file'));
		dom.append(file, dom.$(`span.dwk-file-ic${ThemeIcon.asCSSSelector(stop.isNew ? Codicon.newFile : Codicon.file)}`, { 'aria-hidden': 'true' }));
		const name = dom.append(file, dom.$('span.dwk-name', { 'data-part': 'walk-file' }, stop.name));
		name.title = stop.rel;
		dom.append(file, dom.$('span.dwk-k', { 'data-part': 'walk-where' }, `${stop.tag} · ${stop.lines}`));
		const say = dom.append(this._body, dom.$('p.dwk-say', { 'data-part': 'walk-say' }, stop.text));
		say.classList.toggle('lines', stop.source === 'lines');
		say.classList.toggle('writing', writing && stop.source === 'lines');
		if (writing && stop.source === 'lines') {
			say.title = localize('dispatchWalk.writing', "Asking the agent for a line about each stop…");
		}
		const chips = dom.append(this._body, dom.$('.dwk-chips'));
		const ask = dom.append(chips, dom.$<HTMLButtonElement>('button.dwk-chip', { type: 'button', 'data-part': 'walk-ask' }, localize('dispatchWalk.ask', "Ask about this")));
		ask.title = localize('dispatchWalk.askTip', "Ask about these lines in a side chat");
		this._stopStore.add(dom.addDisposableListener(ask, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._host.ask(); }));
		if (more > 0 && index === count - 1) {
			const rest = dom.append(chips, dom.$<HTMLButtonElement>('button.dwk-chip', { type: 'button', 'data-part': 'walk-more' }, localize('dispatchWalk.more', "and {0} more in Changes", more)));
			this._stopStore.add(dom.addDisposableListener(rest, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._host.openChanges(); }));
		}

		this._page.textContent = localize('dispatchWalk.page', "Stop {0} of {1}", index + 1, count);
		this._back.style.visibility = index > 0 ? '' : 'hidden';
		const last = index === count - 1;
		this._next.textContent = last ? localize('dispatchWalk.done', "Done") : localize('dispatchWalk.next', "Next");
		this._next.title = last ? localize('dispatchWalk.doneTip', "End the walk (Escape)") : localize('dispatchWalk.nextTip', "The next stop (Right Arrow)");
	}

	/** Its corner in the side pane: `right` and `bottom` from the pane's edges, as wide as the side chat card. */
	place(right: number, bottom: number, width: number, maxHeight: number): void {
		const s = this.element.style;
		s.right = `${right}px`;
		s.bottom = `${bottom}px`;
		s.width = `${width}px`;
		s.maxHeight = `${maxHeight}px`;
	}

	/** The keyboard on Next (its ring shows there, not round the card): ← → Esc work from anywhere in the card. */
	focus(): void {
		this._next.focus();
	}
}

export class DispatchWalkPill extends Disposable {

	readonly element: HTMLElement;
	private readonly _count: HTMLElement;

	constructor(container: HTMLElement, go: () => void, dismiss: () => void) {
		super();
		// not a stop for the Tab key and never focused when it comes (the small cards say the same, DESIGN.md 边干边学)
		this.element = dom.$('.dispatch-walk-pill.hidden', { 'data-part': 'walk-pill' });
		container.appendChild(this.element);
		this._register(toDisposable(() => this.element.remove()));
		const main = dom.append(this.element, dom.$<HTMLButtonElement>('button.dwp-go', { type: 'button', tabindex: '-1', 'data-part': 'walk-pill-go' }));
		dom.append(main, dom.$(`span.dwp-ic${ThemeIcon.asCSSSelector(WALK_ICON)}`, { 'aria-hidden': 'true' }));
		dom.append(main, dom.$('span.dwp-t', undefined, localize('dispatchWalk.pill', "Walk me through")));
		this._count = dom.append(main, dom.$('span.dwp-k'));
		const x = dom.append(this.element, dom.$<HTMLButtonElement>('button.dwp-x', { type: 'button', tabindex: '-1', 'data-part': 'walk-pill-dismiss' }));
		x.title = x.ariaLabel = localize('dispatchWalk.dismiss', "Dismiss");
		dom.append(x, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.close)}`, { 'aria-hidden': 'true' }));
		this.element.addEventListener('mousedown', e => e.preventDefault());
		this._register(dom.addDisposableListener(main, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); go(); }));
		this._register(dom.addDisposableListener(x, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); dismiss(); }));
	}

	set(count: number | undefined, right: number, bottom: number): void {
		const shown = count !== undefined;
		this.element.classList.toggle('hidden', !shown);
		if (!shown) {
			return;
		}
		this._count.textContent = stopsLabel(count);
		const go = this.element.querySelector<HTMLElement>('.dwp-go');
		if (go) {
			go.ariaLabel = localize('dispatchWalk.pillAria', "Walk me through this turn, {0}", stopsLabel(count));
		}
		this.element.style.right = `${right}px`;
		this.element.style.bottom = `${bottom}px`;
	}
}
