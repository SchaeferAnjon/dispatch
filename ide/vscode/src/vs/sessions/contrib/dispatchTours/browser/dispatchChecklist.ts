/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Getting started, a checklist of the things a new person should try (kanban design/
 *  orca-study G7; Orca's SetupGuideSidebarEntry is the model: a progress ring and a list). Each item
 *  ticks itself when the person really does it: the place shows on screen, a command ran, a message
 *  went out, or Dispatch says so (agents chosen, phone paired). It can be hidden and comes back from
 *  Help > Getting Started. The entry sits in the title bar next to What's new; its card is a hover.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { DISPATCH_CHECKLIST, IDispatchChecklistItem } from './dispatchToursData.js';
import { findOnScreen } from './dispatchToursDom.js';
import { checklistProgress, IDispatchChecklistProgress } from './dispatchToursModel.js';
import { DispatchToursState } from './dispatchToursState.js';

const $ = dom.$;
const SVG = 'http://www.w3.org/2000/svg';
const RING_SIZE = 16;
const RING_RADIUS = 6.5;

// ---------------------------------------------------------------- the ring

export function renderDispatchRing(progress: IDispatchChecklistProgress, size = RING_SIZE, radius = RING_RADIUS): SVGElement {
	const svg = mainWindow.document.createElementNS(SVG, 'svg');
	svg.setAttribute('class', 'dispatch-ring');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
	svg.setAttribute('aria-hidden', 'true');
	for (const cls of ['track', 'bar']) {
		const c = mainWindow.document.createElementNS(SVG, 'circle');
		c.setAttribute('class', cls);
		c.setAttribute('cx', String(size / 2));
		c.setAttribute('cy', String(size / 2));
		c.setAttribute('r', String(radius));
		c.setAttribute('stroke-width', '2');
		svg.appendChild(c);
	}
	updateDispatchRing(svg, progress);
	return svg;
}

export function updateDispatchRing(svg: SVGElement, progress: IDispatchChecklistProgress): void {
	svg.querySelector('.bar')?.setAttribute('stroke-dasharray', `${progress.drawn} ${progress.circumference}`);
}

// ---------------------------------------------------------------- what is done

export class DispatchChecklist extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidComplete = this._register(new Emitter<void>());
	/** The last item was ticked. */
	readonly onDidComplete: Event<void> = this._onDidComplete.event;

	readonly items = DISPATCH_CHECKLIST;
	private polling = false;

	constructor(
		private readonly state: DispatchToursState,
		private readonly commandService: ICommandService,
		private readonly sessionsManagement: ISessionsManagementService,
	) {
		super();
		this._register(state.onDidChange(() => this._onDidChange.fire()));
	}

	get progress(): IDispatchChecklistProgress {
		return checklistProgress(this.items.map(i => i.id), this.state.done, RING_RADIUS);
	}

	get hidden(): boolean {
		return this.state.checklistHidden;
	}

	isDone(id: string): boolean {
		return this.state.done.includes(id);
	}

	private tick(id: string): void {
		if (!this.state.markDone(id)) {
			return;
		}
		if (this.progress.complete) {
			this._onDidComplete.fire();
		}
	}

	/** The places that are on screen now. */
	scanDom(doc: Document): void {
		for (const item of this.items) {
			if (item.doneWhen.onScreen && !this.isDone(item.id) && findOnScreen(doc, item.doneWhen.onScreen)) {
				this.tick(item.id);
			}
		}
	}

	onCommand(commandId: string): void {
		for (const item of this.items) {
			if (item.doneWhen.commands?.includes(commandId)) {
				this.tick(item.id);
			}
		}
	}

	/** A message went to an agent; `inChat` when the session is a chat without a folder (Chats). */
	onRequest(inChat: boolean): void {
		for (const item of this.items) {
			if (item.doneWhen.request || (inChat && item.doneWhen.chatRequest)) {
				this.tick(item.id);
			}
		}
	}

	/** What only Dispatch knows: agents chosen, a phone paired, a session there from before. */
	async poll(): Promise<void> {
		if (this.polling) {
			return;
		}
		this.polling = true;
		try {
			for (const item of this.items) {
				const check = item.doneWhen.check;
				if (!check || this.isDone(item.id)) {
					continue;
				}
				try {
					if (check === 'sessions') {
						if (this.sessionsManagement.getSessions().length > 0) {
							this.tick(item.id);
						}
					} else if (check === 'agents') {
						const r = await this.commandService.executeCommand<{ saved?: boolean }>('dispatch.engines', 'enabled');
						if (r?.saved) {
							this.tick(item.id);
						}
					} else if (check === 'phone') {
						const r = await this.commandService.executeCommand<{ phones?: readonly unknown[] }>('dispatch.mobile', 'state');
						if (r?.phones?.length) {
							this.tick(item.id);
						}
					}
				} catch {
					// the command is not there yet or the CLI did not answer: ask again next time
				}
			}
		} finally {
			this.polling = false;
		}
	}
}

// ---------------------------------------------------------------- the entry (the bottom bar's Getting started block)

let entryChecklist: DispatchChecklist | undefined;
let onEntryClick: ((anchor: HTMLElement) => void) | undefined;

export function setDispatchChecklistEntry(checklist: DispatchChecklist | undefined, onClick: ((anchor: HTMLElement) => void) | undefined): void {
	entryChecklist = checklist;
	onEntryClick = onClick;
}

