/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Talk's small cards (direction B「Talk while new」, user 2026-11-15, task-q9x2r, kanban
 *  design/learn-scene frames 2 and 3). In the side pane's bottom right corner, where the side chat card opens: one card
 *  says one thing the agent just did (a new file, an install, a deletion) in two lines, the name and its tag over what
 *  the agent said about it. It never takes the keyboard, fades after 7 seconds and stays while the pointer is on it;
 *  a thin line under it runs out with the time. A click asks about it in the side chat card (the file or the command
 *  is the quote); × sends it away for the rest of the turn. The same family as the side chat card: corner 12, the
 *  side pane's background, a 1px border and the same faint shadow (DESIGN.md「组件」边干边学).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { clockLeft, ILearnCard, ITalkClock, MAX_TALK_CARDS, pauseClock, resumeClock, startClock, talkCardBottoms, talkCardWidth } from '../common/dispatchLearnModel.js';

const ICONS: Record<ILearnCard['icon'], ThemeIcon> = { 'new-file': Codicon.newFile, package: Codicon.package, trash: Codicon.trash };

interface IShown {
	readonly key: string;
	readonly element: HTMLElement;
	card: ILearnCard;
	clock: ITalkClock;
	timer: ReturnType<typeof setTimeout> | undefined;
	leaving: boolean;
}

export interface ITalkCardsHost {
	/** The side pane the cards sit in (undefined while it is put away: no card then). */
	container(): HTMLElement | undefined;
	/** The pills in the corner (Walk me through's): the cards sit above them. */
	pillShown(): number;
	/** Where the corner starts from the side pane's bottom: 8 over the folded side chat's head, else the corner's gap. */
	floor(): number;
	/** A click on a card. */
	activate(key: string, card: ILearnCard): void;
	/** × on a card: no more of this one in this turn. */
	dismissed(key: string): void;
}

export class DispatchTalkCards extends Disposable {

	private readonly _shown: IShown[] = [];
	private _ro: ResizeObserver | undefined;
	private _observed: HTMLElement | undefined;

	constructor(private readonly _host: ITalkCardsHost) {
		super();
		this._register(toDisposable(() => this.clear()));
		this._register(toDisposable(() => this._ro?.disconnect()));
	}

	/** Shows the card for `key`, or says the new words on the one already there and starts its 7 seconds again. */
	show(key: string, card: ILearnCard): void {
		const container = this._host.container();
		if (!container) {
			return;
		}
		this.observe(container);
		let s = this._shown.find(x => x.key === key && !x.leaving);
		if (!s) {
			s = { key, element: this.create(container, key), card, clock: startClock(Date.now()), timer: undefined, leaving: false };
			this._shown.push(s);
			while (this._shown.filter(x => !x.leaving).length > MAX_TALK_CARDS) {
				this.leave(this._shown.find(x => !x.leaving)!);
			}
		}
		s.card = card;
		this.fill(s);
		s.clock = startClock(Date.now());
		this.restartBar(s);
		if (!s.element.matches(':hover')) {
			this.arm(s);
		} else {
			s.clock = pauseClock(s.clock, Date.now());
			s.element.classList.add('paused');
		}
		this.layout();
	}

	/** Every card goes at once (Quiet, the side chat card opened, another session on screen). */
	clear(): void {
		for (const s of [...this._shown]) {
			this.remove(s);
		}
	}

	/** The cards' keys on screen. */
	keys(): string[] {
		return this._shown.filter(s => !s.leaving).map(s => s.key);
	}

	layout(): void {
		const container = this._host.container();
		if (!container) {
			this.clear();
			return;
		}
		const pane = container.getBoundingClientRect();
		const win = dom.getWindow(container);
		const narrow = win.innerWidth <= 1200;
		const width = talkCardWidth(pane.width, win.innerWidth);
		const live = this._shown.filter(s => !s.leaving);
		for (const s of live) {
			s.element.style.width = `${width}px`;
		}
		const corner = narrow ? 12 : 16;
		const bottoms = talkCardBottoms(live.map(s => s.element.offsetHeight), this._host.floor(), this._host.pillShown());
		live.forEach((s, i) => {
			s.element.style.right = `${corner}px`;
			s.element.style.bottom = `${bottoms[i]}px`;
		});
	}

