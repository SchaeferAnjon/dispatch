/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Timeline page (kanban design/frenzy, direction A「Timeline run tab」, the user's pick
 *  for Turbo, 狂暴模式, and for normal mode too: preference「狂暴模式选 A 平常也有」; redrawn to the design in
 *  design/timeline-design).
 *
 *  One time axis, lanes on it, as proto-a.html draws them: every lane says its name on the left and what it does on
 *  the right, the stretches it worked are grey bars, the dashed boxes are what is planned, one Now line runs down
 *  through all of them, a legend says what is what.
 *    - Turbo run: a big job split into parts that agents do at the same time (`dispatch turbo`). The plan first (the
 *      parts as dashed boxes, the folder, the agent, how many at a time, the time and the allowance; nothing runs
 *      before Start), then the same picture filling in: the allowance band on the same axis, one lane a part, the
 *      Combine row, what waits for the person at the top with its buttons. Done: the ten blocks take the app icon's
 *      colours one by one and a summary card with the real numbers.
 *    - Without Turbo (normal mode): the person's own sessions of the last hours, grouped by project (「会话按文件夹组织」),
 *      the helpers each session started folded into its lane (a chip with their count shows them as rows), a
 *      project's earlier sessions folded into one row.
 *  A click on a lane opens its card beside the lane (what it is, what it does, its helpers or files, Open session);
 *  the card floats over the lanes and moves none of them. Hovering a part lights the same part in the sessions list,
 *  and the other way round. Stopped for the allowance, the person can go on with another account of the same agent, or
 *  with another agent (`dispatch turbo switch`).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { sessionIdOf } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { stateBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import {
	axis, dependencies, duration, foldSpan, hm, IAxis, isActive, ISessionLane, ITurboNeed, ITurboPart, ITurboRun, ITurboTimeline, LaneItem, laneEnd, laneItems,
	lanesSpan, markCells, partBlock, partsWords, plannedBox, runSentence, runSpan, Seg, SessionItem, sessionItems, sessionsHead, ticks
} from './dispatchTurboModel.js';
import { dispatchTurboHooks, onDispatchTurboChange, setDispatchTurboHover } from './dispatchTurboHooks.js';
import { turboMark } from './dispatchTurboMark.js';

export { turboMark };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ask dispatch-bridge's `dispatch.turbo`; a failure comes back as { ok: false, message }. */
export async function askTurbo<T>(commandService: ICommandService, op: string, ...args: unknown[]): Promise<T & { ok?: boolean; message?: string }> {
	return commandService.executeCommand<T & { ok?: boolean; message?: string }>('dispatch.turbo', op, ...args).then(r => r ?? ({ ok: false } as T & { ok?: boolean }));
}

/** The session of the window with that id (`claude:/abc`, `agent-host-claude:/abc` and a bare id all end in it). */
function findSession(sessions: readonly ISession[], id: string): ISession | undefined {
	if (!id) {
		return undefined;
	}
	return sessions.find(x => sessionIdOf(x.resource) === id || x.sessionId === id || x.sessionId.endsWith(`/${id}`) || (URI.isUri(x.resource) && x.resource.path.endsWith(`/${id}`)));
}

function ordinal(n: number): string {
	const t = n % 100 >= 10 && n % 100 <= 20 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
	return `${n}${t}`;
}

function pill(parent: HTMLElement, label: string, kind: 'solid' | 'outline' | 'ghost', icon?: ThemeIcon): HTMLButtonElement {
	const b = dom.append(parent, dom.$<HTMLButtonElement>(`button.dt-btn.${kind}`, { type: 'button' }));
	if (icon) {
		b.appendChild(renderIcon(icon));
	}
	dom.append(b, dom.$('span', undefined, label));
	return b;
}

/** "13:10 – 14:02", or "13:10 – now". */
function span(from: number | undefined, to: number | undefined, now: boolean): string {
	return `${hm(from)} – ${now ? localize('dispatchTimeline.nowWord', "now") : hm(to)}`;
}

/** How long it worked, its stretches added up. */
function worked(segs: readonly Seg[]): number {
	return segs.reduce((a, s) => a + Math.max(0, s[1] - s[0]), 0) / 60;
}

/** The left edge of a moment on the rows' time axis, as CSS (the rows' grid: padding, label, gap, track, gap, side, padding). */
function onAxis(x: number): string {
	return `calc(var(--dt-pad) + var(--dt-label) + var(--dt-gap) + (100% - 2 * var(--dt-pad) - var(--dt-label) - var(--dt-side) - 2 * var(--dt-gap)) * ${(x / 100).toFixed(5)})`;
}

/** The Timeline tab. It reads `dispatch turbo timeline` while it is on screen, faster while a run goes. */
export class DispatchTimeline extends Disposable {

	readonly element: HTMLElement;
	private data: ITurboTimeline | undefined;
	private failed = false;
	private busy = false;
	/** Folds and helper lists opened, by key: `fold-combined`, `fold-later`, `parts` (a run's parts), `fold-<project>`, `h-<session>`. */
	private readonly open = new Set<string>();
	/** The lane whose card is open, by its key (`p<n>`, `s-<id>`, `h-<id>`). */
	private card: string | undefined;
	private showSessions = false;
	private lastKey = '';
	private lastCombined = -1;
	private timer: number | undefined;
	private doneSeen: string | undefined;
	private others: { engine: string; at: number; rows: { id: string; name: string; short?: string }[] } | undefined;
	private readonly renderStore = this._register(new DisposableStore());
	/** What a press on a lane does, by the lane's key; the release decides (see clickLane). */
	private readonly flips = new Map<string, () => void>();
	private pressed: string | undefined;
	/** A button is held down on the page: no redraw until it is let go, or its click would be lost. */
	private pressing = false;
	private redrawLater = false;
	/** Fired with the run (or undefined) after every read: the tab's label follows it. */
	onRun: ((run: ITurboRun | null) => void) | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
	) {
		super();
		this.element = dom.$('.dispatch-timeline');
		this._register(onDispatchTurboChange(what => what === 'hover' && this.lightHovered()));
		this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_DOWN, () => { this.pressing = true; }, true));
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.MOUSE_UP, () => {
			this.pressing = false;
			if (this.redrawLater) {
				// after the click that may follow this release
				mainWindow.setTimeout(() => this.redrawLater && this.render(), 0);
			}
		}));
		this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_UP, e => {
			const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
			const pressed = this.pressed;
			this.pressed = undefined;
			if (key && key === pressed && !(e.target as HTMLElement).closest('button')) {
				this.flips.get(key)?.();
			}
		}));
		// the card closes on Escape and on a press anywhere but on it or on a lane (a lane press decides itself)
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.MOUSE_DOWN, e => {
			const t = e.target as HTMLElement;
			if (this.card && !t.closest?.('.dt-pop') && !t.closest?.('.dispatch-timeline [data-key]')) {
				this.closeCard();
			}
		}, true));
		// first, before the page's own Esc (back to the session, dispatchCustomViewBack.ts): an open card takes the Esc
		this._register(dom.addDisposableListener(mainWindow, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.card && this.element.isConnected) {
				e.preventDefault();
				e.stopPropagation();
				this.closeCard();
			}
		}, true));
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('dispatchTimeline.aria', "Timeline"));
		this._register(toDisposable(() => this.stop()));
		this.render();
	}

	/** Start reading while on screen; every 3 s while a run goes, every 15 s otherwise. */
	start(): void {
		this.stop();
		void this.refresh();
		const tick = () => {
			const fast = isActive(this.data?.run) && this.data?.run?.state !== 'planned';
			this.timer = mainWindow.setTimeout(() => {
				if (this.element.isConnected && mainWindow.document.visibilityState === 'visible') {
					void this.refresh().finally(tick);
				} else {
					tick();
				}
			}, fast ? 3000 : 15000);
		};
		tick();
	}

	stop(): void {
		if (this.timer !== undefined) {
			mainWindow.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	get run(): ITurboRun | null {
		return this.data?.run ?? null;
	}

	async refresh(): Promise<void> {
		try {
			const d = await askTurbo<ITurboTimeline>(this.commandService, 'timeline');
			if (d && Array.isArray(d.lanes)) {
				// lanes opened in one run are not opened in the next one
				if (this.data && (this.data.run?.id ?? null) !== (d.run?.id ?? null)) {
					this.open.clear();
					this.card = undefined;
				}
				this.data = d;
				this.failed = false;
			} else {
				this.failed = true;
			}
		} catch {
			this.failed = true;
		}
		this.onRun?.(this.data?.run ?? null);
		this.render();
	}

	/** From the sessions list: the part's lane shows (its fold opens) with its card, and lights up for a moment. */
	reveal(n: number): void {
		const run = this.data?.run;
		const p = run?.parts.find(x => x.n === n);
		if (run && p) {
			for (const item of laneItems(run)) {
				if (item.kind === 'fold' && item.parts.includes(p)) {
					this.open.add(`fold-${item.key}`);
				}
			}
			if (run.state === 'done') {
				this.open.add('parts');
			}
			this.card = `p${n}`;
			this.render(true);
		}
		const lane = this.element.querySelector<HTMLElement>(`.dt-lane[data-n="${n}"]`);
		if (lane) {
			lane.scrollIntoView({ block: 'nearest' });
			lane.classList.add('hl', 'flash');
			mainWindow.setTimeout(() => lane.classList.remove('flash'), 1600);
		}
		if (!run) {
			// not read yet: once it is, the part opens
			void this.refresh().then(() => this.data?.run?.parts.some(x => x.n === n) && this.reveal(n));
		}
	}

	/** The part hovered in the sessions list (or here) lights its lane; a part inside a closed fold lights the fold. */
	private lightHovered(): void {
		const h = dispatchTurboHooks.hover;
		const mine = !!h && h.run === this.data?.run?.id;
		let lit = false;
		for (const lane of this.element.querySelectorAll<HTMLElement>('.dt-lane[data-n]')) {
			const on = mine && lane.dataset.n === String(h!.n);
			lane.classList.toggle('hl', on);
			lit ||= on;
		}
		for (const fold of this.element.querySelectorAll<HTMLElement>('.dt-fold[data-parts]')) {
			fold.classList.toggle('hl', mine && !lit && (fold.dataset.parts ?? '').split(' ').includes(String(h!.n)));
		}
	}

	/** Do one Turbo operation, then read again at once. */
	private async act(op: string, ...args: unknown[]): Promise<boolean> {
		if (this.busy) {
			return false;
		}
		this.busy = true;
		this.element.classList.add('busy');
		try {
			const r = await askTurbo<{ id?: string }>(this.commandService, op, ...args);
			if (r.ok === false) {
				this.notificationService.warn(r.message || localize('dispatchTimeline.failed', "Turbo could not do that just now."));
				return false;
			}
			return true;
		} finally {
			this.busy = false;
			this.element.classList.remove('busy');
			await this.refresh();
		}
	}

	render(force = false): void {
		const key = JSON.stringify([this.data, this.failed, [...this.open], this.card, this.showSessions]);
		if (!force && key === this.lastKey) {
			return;
		}
		if (!force && this.pressing) {
			this.redrawLater = true;
			return;
		}
		this.redrawLater = false;
		this.lastKey = key;
		this.renderStore.clear();
		this.flips.clear();
		dom.clearNode(this.element);
		const d = this.data;
		if (!d) {
			this.head(turboMark(36, markCells(0, 0), { think: !this.failed }), this.failed ? localize('dispatchTimeline.unreadable', "Timeline") : localize('dispatchTimeline.loading', "Looking at what is running…"),
				this.failed ? localize('dispatchTimeline.unreadableLine', "Dispatch could not read the timeline just now.") : '');
			return;
		}
		const run = d.run;
		if (run && !this.showSessions) {
			this.renderRun(run);
		} else {
			this.renderSessions(d.lanes, d.now, run);
		}
		this.placeCard();
	}

	// ---------------------------------------------------------------- shared parts of the page

	private head(mark: HTMLElement, title: string, line: string | HTMLElement): HTMLElement {
		const head = dom.append(this.element, dom.$('.dt-head'));
		head.appendChild(mark);
		const words = dom.append(head, dom.$('.dt-words'));
		dom.append(words, dom.$('h2.dt-title', { title }, title));
		if (typeof line !== 'string') {
			words.appendChild(line);
		} else if (line) {
			dom.append(words, dom.$('p.dt-line', undefined, line));
		}
		return dom.append(head, dom.$('.dt-actions'));
	}

	/** The lanes: a heading with its legend, the axis, then the rows (one Now line runs down through them). */
	private lanes(title: string, legend: [string, string][]): { lanes: HTMLElement; head: HTMLElement } {
		const lanes = dom.append(this.element, dom.$('.dt-lanes'));
		const head = dom.append(lanes, dom.$('.dt-lanes-head'));
		dom.append(head, dom.$('span.dt-lanes-title', undefined, title));
		const lg = dom.append(head, dom.$('span.dt-legend'));
		for (const [kind, words] of legend) {
			const item = dom.append(lg, dom.$('span.dt-legend-item'));
			dom.append(item, dom.$(`i.dt-sw.${kind}`));
			dom.append(item, dom.$('span', undefined, words));
		}
		return { lanes, head };
	}

	private row(parent: HTMLElement, cls: string): { row: HTMLElement; label: HTMLElement; track: HTMLElement; side: HTMLElement } {
		const row = dom.append(parent, dom.$(`.dt-row.${cls}`));
		const label = dom.append(row, dom.$('.dt-label'));
		const track = dom.append(row, dom.$('.dt-track'));
		const side = dom.append(row, dom.$('.dt-side'));
		return { row, label, track, side };
	}

	/** The rows' one Now line, and the refill's dashed line, drawn over all of them. */
	private overlay(rows: HTMLElement, ax: IAxis, now: number | undefined, refill?: number): void {
		if (refill && refill > ax.from && refill < ax.to) {
			const r = dom.append(rows, dom.$('span.dt-refline'));
			r.style.left = onAxis(ax.x(refill));
		}
		if (now !== undefined) {
			const l = dom.append(rows, dom.$('span.dt-nowline'));
			l.style.left = onAxis(ax.x(now));
		}
	}

	/** A Now line inside one track (the allowance band). */
	private nowLine(track: HTMLElement, ax: IAxis, now: number): void {
		const l = dom.append(track, dom.$('.dt-now'));
		l.style.left = `${ax.x(now)}%`;
	}

	private axisRow(parent: HTMLElement, ax: IAxis, now: number | undefined, marks: { at: number; text: string }[] = []): void {
		const { track } = this.row(parent, 'dt-axis');
		for (const t of ticks(ax.from, ax.to)) {
			const x = ax.x(t);
			// a round time right next to now or to a mark (the refill) would print over it
			if ((now !== undefined && Math.abs(x - ax.x(now)) < 7) || marks.some(m => Math.abs(x - ax.x(m.at)) < 7) || x < 3 || x > 97) {
				continue;
			}
			const tk = dom.append(track, dom.$('span.dt-tick', undefined, hm(t)));
			tk.style.left = `${x}%`;
		}
		for (const m of marks) {
			const tk = dom.append(track, dom.$('span.dt-tick.mark', undefined, m.text));
			tk.style.left = `${ax.x(m.at)}%`;
		}
		if (now !== undefined) {
			const n = dom.append(track, dom.$('span.dt-now-label', undefined, localize('dispatchTimeline.now', "Now {0}", hm(now))));
			n.style.left = `${ax.x(now)}%`;
		}
	}

	private bar(track: HTMLElement, ax: IAxis, s: Seg | [number, number, string], extra = ''): HTMLElement {
		const kind = ['work', 'fix', 'needs', 'paused', 'wait'].includes(s[2]) ? s[2] : 'work';
		const b = dom.append(track, dom.$(`span.dt-bar.${kind}${extra}`));
		const l = ax.x(s[0]);
		b.style.left = `${l}%`;
		b.style.width = `${Math.max(0.5, ax.x(s[1]) - l)}%`;
		return b;
	}

	private at(track: HTMLElement, ax: IAxis, t: number, el: HTMLElement): HTMLElement {
		const pin = dom.append(track, dom.$('span.dt-pin'));
		pin.style.left = `${ax.x(t)}%`;
		pin.appendChild(el);
		return pin;
	}

	/** The dot at Now on a lane that is at work: working (green, pinging), needs you (amber), fixing (coral). */
	private dot(kind: 'working' | 'waiting' | 'stopped'): HTMLElement {
		return dom.$(`span.dt-dot.${kind}`);
	}

	/** A done part: the done block with its check, where it went in (the shared state blocks, DESIGN.md「Dispatch 方块」). */
	private doneMark(): HTMLElement {
		const m = dom.$('span.dt-mk.done');
		m.appendChild(stateBlock('done', { size: 14, title: '' }));
		return m;
	}

	/** A press and release on the lane does `act`: open its card, or open a fold. */
	private clickLane(row: HTMLElement, key: string, label: string, act: () => void, expanded: boolean): void {
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		row.setAttribute('aria-expanded', String(expanded));
		row.setAttribute('aria-label', label);
		// press and release on the same lane: the page is redrawn every few seconds, so the row pressed may be a new
		// element by the release and the browser's click would be lost
		row.dataset.key = key;
		this.flips.set(key, act);
		this.renderStore.add(dom.addDisposableListener(row, dom.EventType.MOUSE_DOWN, e => {
			this.pressed = e.button === 0 && !(e.target as HTMLElement).closest('button') ? key : undefined;
		}));
		this.renderStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
				e.preventDefault();
				act();
			}
		}));
	}

	private toggle(key: string): void {
		if (this.open.has(key)) {
			this.open.delete(key);
		} else {
			this.open.add(key);
		}
		this.render(true);
	}

	private cardLane(row: HTMLElement, key: string, label: string): void {
		row.classList.toggle('carded', this.card === key);
		this.clickLane(row, key, label, () => {
			this.card = this.card === key ? undefined : key;
			this.render(true);
		}, this.card === key);
	}

	/** Close the card where it is, without drawing the page again (a press elsewhere must still reach what it pressed). */
	private closeCard(): void {
		this.card = undefined;
		this.element.querySelector('.dt-pop')?.remove();
		for (const row of this.element.querySelectorAll<HTMLElement>('.dt-row.carded')) {
			row.classList.remove('carded');
			row.setAttribute('aria-expanded', 'false');
		}
	}

	// ---------------------------------------------------------------- the card a lane opens

	/** The card of the lane `this.card`, made by the lane's renderer and placed under it once the page is laid out. */
	private cardContent: HTMLElement | undefined;

	private makeCard(title: string, block: HTMLElement | undefined): HTMLElement {
		const pop = dom.$('.dt-pop');
		pop.setAttribute('role', 'dialog');
		pop.setAttribute('aria-label', title);
		const head = dom.append(pop, dom.$('.dt-pop-head'));
		if (block) {
			head.appendChild(block);
		}
		dom.append(head, dom.$('span.dt-pop-title', undefined, title));
		const close = dom.append(head, dom.$<HTMLButtonElement>('button.dt-icon.dt-pop-close', { type: 'button', title: localize('dispatchTimeline.close', "Close"), 'aria-label': localize('dispatchTimeline.close', "Close") }));
		close.appendChild(renderIcon(Codicon.close));
		this.renderStore.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.closeCard()));
		this.cardContent = pop;
		return pop;
	}

	private cardLine(pop: HTMLElement, text: string, cls = ''): HTMLElement {
		return dom.append(pop, dom.$(`p.dt-pop-line${cls ? '.' + cls : ''}`, undefined, text));
	}

	private cardButton(pop: HTMLElement, label: string, run: () => void): void {
		const foot = pop.querySelector<HTMLElement>('.dt-pop-foot') ?? dom.append(pop, dom.$('.dt-pop-foot'));
		const b = pill(foot, label, 'outline');
		b.classList.add('xs');
		this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, run));
	}

	/** Put the open card under its lane, its left edge on the lane's name, inside the Timeline; above it when there is no room below. */
	private placeCard(): void {
		const pop = this.cardContent;
		this.cardContent = undefined;
		if (!pop || !this.card) {
			return;
		}
		const row = this.element.querySelector<HTMLElement>(`.dt-row[data-key="${CSS.escape(this.card)}"]`);
		if (!row) {
			this.card = undefined;
			return;
		}
		this.element.appendChild(pop);
		const place = () => {
			if (!pop.isConnected) {
				return;
			}
			const box = this.element.getBoundingClientRect();
			const r = row.getBoundingClientRect();
			const name = row.querySelector('.dt-name')?.getBoundingClientRect() ?? r;
			const width = Math.min(360, box.width - 16);
			const left = Math.max(8, Math.min(name.left - box.left - 12, box.width - width - 8));
			pop.style.width = `${width}px`;
			pop.style.left = `${left}px`;
			const below = r.bottom - box.top + 4;
			const roomBelow = mainWindow.innerHeight - r.bottom;
			pop.style.top = roomBelow < pop.offsetHeight + 16 && r.top - box.top > pop.offsetHeight + 8 ? `${r.top - box.top - pop.offsetHeight - 4}px` : `${below}px`;
		};
		place();
		if (!this.element.isConnected) {
			mainWindow.setTimeout(place, 0);
		}
	}

	// ---------------------------------------------------------------- a Turbo run

	private renderRun(run: ITurboRun): void {
		const planning = run.state === 'planning' || run.state === 'planned' || run.state === 'failed';
		const arrive = this.lastCombined >= 0 && run.combined > this.lastCombined ? Math.round(Math.min(1, run.combined / Math.max(1, run.total)) * 10) - 1 : undefined;
		this.lastCombined = run.combined;
		// the colours come in once, the first time this run is seen done; after that the icon just stays
		const firstDone = run.state === 'done' && this.doneSeen !== run.id;
		if (run.state === 'done') {
			this.doneSeen = run.id;
		}
		const mark = turboMark(36, run.state === 'done' ? Array(10).fill(true) : markCells(run.combined, run.total), { done: run.state === 'done', arrive, think: run.state === 'planning' });
		mark.classList.toggle('still', run.state === 'done' && !firstDone);
		this.element.classList.toggle('dt-settled', run.state === 'done' && !firstDone);
		const actions = this.head(mark, run.title, this.runLine(run));
		this.element.classList.toggle('dt-state-done', run.state === 'done');
		if (run.state !== 'planned') {
			const chip = dom.append(actions, dom.$('span.dt-folder', { title: run.repo }));
			chip.appendChild(renderIcon(Codicon.folder));
			dom.append(chip, dom.$('span', undefined, run.project));
		}
		if (run.state === 'running' || run.state === 'combining') {
			const b = pill(actions, localize('dispatchTimeline.pause', "Pause"), 'outline', Codicon.debugPause);
			b.title = localize('dispatchTimeline.pauseTip', "The parts that are working finish the step they are on, commit, and stop.");
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this.act('pause', run.id)));
		} else if (run.state === 'paused') {
			const b = pill(actions, localize('dispatchTimeline.resume', "Carry on"), 'outline', Codicon.debugContinue);
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this.act('resume', run.id)));
		}
		if (isActive(run) && !planning) {
			const more = dom.append(actions, dom.$<HTMLButtonElement>('button.dt-icon', { type: 'button', title: localize('dispatchTimeline.more', "More") }));
			more.appendChild(renderIcon(Codicon.ellipsis));
			this.renderStore.add(dom.addDisposableListener(more, dom.EventType.CLICK, () => this.contextMenuService.showContextMenu({
				getAnchor: () => more,
				getActions: () => [new Action('dispatch.turbo.cancel', localize('dispatchTimeline.stopRun', "Stop the Run…"), undefined, true, () => this.cancel(run))],
			})));
		}
		if (!isActive(run)) {
			const b = pill(actions, localize('dispatchTimeline.yourSessions', "Your sessions"), 'ghost');
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => { this.showSessions = true; this.card = undefined; this.render(); }));
		}
		if (run.state === 'planning') {
			dom.append(this.element, dom.$('p.dt-ask', undefined, `“${run.ask}”`));
			const foot = dom.append(this.element, dom.$('.dt-foot'));
			const c = pill(foot, localize('dispatchTimeline.cancel', "Cancel"), 'ghost');
			this.renderStore.add(dom.addDisposableListener(c, dom.EventType.CLICK, () => void this.act('cancel', run.id)));
			return;
		}
		if (run.state === 'failed') {
			const foot = dom.append(this.element, dom.$('.dt-foot'));
			const c = pill(foot, localize('dispatchTimeline.dismiss', "Dismiss"), 'outline');
			this.renderStore.add(dom.addDisposableListener(c, dom.EventType.CLICK, () => void this.act('cancel', run.id)));
			return;
		}
		if (run.state === 'planned') {
			this.renderPlanControls(run);
		}
		for (const n of run.needs) {
			this.renderNeed(run, n);
		}
		if (run.state === 'paused' && run.allowance?.paused) {
			this.renderStopped(run);
		}
		if (run.state === 'done') {
			this.renderSummary(run);
		}
		const [from, to] = runSpan(run);
		const ax = axis(from, to);
		const live = run.state !== 'planned' && run.state !== 'done' && run.state !== 'cancelled';
		const { lanes, head } = this.lanes(localize('dispatchTimeline.parts', "Parts"), [
			['working', localize('dispatchTimeline.lgWorking', "working")],
			['waiting', localize('dispatchTimeline.lgNeeds', "needs you")],
			['bar', localize('dispatchTimeline.lgDone', "done so far")],
			['box', localize('dispatchTimeline.lgPlanned', "planned")],
			['combined', localize('dispatchTimeline.lgCombined', "combined")],
		]);
		if (isActive(run) && run.state !== 'combining') {
			const add = dom.$<HTMLButtonElement>('button.dt-add', { type: 'button' });
			add.appendChild(renderIcon(Codicon.add));
			dom.append(add, dom.$('span', undefined, localize('dispatchTimeline.add', "Add a part")));
			head.insertBefore(add, head.querySelector('.dt-legend'));
			this.renderStore.add(dom.addDisposableListener(add, dom.EventType.CLICK, () => void this.addPart(run)));
		}
		if (run.state !== 'planned') {
			this.renderBand(lanes, run, ax);
			lanes.insertBefore(lanes.lastElementChild!, head);
		}
		const refill = run.allowance?.resets_at && run.allowance.resets_at > from && run.allowance.resets_at < to ? run.allowance.resets_at : undefined;
		this.axisRow(lanes, ax, live ? run.now : undefined, refill ? [{ at: refill, text: localize('dispatchTimeline.refill', "{0} refill", hm(refill)) }] : []);
		const rows = dom.append(lanes, dom.$('.dt-rows'));
		const collapsed = run.state === 'done' && !this.open.has('parts');
		if (collapsed) {
			const { row, label, track, side } = this.row(rows, 'dt-lane.dt-merged');
			label.appendChild(stateBlock('done', { size: 14, title: '' }));
			dom.append(label, dom.$('span.dt-name', undefined, partsWords(run.total)));
			const s = run.started_at ?? from;
			this.bar(track, ax, [s, run.done_at ?? run.now, 'work']);
			this.at(track, ax, run.done_at ?? run.now, this.doneMark());
			dom.append(side, dom.$('span', undefined, run.total === 1 ? localize('dispatchTimeline.mergedOne', "1 part → the result") : localize('dispatchTimeline.merged', "{0} parts → one result", run.total)));
			this.clickLane(row, 'parts', run.total === 1 ? localize('dispatchTimeline.showPart', "Show the part") : localize('dispatchTimeline.showParts', "Show the {0} parts", run.total), () => this.toggle('parts'), false);
		} else {
			const inOpenFold = new Set<number>();
			for (const item of laneItems(run, this.open)) {
				if (item.kind === 'fold') {
					this.renderFold(rows, run, item, ax);
					if (item.open) {
						item.parts.forEach(p => inOpenFold.add(p.n));
					}
				} else {
					this.renderPartLane(rows, run, item.part, ax, inOpenFold.has(item.part.n));
				}
			}
			this.drawDependencies(rows, run, ax);
		}
		this.renderCombine(rows, run, ax);
		this.overlay(rows, ax, live ? run.now : undefined, refill);
		if (run.shared?.length && run.state === 'planned') {
			dom.append(this.element, dom.$('p.dt-note', undefined, localize('dispatchTimeline.kept', "Kept for the end: {0}. Several parts need them, so each part leaves them alone and they are changed once, when the parts are combined.", run.shared.map(s => s.file.split('/').pop()).join(', '))));
		}
	}

	/** The run's line under its title: the sentence, and what needs the person as an amber tag (proto-a's「1 needs you」). */
	private runLine(run: ITurboRun): HTMLElement {
		const line = dom.$('p.dt-line', undefined, runSentence(run));
		if (run.needs.length) {
			dom.append(line, dom.$('span.dt-tag.waiting', undefined, run.needs.length === 1 ? localize('dispatchTimeline.needsOne', "1 needs you") : localize('dispatchTimeline.needsN', "{0} need you", run.needs.length)));
		}
		return line;
	}

	private renderPlanControls(run: ITurboRun): void {
		const box = dom.append(this.element, dom.$('.dt-plan'));
		const line1 = dom.append(box, dom.$('.dt-plan-row'));
		dom.append(line1, dom.$('span.dt-k', undefined, localize('dispatchTimeline.in', "In")));
		const folder = dom.append(line1, dom.$<HTMLButtonElement>('button.dt-chip', { type: 'button', title: run.repo }));
		folder.appendChild(renderIcon(Codicon.folder));
		dom.append(folder, dom.$('span', undefined, run.project));
		folder.appendChild(renderIcon(Codicon.chevronDown));
		this.renderStore.add(dom.addDisposableListener(folder, dom.EventType.CLICK, () => this.contextMenuService.showContextMenu({
			getAnchor: () => folder,
			getActions: () => (run.folders ?? []).map(f => {
				const a = new Action(`dispatch.turbo.folder.${f.name}`, f.name, undefined, true, () => f.path !== run.repo ? this.act('replan', run.id, { cwd: f.path }) : undefined);
				a.checked = f.path === run.repo;
				a.tooltip = f.path;
				return a;
			}),
		})));
		dom.append(line1, dom.$('span.dt-k', undefined, localize('dispatchTimeline.on', "Parts run on")));
		const engine = dom.append(line1, dom.$<HTMLButtonElement>('button.dt-chip', { type: 'button' }));
		dom.append(engine, dom.$('span', undefined, run.model ? `${run.engine_name} · ${run.model.split('/').pop()}` : (run.engine_name ?? run.engine)));
		engine.appendChild(renderIcon(Codicon.chevronDown));
		this.renderStore.add(dom.addDisposableListener(engine, dom.EventType.CLICK, () => this.contextMenuService.showContextMenu({
			getAnchor: () => engine,
			getActions: () => [['claude', 'Claude'], ['codex', 'ChatGPT · Codex'], ['opencode', 'OpenCode']].map(([id, label]) => {
				const a = new Action(`dispatch.turbo.engine.${id}`, label, undefined, true, () => id !== run.engine ? this.act('replan', run.id, { engine: id }) : undefined);
				a.checked = id === run.engine;
				return a;
			}),
		})));
		// one part runs alone: no "At a time" to pick (task-lj06.29)
		const seg = run.total > 1 ? dom.append(line1, dom.$('.dt-seg')) : undefined;
		if (seg) {
			line1.insertBefore(dom.$('span.dt-k', undefined, localize('dispatchTimeline.atATime', "At a time")), seg);
		}
		for (const k of seg ? [2, 4, 6] : []) {
			const at = run.plan.options?.[String(k)];
			const b = dom.append(seg!, dom.$<HTMLButtonElement>(`button${k === run.slots ? '.on' : ''}`, { type: 'button', title: at ? localize('dispatchTimeline.optionTip', "{0} at a time: done around {1}", k, hm(at)) : '' }, String(k)));
			b.setAttribute('aria-pressed', String(k === run.slots));
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => k !== run.slots ? void this.act('replan', run.id, { atATime: k }) : undefined));
		}
		const words = dom.append(box, dom.$('.dt-plan-words'));
		dom.append(words, dom.$('span.dt-strong', undefined, run.plan.done_words));
		const readable = ['claude', 'codex'].includes(run.engine);
		dom.append(words, dom.$('span', undefined, ` · ${readable ? `${run.plan.allowance} · ` : ''}${localize('dispatchTimeline.oneByOne', "one part after another: about {0}", duration(run.plan.sequential_minutes))}`));
		dom.append(box, dom.$('p.dt-plan-rule', undefined, run.plan.rule ? run.plan.rule : readable
			? localize('dispatchTimeline.rule', "Turbo keeps no allowance back for itself. Near the limit it runs half as many parts at once; just before the limit the parts finish their step and stop until the refill. It never switches accounts by itself.")
			: localize('dispatchTimeline.ruleUnknown', "{0}'s allowance is not readable here, so Turbo cannot slow down on its own.", run.engine_name ?? run.engine)));
		const foot = dom.append(box, dom.$('.dt-foot'));
		const start = pill(foot, localize('dispatchTimeline.start', "Start"), 'solid');
		this.renderStore.add(dom.addDisposableListener(start, dom.EventType.CLICK, () => void this.act('start', run.id)));
		const cancel = pill(foot, localize('dispatchTimeline.cancel', "Cancel"), 'ghost');
		this.renderStore.add(dom.addDisposableListener(cancel, dom.EventType.CLICK, () => void this.act('cancel', run.id)));
		dom.append(foot, dom.$('span.dt-foot-note', undefined, localize('dispatchTimeline.copies', "Each part works in its own copy of {0}, made when it starts. Nothing runs before you press Start.", run.project)));
	}

	private renderNeed(run: ITurboRun, n: ITurboNeed): void {
		const card = dom.append(this.element, dom.$('.dt-need'));
		card.appendChild(stateBlock('waiting', { size: 14, knock: true, title: '' }));
		const words = dom.append(card, dom.$('.dt-need-words'));
		dom.append(words, dom.$('span.dt-need-from', undefined, typeof n.part === 'number' ? `${n.part} · ${n.name}` : n.name));
		dom.append(words, dom.$('span.dt-need-q', undefined, n.question));
		const btns = dom.append(card, dom.$('.dt-need-btns'));
		(n.options.length ? n.options : [localize('dispatchTimeline.yes', "Yes"), localize('dispatchTimeline.no', "No")]).forEach((o, i) => {
			const b = pill(btns, o, i === 0 ? 'outline' : 'ghost');
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this.act('answer', run.id, n.part, o)));
		});
		if (n.kind !== 'failed') {
			const other = pill(btns, localize('dispatchTimeline.answer', "Answer…"), 'ghost');
			this.renderStore.add(dom.addDisposableListener(other, dom.EventType.CLICK, async () => {
				const text = await this.quickInputService.input({ prompt: n.question, placeHolder: localize('dispatchTimeline.answerPh', "Your answer") });
				if (text?.trim()) {
					await this.act('answer', run.id, n.part, text.trim());
				}
			}));
		}
	}

	/**
	 * Stopped for the allowance: it carries on by itself at the refill; or, only on the person's click, with another
	 * account of the same agent that has allowance left (the accounts of `dispatch accounts`, as the account menu).
	 */
	private renderStopped(run: ITurboRun): void {
		const engine = run.allowance.engine ?? run.engine;
		if (!this.others || this.others.engine !== engine || Date.now() - this.others.at > 60_000) {
			this.others = { engine, at: Date.now(), rows: this.others?.engine === engine ? this.others.rows : [] };
			void this.commandService.executeCommand<{ engine: string; others?: { id: string; name: string; short?: string; level?: string; needs_signin?: boolean }[] }[]>('dispatch.accounts', 'status').then(rows => {
				const row = Array.isArray(rows) ? rows.find(r => r.engine === engine) : undefined;
				this.others = { engine, at: Date.now(), rows: (row?.others ?? []).filter(o => !o.needs_signin && o.level !== 'out' && o.id) };
				this.render(true);
			}, () => undefined);
		}
		const card = dom.append(this.element, dom.$('.dt-need.dt-stopped'));
		card.appendChild(stateBlock('stopped', { size: 14, title: '' }));
		const words = dom.append(card, dom.$('.dt-need-words'));
		dom.append(words, dom.$('span.dt-need-q', undefined, run.allowance.stopped_words || localize('dispatchTimeline.stoppedQ', "Stopped at a clean point near the limit. It carries on by itself at {0}.", hm(run.allowance.resume_at))));
		const rows = this.others.rows;
		const alts = run.allowance.alternatives ?? [];
		const name = run.allowance.engine_name ?? engine;
		dom.append(words, dom.$('span.dt-need-from', undefined, rows.length && alts.length
			? localize('dispatchTimeline.switchNoteBoth', "Or go on now: with another {0} account (it switches for this whole Mac, your own sessions too), or with another agent. The parts that stopped take their work with them; new parts come back to {0} at {1}.", name, hm(run.allowance.resume_at))
			: rows.length
				? localize('dispatchTimeline.switchNote', "Or go on now with another account. Switching the {0} account switches it for this whole Mac, your own sessions too.", name)
				: alts.length && run.allowance.paused_kind === 'provider'
					? localize('dispatchTimeline.otherAgentNoteProvider', "Or go on now with another agent. The parts that stopped take their work with them.")
				: alts.length
					? localize('dispatchTimeline.otherAgentNote', "Or go on now with another agent. The parts that stopped take their work with them; new parts come back to {0} at {1}.", name, hm(run.allowance.resume_at))
					: run.allowance.paused_kind === 'provider'
						? localize('dispatchTimeline.noOtherAgent', "No other agent with allowance left is signed in on this Mac.")
						: localize('dispatchTimeline.noOther', "No other {0} account with allowance left is signed in on this Mac.", name)));
		const btns = dom.append(card, dom.$('.dt-need-btns'));
		for (const o of rows.slice(0, 2)) {
			const b = pill(btns, o.short ? localize('dispatchTimeline.useAccount', "Use {0} · {1} used", o.name, o.short) : localize('dispatchTimeline.useAccountPlain', "Use {0}", o.name), 'outline', Codicon.account);
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, async () => {
				const r = await this.commandService.executeCommand<{ ok?: boolean; message?: string }>('dispatch.accounts', 'use', engine, o.id).catch(() => ({ ok: false, message: undefined }));
				if (r && r.ok === false) {
					this.notificationService.warn(r.message || localize('dispatchTimeline.switchFailed', "The account could not be switched just now."));
					return;
				}
				await this.act('resume', run.id);
			}));
		}
		// another agent, second: the parts that stopped are handed over (dispatch turbo switch); only on this click
		for (const alt of alts.slice(0, 2)) {
			const label = alt.model ? `${alt.name} · ${alt.model.split('/').pop()}` : alt.name;
			const b = pill(btns, localize('dispatchTimeline.goOnWith', "Go on with {0}", label), 'outline', agentIcon(alt.engine));
			b.dataset.engine = alt.engine;
			b.title = alt.words ? `${label}: ${alt.words}` : label;
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this.act('switch', run.id, { engine: alt.engine, model: alt.model || undefined })));
		}
	}

	private renderBand(panel: HTMLElement, run: ITurboRun, ax: IAxis): void {
		const a = run.allowance;
		const { row, label, track, side } = this.row(panel, 'dt-band');
		dom.append(label, dom.$('span.dt-band-name', { title: localize('dispatchTimeline.allowance', "{0} allowance", a?.engine_name ?? run.engine) }, a?.engine_name ?? run.engine));
		// where it stood still for the allowance before going on with another agent: striped, and the hand-over marked
		for (const [from, to] of a?.stops ?? []) {
			const stop = dom.append(track, dom.$('span.dt-band-paused.past', { title: localize('dispatchTimeline.stoppedStretch', "Stopped for the allowance {0} to {1}", hm(from), hm(to)) }));
			stop.style.left = `${ax.x(from)}%`;
			stop.style.width = `${Math.max(0.4, ax.x(to) - ax.x(from))}%`;
		}
		const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
		const switches = run.switches ?? [];
		for (const sw of switches) {
			// on a band without a line (the allowance is not readable) the words say it instead of the mark
			const m = dom.append(track, dom.$('span.dt-band-mark.switch', undefined, a?.known ? `${names[sw.from] ?? sw.from} → ${names[sw.to] ?? sw.to}` : ''));
			m.style.left = `${ax.x(sw.at)}%`;
		}
		if (run.was?.back_at) {
			dom.append(side, dom.$('span.dt-band-words.dt-back', undefined, localize('dispatchTimeline.backAt', "New parts go back to {0} at {1}", run.was.engine_name, hm(run.was.back_at))));
		}
		if (!a?.known) {
			row.classList.add('unknown');
			const last = switches[switches.length - 1];
			const moved = last ? localize('dispatchTimeline.switchedAt', "{0} → {1} at {2}. ", names[last.from] ?? last.from, names[last.to] ?? last.to, hm(last.at)) : '';
			dom.append(track, dom.$('span.dt-band-words', undefined, moved + (a?.words ?? '')));
			return;
		}
		dom.append(label, dom.$('span.dt-band-sub', undefined, a.resets_at ? localize('dispatchTimeline.refills', "refills {0}", hm(a.resets_at)) : localize('dispatchTimeline.allowanceWord', "allowance")));
		const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 1000 100');
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.setAttribute('class', 'dt-band-svg');
		const y = (pct: number) => 96 - Math.max(0, Math.min(100, pct)) * 0.92;
		const x = (t: number) => ax.x(t) * 10;
		const line = (pts: readonly (readonly [number, number])[], cls: string) => {
			if (pts.length < 1) {
				return;
			}
			const pl = mainWindow.document.createElementNS(SVG_NS, 'polyline');
			const all = pts.length === 1 ? [pts[0], [run.now, pts[0][1]] as const] : pts;
			pl.setAttribute('points', all.map(p => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' '));
			pl.setAttribute('class', cls);
			pl.setAttribute('vector-effect', 'non-scaling-stroke');
			svg.appendChild(pl);
		};
		const hline = (pct: number, cls: string) => {
			const l = mainWindow.document.createElementNS(SVG_NS, 'line');
			l.setAttribute('x1', '0'); l.setAttribute('x2', '1000');
			l.setAttribute('y1', String(y(pct))); l.setAttribute('y2', String(y(pct)));
			l.setAttribute('class', cls);
			l.setAttribute('vector-effect', 'non-scaling-stroke');
			svg.appendChild(l);
		};
		hline(a.slow_at, 'slow');
		hline(100, 'limit');
		line(a.readings, 'used');
		line(a.projection, 'ahead');
		track.appendChild(svg);
		if (a.paused && a.paused_at) {
			const stop = dom.append(track, dom.$('span.dt-band-paused', { title: localize('dispatchTimeline.pausedStretch', "Stopped for the allowance until {0}", hm(a.resume_at)) }));
			stop.style.left = `${ax.x(a.paused_at)}%`;
			stop.style.width = `${Math.max(0.4, ax.x(a.resume_at ?? run.now) - ax.x(a.paused_at))}%`;
		}
		const slowLabel = dom.append(track, dom.$('span.dt-band-tag.right', undefined, localize('dispatchTimeline.slowsAt', "slows at {0}%", a.slow_at)));
		slowLabel.style.top = `${y(a.slow_at) - 1}%`;
		if (a.resets_at && a.resets_at < ax.to) {
			const r = dom.append(track, dom.$('span.dt-band-refill'));
			r.style.left = `${ax.x(a.resets_at)}%`;
		}
		if (a.slowed && a.slowed_at) {
			const s = dom.append(track, dom.$('span.dt-band-mark', undefined, localize('dispatchTimeline.slowedTag', "{0} at a time", run.slots_now)));
			s.style.left = `${ax.x(a.slowed_at)}%`;
		}
		this.nowLine(track, ax, run.now);
		const used = Math.round(a.used ?? 0);
		const big = dom.append(side, dom.$('span.dt-band-used'));
		dom.append(big, dom.$('strong', undefined, `${used}%`));
		dom.append(big, dom.$('span', undefined, ` ${localize('dispatchTimeline.usedNow', "used now")}`));
		dom.append(side, dom.$('span.dt-band-words', { title: a.words }, a.words));
		if (a.slowed && run.state === 'running') {
			const keep = dom.append(side, dom.$<HTMLButtonElement>('button.dt-link', { type: 'button' }, localize('dispatchTimeline.keep', "Keep {0} at a time", run.slots)));
			this.renderStore.add(dom.addDisposableListener(keep, dom.EventType.CLICK, () => void this.act('keep', run.id)));
		}
	}

	private renderPartLane(rows: HTMLElement, run: ITurboRun, p: ITurboPart, ax: IAxis, inFold = false): void {
		const key = `p${p.n}`;
		const { row, label, track, side } = this.row(rows, `dt-lane.s-${p.status}`);
		row.dataset.n = String(p.n);
		row.classList.toggle('in-fold', inFold);
		dom.append(label, dom.$('span.dt-n', undefined, String(p.n)));
		dom.append(label, dom.$('span.dt-name', undefined, p.name));
		const live = run.state !== 'planned';
		if (live) {
			for (const s of p.segs ?? []) {
				this.bar(track, ax, s);
			}
		}
		const plan = plannedBox(run, p);
		if (plan) {
			const box = dom.append(track, dom.$('span.dt-box'));
			box.style.left = `${ax.x(plan[0])}%`;
			box.style.width = `${Math.max(0.8, ax.x(plan[1]) - ax.x(plan[0]))}%`;
			// where it is planned to go in: a hollow ring (proto-a)
			this.at(track, ax, plan[1], dom.$('span.dt-mk.todo'));
		}
		if (p.status === 'combined' && p.combined_at) {
			this.at(track, ax, p.combined_at, this.doneMark()).title = localize('dispatchTimeline.combinedAt', "Combined {0} · {1}", ordinal(p.combined_n ?? 0), hm(p.combined_at));
		} else if (['working', 'starting', 'fixing', 'needs'].includes(p.status) && live) {
			this.at(track, ax, run.now, this.dot(p.status === 'needs' ? 'waiting' : p.status === 'fixing' ? 'stopped' : 'working'));
		}
		this.partSide(side, run, p);
		this.cardLane(row, key, p.name);
		this.hoverLane(row, run, p);
		if (this.card === key) {
			this.partCard(run, p);
		}
	}

	/** What a part does, on the right of its lane: a dot in its state's colour, then the words (proto-a's status column). */
	private partSide(side: HTMLElement, run: ITurboRun, p: ITurboPart): void {
		const words = this.partWords(run, p);
		if (p.status === 'combined') {
			side.appendChild(renderIcon(Codicon.check));
		} else if (['working', 'starting'].includes(p.status)) {
			side.appendChild(this.dot('working'));
		} else if (p.status === 'needs') {
			side.appendChild(this.dot('waiting'));
			dom.append(side, dom.$('strong', undefined, localize('dispatchTimeline.needsYouWord', "Needs you")));
			dom.append(side, dom.$('span', undefined, `· ${localize('dispatchTimeline.questionAbove', "question above")}`));
			return;
		} else if (p.status === 'fixing' || p.status === 'failed') {
			side.appendChild(this.dot('stopped'));
		}
		dom.append(side, dom.$('span', undefined, words));
	}

	/** A part's card: its name, what it does now, its files, when it started, its agent; Open session. */
	private partCard(run: ITurboRun, p: ITurboPart): void {
		const pop = this.makeCard(p.name, stateBlock(partBlock(p.status), { size: 14, breathe: p.status === 'working', title: '' }));
		this.cardLine(pop, [localize('dispatchTimeline.partN', "Part {0}", p.n), p.engine_name || (run.model ? `${run.engine_name} · ${run.model.split('/').pop()}` : (run.engine_name ?? run.engine))].join(' · '), 'meta');
		this.cardLine(pop, this.partWords(run, p), 'now');
		const kv = dom.append(pop, dom.$('.dt-pop-kv'));
		const line = (k: string, v: string) => {
			dom.append(kv, dom.$('span.dt-pop-k', undefined, k));
			dom.append(kv, dom.$('span.dt-pop-v', undefined, v));
		};
		line(localize('dispatchTimeline.cardFiles', "Files"), p.files?.length ? p.files.join(', ') : localize('dispatchTimeline.cardFilesLater', "decided when it starts"));
		line(localize('dispatchTimeline.cardStarted', "Started"), p.started_at ? hm(p.started_at) : localize('dispatchTimeline.cardNotYet', "not yet"));
		if (p.after?.length && !p.started_at) {
			line(localize('dispatchTimeline.cardAfter', "Waits for"), localize('dispatchTimeline.startsAfter', "part {0} to be combined", p.after.join(', ')));
		}
		line(localize('dispatchTimeline.cardCopy', "Copy"), p.started_at
			? localize('dispatchTimeline.cardCopyReady', "its own copy of {0}, ready at {1}", run.project, hm(p.started_at))
			: localize('dispatchTimeline.cardCopyLater', "its own copy of {0}, made just before it starts", run.project));
		if (p.session) {
			this.cardButton(pop, localize('dispatchTimeline.openSession', "Open session"), () => void this.openSession(p.session!));
		}
	}

	/**
	 * A fold: the combined parts as one row (one bar from the first start to the last one in), or the parts not started
	 * yet as one row (one dashed box over their forecast). A click opens it: its row stays, its parts follow it.
	 */
	private renderFold(rows: HTMLElement, run: ITurboRun, item: Extract<LaneItem, { kind: 'fold' }>, ax: IAxis): void {
		const n = item.parts.length;
		const { row, label, track, side } = this.row(rows, `dt-lane.dt-fold.f-${item.key}`);
		row.dataset.parts = item.parts.map(p => p.n).join(' ');
		const ic = dom.append(label, dom.$('span.dt-n'));
		ic.appendChild(renderIcon(item.key === 'combined' ? Codicon.check : Codicon.clock));
		const name = item.key === 'combined' ? localize('dispatchTimeline.foldCombined', "Combined · {0} parts", n)
			: isActive(run) ? localize('dispatchTimeline.foldLater', "Up next · {0} parts", n) : localize('dispatchTimeline.foldNotStarted', "Not started · {0} parts", n);
		dom.append(label, dom.$('span.dt-name', undefined, name));
		label.appendChild(renderIcon(item.open ? Codicon.chevronDown : Codicon.chevronRight)).classList.add('dt-caret');
		const span = foldSpan(run, item.parts, item.key);
		if (span && item.key === 'combined') {
			for (const p of item.parts) {
				if (p.combined_at) {
					this.at(track, ax, p.combined_at, this.doneMark());
				}
			}
		} else if (span) {
			const box = dom.append(track, dom.$('span.dt-box'));
			box.style.left = `${ax.x(span[0])}%`;
			box.style.width = `${Math.max(0.8, ax.x(span[1]) - ax.x(span[0]))}%`;
		}
		dom.append(side, dom.$('span', undefined, item.key === 'combined'
			? (span ? localize('dispatchTimeline.foldCombinedSide', "already in, the last at {0}", hm(span[1])) : '')
			: (span ? localize('dispatchTimeline.foldLaterSide', "start as others finish, about {0} on", hm(span[0])) : localize('dispatchTimeline.foldLaterPlain', "Not started"))));
		this.clickLane(row, `fold-${item.key}`, item.open
			? localize('dispatchTimeline.foldClose', "Fold the {0} parts back into one row", n)
			: localize('dispatchTimeline.foldOpen', "Show the {0} parts: {1}", n, name), () => this.toggle(`fold-${item.key}`), item.open);
	}

	private drawDependencies(panel: HTMLElement, run: ITurboRun, ax: IAxis): void {
		const deps = dependencies(run);
		if (!deps.length) {
			return;
		}
		const doc = mainWindow.document;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'dt-deps');
		svg.setAttribute('aria-hidden', 'true');
		panel.appendChild(svg);
		const rowOf = (n: number) => panel.querySelector<HTMLElement>(`.dt-lane[data-n="${n}"]`) ?? panel.querySelector<HTMLElement>(`.dt-fold[data-parts~="${n}"]`);
		const draw = () => {
			svg.replaceChildren();
			const pr = panel.getBoundingClientRect();
			if (!pr.width || !pr.height) {
				return;
			}
			svg.setAttribute('width', String(pr.width));
			svg.setAttribute('height', String(pr.height));
			const at = (row: HTMLElement, t: number): [number, number] | undefined => {
				const tr = row.querySelector('.dt-track')?.getBoundingClientRect();
				return tr ? [tr.left - pr.left + tr.width * ax.x(t) / 100, tr.top - pr.top + tr.height / 2] : undefined;
			};
			for (const d of deps) {
				const a = rowOf(d.from), b = rowOf(d.to);
				const p1 = a && b && a !== b ? at(a, d.fromAt) : undefined;
				const p2 = a && b && a !== b ? at(b, d.toAt) : undefined;
				if (!p1 || !p2) {
					continue;
				}
				const [x1, y1] = p1, [x2, y2] = p2;
				const down = y2 > y1 ? 1 : -1, dir = x2 >= x1 ? 1 : -1, r = Math.min(4, Math.abs(x2 - x1), Math.abs(y2 - y1) / 2);
				const path = doc.createElementNS(SVG_NS, 'path');
				path.setAttribute('d', `M ${x1.toFixed(1)} ${(y1 + down * 5).toFixed(1)} V ${(y2 - down * r).toFixed(1)} Q ${x1.toFixed(1)} ${y2.toFixed(1)} ${(x1 + dir * r).toFixed(1)} ${y2.toFixed(1)} H ${x2.toFixed(1)}`);
				path.dataset.from = String(d.from);
				path.dataset.to = String(d.to);
				svg.appendChild(path);
				const dot = doc.createElementNS(SVG_NS, 'circle');
				dot.setAttribute('cx', x1.toFixed(1));
				dot.setAttribute('cy', (y1 + down * 5).toFixed(1));
				dot.setAttribute('r', '1.5');
				svg.appendChild(dot);
			}
		};
		const observer = new ResizeObserver(() => draw());
		observer.observe(panel);
		this.renderStore.add(toDisposable(() => observer.disconnect()));
	}

	/** Hovering a part lights the same part in the sessions list (its card is a click away). */
	private hoverLane(row: HTMLElement, run: ITurboRun, p: ITurboPart): void {
		this.renderStore.add(dom.addDisposableListener(row, dom.EventType.MOUSE_ENTER, () => setDispatchTurboHover({ run: run.id, n: p.n })));
		this.renderStore.add(dom.addDisposableListener(row, dom.EventType.MOUSE_LEAVE, () => {
			if (dispatchTurboHooks.hover?.run === run.id && dispatchTurboHooks.hover.n === p.n) {
				setDispatchTurboHover(undefined);
			}
		}));
		if (dispatchTurboHooks.hover?.run === run.id && dispatchTurboHooks.hover.n === p.n) {
			row.classList.add('hl');
		}
	}

	private partWords(run: ITurboRun, p: ITurboPart): string {
		switch (p.status) {
			case 'combined': return localize('dispatchTimeline.combinedAt', "Combined {0} · {1}", ordinal(p.combined_n ?? 0), hm(p.combined_at));
			case 'working': case 'starting': return p.step || localize('dispatchTimeline.working', "Working");
			case 'fixing': return p.step || localize('dispatchTimeline.fixing', "Fitting it to the parts combined before it");
			case 'needs': return localize('dispatchTimeline.needsYou', "Needs you · question above");
			case 'done': return localize('dispatchTimeline.toCombine', "Done · being combined");
			case 'paused': return localize('dispatchTimeline.pausedPart', "Stopped at a clean point");
			case 'failed': return p.failed || localize('dispatchTimeline.failedPart', "Stopped without finishing");
			case 'skipped': return localize('dispatchTimeline.skipped', "Left out");
			case 'cancelled': return localize('dispatchTimeline.cancelledPart', "Stopped");
			default: {
				const f = run.forecast?.parts?.[String(p.n)];
				return p.after?.length && !p.started_at ? localize('dispatchTimeline.waitsFor', "Starts after {0} · about {1}", p.after.join(', '), hm(f?.[0]))
					: localize('dispatchTimeline.upNext', "Up next · about {0}", hm(f?.[0]));
			}
		}
	}

	private renderCombine(rows: HTMLElement, run: ITurboRun, ax: IAxis): void {
		const { label, track, side } = this.row(rows, 'dt-combine');
		const ic = dom.append(label, dom.$('span.dt-n'));
		ic.appendChild(renderIcon(Codicon.gitMerge));
		dom.append(label, dom.$('span.dt-name', undefined, localize('dispatchTimeline.combine', "Combine")));
		for (const p of run.parts) {
			if (p.status === 'combined' && p.combined_at) {
				const c = this.at(track, ax, p.combined_at, dom.$('span.dt-merge', undefined, String(p.combined_n ?? '')));
				c.title = p.name;
			} else {
				const f = run.forecast?.parts?.[String(p.n)];
				if (f && p.status !== 'skipped' && p.status !== 'cancelled') {
					this.at(track, ax, f[1], dom.$('span.dt-merge.todo')).title = p.name;
				}
			}
		}
		for (const f of run.finals) {
			const sp = run.forecast?.finals?.[f.id];
			if (!sp || f.status === 'skipped') {
				continue;
			}
			const box = dom.append(track, dom.$(`span.dt-final.${f.status}`, { title: f.name }));
			box.style.left = `${ax.x(sp[0])}%`;
			box.style.width = `${Math.max(0.8, ax.x(sp[1]) - ax.x(sp[0]))}%`;
		}
		const finals = run.finals.filter(f => f.status !== 'skipped').map(f => f.name.toLowerCase());
		dom.append(side, dom.$('span', undefined, run.state === 'done' ? localize('dispatchTimeline.combinedAll', "All in · {0}", finals.join(', '))
			: localize('dispatchTimeline.combineWords', "{0} of {1} in, then {2}", run.combined, run.total, finals.join(', '))));
	}

	private renderSummary(run: ITurboRun): void {
		const s = run.summary;
		if (!s) {
			return;
		}
		const card = dom.append(this.element, dom.$('.dt-summary'));
		const nums = dom.append(card, dom.$('.dt-nums'));
		const num = (big: string, small: string) => {
			const n = dom.append(nums, dom.$('.dt-num'));
			dom.append(n, dom.$('span.dt-big', undefined, big));
			dom.append(n, dom.$('span.dt-small', undefined, small));
		};
		num(duration(s.minutes), localize('dispatchTimeline.seq', "one part after another: about {0}", duration(s.sequential_minutes)));
		num(partsWords(s.parts), localize('dispatchTimeline.filesN', "{0} files, {1} commits", s.files, s.commits));
		if (typeof s.used_pct === 'number') {
			num(`${Math.round(s.used_pct)}%`, localize('dispatchTimeline.usedPct', "of the allowance, planned {0}%", s.planned_pct ?? 0));
		}
		dom.append(card, dom.$('p.dt-left', undefined, s.left.length ? localize('dispatchTimeline.leftFor', "Left for you: {0}", s.left.join(', ')) : localize('dispatchTimeline.nothingLeft', "Nothing is left for you.")));
		if (run.page) {
			const b = pill(card, localize('dispatchTimeline.openPage', "Open the delivery page"), 'solid');
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this.commandService.executeCommand('dispatch.openDoc', run.page, run.task || undefined).catch(() => this.commandService.executeCommand('vscode.open', URI.file(run.page!)))));
		}
	}

	private async addPart(run: ITurboRun): Promise<void> {
		const text = await this.quickInputService.input({
			prompt: localize('dispatchTimeline.addPrompt', "What else should be done? It becomes one more part."),
			placeHolder: localize('dispatchTimeline.addPh', "Also update the README"),
		});
		if (text?.trim()) {
			await this.act('add', run.id, text.trim());
		}
	}

	private async cancel(run: ITurboRun): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('dispatchTimeline.stopConfirm', "Stop this Turbo run?"),
			detail: localize('dispatchTimeline.stopDetail', "The parts that are working stop now. What was combined so far stays on its own branch, {0}.", run.combine_branch ?? ''),
			primaryButton: localize({ key: 'dispatchTimeline.stopButton', comment: ['&& denotes a mnemonic'] }, "&&Stop the Run"),
		});
		if (confirmed) {
			await this.act('cancel', run.id);
		}
	}

	private async openSession(id: string): Promise<void> {
		const found = findSession(this.management.getSessions(), id);
		if (found) {
			await this.sessionsService.openSession(found.resource);
			return;
		}
		this.notificationService.info(localize('dispatchTimeline.background', "This one works in the background, outside this window's sessions."));
	}

	// ---------------------------------------------------------------- without Turbo: the person's own sessions

	private renderSessions(lanes: readonly ISessionLane[], now: number, run: ITurboRun | null): void {
		const working = lanes.filter(l => l.status === 'working').length;
		const words = sessionsHead(lanes);
		const actions = this.head(turboMark(36, markCells(0, 0), { think: working > 0 }), words.title, words.line);
		if (run) {
			const b = pill(actions, localize('dispatchTimeline.backToRun', "Turbo run"), 'ghost', Codicon.zap);
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => { this.showSessions = false; this.card = undefined; this.render(); }));
		}
		if (!lanes.length) {
			const empty = dom.append(this.element, dom.$('.dt-empty'));
			dom.append(empty, dom.$('p.dt-empty-title', undefined, localize('dispatchTimeline.emptyTitle', "Every session you start shows up here as a lane on one time line.")));
			dom.append(empty, dom.$('p.dt-empty-line', undefined, localize('dispatchTimeline.hint', "For a big job, turn on Turbo under the input box: it is split into parts that run at the same time and come back as one result.")));
			return;
		}
		const [from, to] = lanesSpan(lanes, now);
		const ax = axis(from, to);
		const { lanes: box } = this.lanes(localize('dispatchTimeline.sessions', "Sessions"), [
			['working', localize('dispatchTimeline.lgWorking', "working")],
			['bar', localize('dispatchTimeline.lgWorked', "worked")],
			['helper', localize('dispatchTimeline.lgHelper', "helper")],
		]);
		this.axisRow(box, ax, now);
		const rows = dom.append(box, dom.$('.dt-rows'));
		for (const item of sessionItems(lanes, now, this.open)) {
			this.renderSessionItem(rows, item, ax, now);
		}
		this.overlay(rows, ax, now);
	}

	private renderSessionItem(rows: HTMLElement, item: SessionItem, ax: IAxis, now: number): void {
		if (item.kind === 'group') {
			const { label, side } = this.row(rows, 'dt-group');
			label.appendChild(renderIcon(Codicon.folder));
			dom.append(label, dom.$('span.dt-group-name', undefined, item.project || localize('dispatchTimeline.noProject', "No folder")));
			dom.append(label, dom.$('span.dt-count', undefined, String(item.count)));
			side.remove();
			return;
		}
		if (item.kind === 'fold') {
			const { row, label, track, side } = this.row(rows, 'dt-lane.dt-fold');
			const ic = dom.append(label, dom.$('span.dt-n'));
			ic.appendChild(renderIcon(Codicon.history));
			const name = localize('dispatchTimeline.earlier', "{0} earlier sessions", item.lanes.length);
			dom.append(label, dom.$('span.dt-name', undefined, name));
			label.appendChild(renderIcon(item.open ? Codicon.chevronDown : Codicon.chevronRight)).classList.add('dt-caret');
			for (const l of item.lanes) {
				for (const s of l.segs) {
					this.bar(track, ax, s, '.faint');
				}
			}
			const first = Math.min(...item.lanes.map(l => l.segs[0]?.[0] ?? now));
			dom.append(side, dom.$('span', undefined, localize('dispatchTimeline.foldSessionsSide', "{0} to {1}", hm(first), hm(Math.max(...item.lanes.map(laneEnd))))));
			this.clickLane(row, item.key, item.open ? localize('dispatchTimeline.foldSessionsClose', "Fold the earlier sessions of {0} into one row", item.project) : localize('dispatchTimeline.foldSessionsOpen', "Show {0}", name), () => this.toggle(item.key), item.open);
			return;
		}
		const l = item.lane;
		const helper = item.kind === 'helper';
		const key = `${helper ? 'h' : 's'}-${l.id}`;
		const { row, label, track, side } = this.row(rows, `dt-lane${helper ? '.helper' : ''}.s-${l.status}`);
		row.classList.toggle('in-fold', item.kind === 'session' && item.inFold);
		// colour only for what works now (DESIGN.md「状态圆点」: done and idle show nothing loud): the rest a quiet outline
		label.appendChild(stateBlock(helper ? 'sub-agent' : l.status === 'working' ? 'working' : 'todo', { size: helper ? 12 : 14, breathe: l.status === 'working', title: '' }));
		dom.append(label, dom.$('span.dt-name', undefined, l.name));
		const helpers = item.kind === 'session' ? item.helpers : [];
		if (helpers.length) {
			const open = this.open.has(`h-${l.id}`);
			const chip = dom.append(label, dom.$<HTMLButtonElement>('button.dt-helpers', {
				type: 'button', 'aria-expanded': String(open),
				title: open ? localize('dispatchTimeline.helpersHide', "Fold its helpers back into this lane") : localize('dispatchTimeline.helpersShow', "Show its {0} helpers as lanes", helpers.length),
			}));
			chip.appendChild(stateBlock('sub-agent', { size: 10, title: '' }));
			dom.append(chip, dom.$('span', undefined, String(helpers.length)));
			this.renderStore.add(dom.addDisposableListener(chip, dom.EventType.CLICK, e => { e.stopPropagation(); this.toggle(`h-${l.id}`); }));
		}
		for (const s of l.segs) {
			this.bar(track, ax, s);
		}
		// the helpers folded in: a thin line under the session's bars where they worked
		if (helpers.length && !this.open.has(`h-${l.id}`)) {
			for (const h of helpers) {
				for (const s of h.segs) {
					this.bar(track, ax, s, '.helper');
				}
			}
		}
		if (l.status === 'working') {
			this.at(track, ax, now, this.dot('working'));
			side.appendChild(this.dot('working'));
			dom.append(side, dom.$('span.dt-side-now', undefined, l.step || localize('dispatchTimeline.workingNow', "Working now")));
		} else {
			dom.append(side, dom.$('span', undefined, localize('dispatchTimeline.lastAt', "Last at {0}", hm(laneEnd(l)))));
		}
		this.cardLane(row, key, l.name);
		if (this.card === key) {
			this.sessionCard(l, helpers, item.kind === 'helper' ? item.parent : undefined);
		}
	}

	/** A session's card: its name, project, agent and time, what it does, its helpers; Open session. */
	private sessionCard(l: ISessionLane, helpers: readonly ISessionLane[], parent: ISessionLane | undefined): void {
		const working = l.status === 'working';
		const pop = this.makeCard(l.name, stateBlock(parent ? 'sub-agent' : working ? 'working' : 'todo', { size: 14, breathe: working, title: '' }));
		const meta = [parent ? localize('dispatchTimeline.helperOf', "Helper of {0}", parent.name) : l.project, l.engine_name || l.engine].filter(Boolean).join(' · ');
		if (meta) {
			this.cardLine(pop, meta, 'meta');
		}
		const first = l.segs[0]?.[0] ?? l.first;
		this.cardLine(pop, `${span(first, laneEnd(l), working)} · ${localize('dispatchTimeline.workedFor', "worked {0}", duration(worked(l.segs)))}`, 'time');
		if (working) {
			const now2 = this.cardLine(pop, '', 'now');
			now2.appendChild(this.dot('working'));
			dom.append(now2, dom.$('span', undefined, l.step || localize('dispatchTimeline.workingNow', "Working now")));
		}
		if (helpers.length) {
			dom.append(pop, dom.$('p.dt-pop-sub', undefined, helpers.length === 1 ? localize('dispatchTimeline.oneHelper', "1 helper") : localize('dispatchTimeline.nHelpers', "{0} helpers", helpers.length)));
			const list = dom.append(pop, dom.$('ul.dt-pop-list'));
			for (const h of helpers.slice(0, 6)) {
				const li = dom.append(list, dom.$('li'));
				li.appendChild(stateBlock('sub-agent', { size: 10, breathe: h.status === 'working', title: '' }));
				dom.append(li, dom.$('span.dt-pop-item', undefined, h.name));
				dom.append(li, dom.$('span.dt-pop-time', undefined, h.status === 'working' ? localize('dispatchTimeline.nowWord', "now") : hm(laneEnd(h))));
			}
			if (helpers.length > 6) {
				dom.append(list, dom.$('li.dt-pop-more', undefined, localize('dispatchTimeline.moreHelpers', "{0} more", helpers.length - 6)));
			}
		}
		const id = parent ? parent.id : l.id;
		if (l.kind !== 'helper' || parent) {
			this.cardButton(pop, parent ? localize('dispatchTimeline.openItsSession', "Open its session") : localize('dispatchTimeline.openSession', "Open session"), () => void this.openSession(id));
		}
	}
}