/** What the bottom bar's Getting started block shows and does (contrib/dispatchStatusBar), while there is a checklist. */
export function dispatchChecklistEntry(): { readonly checklist: DispatchChecklist; readonly click: (anchor: HTMLElement) => void } | undefined {
	return entryChecklist && onEntryClick ? { checklist: entryChecklist, click: onEntryClick } : undefined;
}

// ---------------------------------------------------------------- the card

export interface IDispatchChecklistCardHandlers {
	readonly showMe: (item: IDispatchChecklistItem) => void;
	readonly hide: () => void;
}

export class DispatchChecklistCard extends Disposable {

	private open = false;
	private readonly store = this._register(new DisposableStore());

	constructor(
		private readonly checklist: DispatchChecklist,
		private readonly hoverService: IHoverService,
		private readonly handlers: IDispatchChecklistCardHandlers,
	) {
		super();
	}

	get isOpen(): boolean {
		return this.open;
	}

	toggle(anchor: HTMLElement): void {
		if (this.open) {
			this.hide();
			return;
		}
		this.show(anchor);
	}

	show(anchor: HTMLElement): void {
		if (this.open) {
			return;
		}
		this.store.clear();
		const content = this.render();
		this.open = true;
		anchor.classList.add('open');
		this.store.add(dom.addDisposableListener(mainWindow.document, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this.open) {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.hide();
			}
		}, true));
		// fresh answers while it is open (a phone paired a minute ago)
		void this.checklist.poll();
		const widget = this.hoverService.showInstantHover({
			content,
			target: { targetElements: [anchor], dispose: () => { this.open = false; anchor.classList.remove('open'); } },
			additionalClasses: ['dispatch-checklist-hover'],
			appearance: { showPointer: false, compact: true, maxHeightRatio: 1 },
			position: { hoverPosition: HoverPosition.BELOW },
			persistence: { sticky: true },
			trapFocus: true,
		}, true);
		if (!widget) {
			this.open = false;
			anchor.classList.remove('open');
		}
	}

	hide(): void {
		if (this.open) {
			this.hoverService.hideHover(true);
			this.open = false;
		}
		this.store.clear();
	}

	private render(): HTMLElement {
		const root = $('.dispatch-checklist-card', { role: 'dialog', 'aria-label': localize('dispatchChecklist.cardAria', "Getting started") });
		const progress = this.checklist.progress;
		const head = dom.append(root, $('.ct'));
		head.appendChild(renderDispatchRing(progress, 20, 8));
		dom.append(head, $('b', undefined, localize('dispatchChecklist.cardTitle', "Getting started")));
		const count = dom.append(head, $('span', undefined, progress.complete ? localize('dispatchChecklist.allDone', "All done") : localize('dispatchChecklist.countOf', "{0} of {1} done", progress.done, progress.total)));
		dom.append(root, $('.ci', undefined, localize('dispatchChecklist.intro', "Each step ticks itself when you do it. Click one to be taken there.")));
		const rows = dom.append(root, $('.rows', { role: 'list' }));
		const rowEls = new Map<string, HTMLElement>();
		for (const item of this.checklist.items) {
			const done = this.checklist.isDone(item.id);
			const row = dom.append(rows, $('button.row', { type: 'button', role: 'listitem' }));
			rowEls.set(item.id, row);
			row.classList.toggle('done', done);
			row.setAttribute('aria-label', `${item.title}${done ? `. ${localize('dispatchChecklist.rowDone', "Done")}` : ''}. ${item.description}`);
			const tick = dom.append(row, $('span.tick'));
			dom.append(tick, $('span.codicon.codicon-check'));
			const text = dom.append(row, $('.text'));
			dom.append(text, $('.a', undefined, item.title));
			dom.append(text, $('.b', undefined, item.description));
			dom.append(row, $('span.go', undefined, localize('dispatchChecklist.showMe', "Show me")));
			this.store.add(dom.addDisposableListener(row, dom.EventType.CLICK, e => {
				e.preventDefault();
				this.hide();
				this.handlers.showMe(item);
			}));
		}
		// ticks that come in while the card is open (the phone answer, a session)
		this.store.add(this.checklist.onDidChange(() => {
			const p = this.checklist.progress;
			for (const item of this.checklist.items) {
				const row = rowEls.get(item.id);
				const done = this.checklist.isDone(item.id);
				if (row && row.classList.contains('done') !== done) {
					row.classList.toggle('done', done);
				}
			}
			const ring = head.querySelector<SVGElement>('.dispatch-ring');
			if (ring) {
				updateDispatchRing(ring, p);
			}
			count.textContent = p.complete ? localize('dispatchChecklist.allDone', "All done") : localize('dispatchChecklist.countOf', "{0} of {1} done", p.done, p.total);
		}));
		const foot = dom.append(root, $('.foot'));
		const hide = dom.append(foot, $('button.ghost', { type: 'button' }, localize('dispatchChecklist.hide', "Hide this list")));
		this.store.add(dom.addDisposableListener(hide, dom.EventType.CLICK, () => {
			this.hide();
			this.handlers.hide();
		}));
		const close = dom.append(foot, $('button.ghost', { type: 'button' }, localize('dispatchChecklist.close', "Close")));
		this.store.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.hide()));
		return root;
	}
}