	private observe(container: HTMLElement): void {
		if (this._observed === container) {
			return;
		}
		this._ro?.disconnect();
		this._observed = container;
		this._ro = new ResizeObserver(() => this.layout());
		this._ro.observe(container);
		if (dom.getWindow(container).getComputedStyle(container).position === 'static') {
			container.style.position = 'relative';
		}
	}

	private create(container: HTMLElement, key: string): HTMLElement {
		const el = dom.$('.dispatch-talk-card', { role: 'status', 'aria-live': 'polite', 'data-part': 'talk-card' });
		el.dataset.key = key;
		// a card never takes the keyboard (it is not tabbable either: the side chat and Settings say the same)
		el.tabIndex = -1;
		container.appendChild(el);
		el.addEventListener('mousedown', e => e.preventDefault());
		el.addEventListener('click', e => {
			dom.EventHelper.stop(e, true);
			const s = this._shown.find(x => x.element === el);
			if (!s || s.leaving) {
				return;
			}
			if ((e.target as HTMLElement).closest('.dtc-x')) {
				this._host.dismissed(s.key);
				this.leave(s);
				return;
			}
			this._host.activate(s.key, s.card);
			this.leave(s);
		});
		el.addEventListener('mouseenter', () => {
			const s = this._shown.find(x => x.element === el);
			if (s && !s.leaving) {
				s.clock = pauseClock(s.clock, Date.now());
				clearTimeout(s.timer);
				el.classList.add('paused');
			}
		});
		el.addEventListener('mouseleave', () => {
			const s = this._shown.find(x => x.element === el);
			if (s && !s.leaving) {
				s.clock = resumeClock(s.clock, Date.now());
				el.classList.remove('paused');
				this.arm(s);
			}
		});
		return el;
	}

	private fill(s: IShown): void {
		const el = s.element, card = s.card;
		dom.clearNode(el);
		el.dataset.kind = card.kind;
		el.setAttribute('aria-label', localize('dispatchLearn.cardAria', "{0} Click to ask about it.", card.sentence));
		el.title = localize('dispatchLearn.cardTip', "Ask about it in a side chat");
		const l1 = dom.append(el, dom.$('.dtc-l1'));
		dom.append(l1, dom.$(`span.dtc-ic${ThemeIcon.asCSSSelector(ICONS[card.icon])}`, { 'aria-hidden': 'true' }));
		dom.append(l1, dom.$('span.dtc-name', undefined, card.title));
		dom.append(l1, dom.$('span.dtc-tag', undefined, card.tag));
		const x = dom.append(l1, dom.$('button.dtc-x', { type: 'button', tabindex: '-1', 'aria-label': localize('dispatchLearn.dismiss', "Dismiss"), title: localize('dispatchLearn.dismiss', "Dismiss") }));
		dom.append(x, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.close)}`, { 'aria-hidden': 'true' }));
		dom.append(el, dom.$('.dtc-l2', undefined, card.text));
		const bar = dom.append(el, dom.$('.dtc-bar', { 'aria-hidden': 'true' }));
		dom.append(bar, dom.$('i'));
	}

	/** The line runs out again from full. */
	private restartBar(s: IShown): void {
		const bar = s.element.querySelector<HTMLElement>('.dtc-bar');
		if (bar) {
			dom.clearNode(bar);
			dom.append(bar, dom.$('i'));
		}
	}

	private arm(s: IShown): void {
		clearTimeout(s.timer);
		s.timer = setTimeout(() => this.leave(s), clockLeft(s.clock, Date.now()));
	}

	/** Fades out (200ms), then goes. */
	private leave(s: IShown): void {
		if (s.leaving) {
			return;
		}
		s.leaving = true;
		clearTimeout(s.timer);
		s.element.classList.add('leaving');
		s.timer = setTimeout(() => this.remove(s), 200);
		this.layout();
	}

	private remove(s: IShown): void {
		clearTimeout(s.timer);
		s.element.remove();
		const at = this._shown.indexOf(s);
		if (at >= 0) {
			this._shown.splice(at, 1);
		}
	}
}
