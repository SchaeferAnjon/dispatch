/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the tip bubble. It sits beside a real element, an arrow on the element, a ring round it;
 *  a short title, one or two plain sentences, a step counter, Back, Next or Got it. It never takes the
 *  focus (a person may be typing) and never blocks a click: the page under it keeps working.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDispatchTourRect, IDispatchTourStep, KEEP_CLEAR, overlaps, placeBubble } from './dispatchToursModel.js';
import './media/dispatchTours.css';

const $ = dom.$;

export interface IDispatchBubbleContent {
	readonly step: IDispatchTourStep;
	/** The step's place among the steps on screen. */
	readonly position: number;
	readonly total: number;
	readonly isLast: boolean;
}

export class DispatchTourBubble extends Disposable {

	readonly element: HTMLElement;
	private readonly ring: HTMLElement;
	private readonly arrow: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly nextBtn: HTMLElement;

	private readonly _onDidNext = this._register(new Emitter<void>());
	readonly onDidNext: Event<void> = this._onDidNext.event;
	private readonly _onDidBack = this._register(new Emitter<void>());
	readonly onDidBack: Event<void> = this._onDidBack.event;
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;
	private readonly _onDidAction = this._register(new Emitter<void>());
	readonly onDidAction: Event<void> = this._onDidAction.event;

	constructor(private readonly container: HTMLElement, content: IDispatchBubbleContent, animate: boolean) {
		super();
		const { step } = content;
		this.ring = dom.append(container, $('.dispatch-tour-ring'));
		this.element = dom.append(container, $('.dispatch-tour', { role: 'dialog', 'aria-modal': 'false', 'aria-label': step.title }));
		this.element.dataset.step = step.id;
		if (animate) {
			this.element.classList.add('entering');
		}
		this.arrow = dom.append(this.element, $('.dispatch-tour-arrow'));

		const head = dom.append(this.element, $('.dispatch-tour-head'));
		dom.append(head, $('.dispatch-tour-title', undefined, step.title));
		const close = dom.append(head, $('button.dispatch-tour-close', { type: 'button', 'aria-label': localize('dispatchTours.close', "Close this tip") }));
		dom.append(close, $('span.codicon.codicon-close'));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this._onDidClose.fire()));

		dom.append(this.element, $('.dispatch-tour-body', undefined, step.body));

		const foot = dom.append(this.element, $('.dispatch-tour-foot'));
		this.countEl = dom.append(foot, $('span.dispatch-tour-count'));
		dom.append(foot, $('span.dispatch-tour-sp'));
		if (content.position > 1) {
			const back = dom.append(foot, $('button.dispatch-tour-btn', { type: 'button' }, localize('dispatchTours.back', "Back")));
			this._register(dom.addDisposableListener(back, dom.EventType.CLICK, () => this._onDidBack.fire()));
		}
		if (step.action) {
			const act = dom.append(foot, $('button.dispatch-tour-btn', { type: 'button' }, step.action.label));
			this._register(dom.addDisposableListener(act, dom.EventType.CLICK, () => this._onDidAction.fire()));
		}
		this.nextBtn = dom.append(foot, $('button.dispatch-tour-btn.fill', { type: 'button' }));
		this._register(dom.addDisposableListener(this.nextBtn, dom.EventType.CLICK, () => this._onDidNext.fire()));
		this.setProgress(content);
		this._register({ dispose: () => { this.element.remove(); this.ring.remove(); } });
	}

	/** The step counter and Next or Got it: the steps on screen can change while a tip is up (a page still drawing itself). */
	setProgress(content: Pick<IDispatchBubbleContent, 'position' | 'total' | 'isLast'>): void {
		this.countEl.textContent = content.total > 1 ? localize('dispatchTours.count', "{0} of {1}", content.position, content.total) : '';
		this.nextBtn.textContent = content.isLast ? localize('dispatchTours.gotIt', "Got it") : localize('dispatchTours.next', "Next");
	}

	/** No spot in the window keeps the message box clear (a window too small): out of sight until there is one. */
	private noRoom = false;
	private hidden = false;

	/** Put the bubble beside the element, the ring round it. */
	place(rect: IDispatchTourRect, preferred: IDispatchTourStep['placement']): void {
		const win = this.container.ownerDocument.defaultView;
		const viewport = { width: win?.innerWidth ?? 1200, height: win?.innerHeight ?? 800 };
		const pad = 3;
		this.ring.style.left = `${rect.left - pad}px`;
		this.ring.style.top = `${rect.top - pad}px`;
		this.ring.style.width = `${rect.width + pad * 2}px`;
		this.ring.style.height = `${rect.height + pad * 2}px`;
		// a ring round a whole page is only noise
		this.ring.classList.toggle('big', rect.width > viewport.width * 0.5 && rect.height > viewport.height * 0.5);
		const size = { width: this.element.offsetWidth, height: this.element.offsetHeight };
		const at = placeBubble(rect, size, viewport, preferred, keepClearRects(this.container.ownerDocument));
		this.noRoom = at.side === 'none';
		this.applyHidden();
		this.element.style.left = `${at.left}px`;
		this.element.style.top = `${at.top}px`;
		this.element.dataset.side = at.side;
		if (at.arrowOffset === undefined) {
			this.arrow.style.display = 'none';
		} else {
			this.arrow.style.display = '';
			if (at.side === 'top' || at.side === 'bottom') {
				this.arrow.style.left = `${at.arrowOffset}px`;
				this.arrow.style.top = '';
			} else {
				this.arrow.style.top = `${at.arrowOffset}px`;
				this.arrow.style.left = '';
			}
		}
	}

	/** Out of sight while something else is on top (a menu, a dialog), back after. */
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.applyHidden();
	}

	private applyHidden(): void {
		const hidden = this.hidden || this.noRoom;
		this.element.style.visibility = hidden ? 'hidden' : '';
		this.ring.style.visibility = hidden ? 'hidden' : '';
	}

	/** The check after drawing (task-lj06.21): the bubble as drawn covers a kept-clear control (its text wrapped
	 *  taller, the box grew under it), so it has to be placed again. */
	coversKeepClear(): boolean {
		if (this.noRoom || this.hidden) {
			return false;
		}
		const r = this.element.getBoundingClientRect();
		const me = { left: r.left, top: r.top, width: r.width, height: r.height };
		return keepClearRects(this.container.ownerDocument).some(k => overlaps(me, k));
	}

	/** Whether an event's target is inside the bubble. */
	contains(target: EventTarget | null): boolean {
		return target instanceof Node && this.element.contains(target);
	}

	/** The focus is inside the bubble (the person tabbed to it): then Esc closes it. */
	hasFocus(): boolean {
		const active = this.container.ownerDocument.activeElement;
		return !!active && this.element.contains(active);
	}
}

/** Where the controls a tip must not cover are now (KEEP_CLEAR), the ones on screen. */
export function keepClearRects(doc: Document): IDispatchTourRect[] {
	const out: IDispatchTourRect[] = [];
	for (const sel of KEEP_CLEAR) {
		for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
			}
		}
	}
	return out;
}
