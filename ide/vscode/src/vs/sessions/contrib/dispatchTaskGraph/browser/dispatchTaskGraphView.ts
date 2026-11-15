/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Task graph page (patches/430-tasks.patch; kanban design/task-graph/redesign/,
 *  direction A「泳道脉络」, and design/task-model/DECISIONS.md「Task graph」).
 *
 *  `dispatch task graph --folder | --project … [--session …] --days 30 --json` through dispatch-bridge:
 *  a project's tasks of the last 30 days, each in a thing (kanban app/cli/things.py). One row per thing
 *  on a day axis (dispatchDayAxis.ts: every day a slot side by side; the day the focus is on open by the hour, the
 *  rest folded; the chart column is a window the axis slides sideways in). dispatchTaskGraphLayout.ts says where
 *  everything goes at a focus, this file draws it and wires it:
 *
 *   - sliding: a trackpad's sideways swipe, Shift and the wheel, a drag in the chart, a click on a day in the head or
 *     the arrow keys move the focus (task-e1qsa, 「任务图左右滑动」); the page follows the input frame by frame, every
 *     element moved by its key (no drawing again), and when the input stops it glides to the nearest day. Opens on
 *     today. Reduced motion jumps;
 *   - the head: one line of data as the page's description, "‹ session" when the page came up over a
 *     session (Esc and the title bar's ← do the same), This session | project (the Tasks tab's square
 *     switch) and the legend on one line (marks, and what a line between rows means);
 *   - rows: the thing's name and count, its line with a mark per hour / half day / day, and on the
 *     right where it stands now (a click opens that task);
 *   - one task shows in up to three places: its mark, its row in a mark's card, the right-hand line
 *     when it is where its thing stands (kanban DESIGN.md「联动悬停」). Pointing at one lights the
 *     others (the row, its line and end, a ring on the mark; no colour) and shows the task's details
 *     in the nearest free space: the card on a mark after 250 ms; for a row of a mark's card, over
 *     the right-hand column; for the right-hand line, in today's stretch left of Now. Pointing away
 *     puts everything back; a click opens the task page (whose "‹ Task graph" and Esc come back here,
 *     scrolled as it was);
 *   - things with nothing asked in 7 days fold under "No activity in 7 days" (the fold is remembered);
 *   - loading draws skeleton rows (after 120 ms), empty says why with one way on.
 *
 *  Task ids never show: a task-xxxx in a title reads as that task's title (dispatchTaskLinks.ts).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTaskGraph.css';
import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IHoverWidget } from '../../../../base/browser/ui/hover/hover.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { renderTaskDetail } from '../../dispatchTasks/browser/dispatchHoverDetails.js';
import { IDispatchPlanItem, statusMark } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { setupDispatchRowDetail, setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { DISPATCH_CUSTOM_VIEW_BACK_COMMAND, dispatchCustomViewOrigin } from '../../sessions/browser/dispatchCustomViewBack.js';
import {
	activeProjectLabel, activeSessionFolder, agentName, askTasks, DELIVERABLE_ICON, deliverableLabel, DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, DISPATCH_OPEN_TASK_COMMAND,
	dispatchGraphProject, dispatchGraphScope, IDispatchDeliverable, IDispatchTaskProject, isChatSession, renderBackCrumb, sessionIdOf, shownStatus, TASK_WINDOW_DAYS
} from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { bucketWords, DayFocus, focusDay, hourMinute, IDayAxis, IDaySlot, IDayTick, IDayTitle, monthDay, nearestCenter } from './dispatchDayAxis.js';
import { FOLD_GAP, FOLD_H, GraphStatus, graphCounts, IGraphData, IGraphEnd, IGraphLayout, IGraphLine, IGraphMark, IGraphNode, IGraphPath, IGraphRow, IGraphThing, layoutTaskGraph, planSwitch, ROW_H } from './dispatchTaskGraphLayout.js';

const $ = DOM.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const DISPATCH_TASK_GRAPH_VIEW_ID = 'dispatch.taskGraph';

/** A task as `dispatch task graph --json` gives it. */
export interface ITaskGraphNode extends IGraphNode {
	readonly session: string;
	readonly session_title?: string;
	readonly agent: string;
	readonly deliverables: readonly IDispatchDeliverable[];
	readonly done_at: number | null;
	readonly plan?: readonly IDispatchPlanItem[];
	readonly last?: { readonly at: number; readonly text: string } | null;
	readonly plan_done?: number;
	readonly plan_total?: number;
	/** The step the plan is at: the one being done, else the next to do, else the last. */
	readonly plan_now?: { readonly n: number; readonly text: string } | null;
}

export interface ITaskGraphData extends IGraphData<ITaskGraphNode> {
	readonly things?: readonly (IGraphThing & { readonly n?: number })[];
	readonly error?: string;
}

/** What `render` draws with: the page's own measure (the prototype's 1152 px column: 160 / 656 / 240). */
const MAX_WIDTH = 1108;
const PAD = 10;          // the host's content padding
const GAP = 16;
const HOVER_DELAY = 250;
const SKELETON_AFTER = 120;
const DETAIL_W = 320;
/** The card on a mark, about as wide as it shows (340 and the hover's padding). */
const CARD_W = 360;
const FOLD_KEY = 'dispatch.taskGraph.quietOpen';
/** The scope the person picked last in a project (This session or the whole project), per project. */
const SCOPE_KEY = (project: string) => `dispatch.taskGraph.scope.${project}`;
/** The fold head's key among the rows that slide. */
const FOLD_ROW = '\u0000fold';

/** The fold "Not in this session" (not remembered) and where the page was scrolled (for coming back from a task). */
const sessionFoldOpen = observableValue<boolean>('dispatchTaskGraph.sessionFold', false);
let lastScroll: { readonly key: string; readonly top: number } | undefined;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		el.setAttribute(k, String(v));
	}
	parent?.appendChild(el);
	return el;
}

/** The clipped box round the drawing is this much taller than the rows, top and bottom. */
const PLOT_BLEED = 8;

const n1 = (n: number) => Math.round(n * 10) / 10;

/** One thing on the page that a sliding axis keeps and moves, found again by its key from frame to frame. */
interface IPlotEl<T, E extends Element = Element> {
	readonly el: E;
	v: T;
	stamp: number;
	/** What each of its parts was last written as: the frame writes only what changed. */
	readonly last: Record<string, string>;
	hit?: HTMLButtonElement;
}

function grow<K, T, E extends Element>(map: Map<K, IPlotEl<T, E>>, key: K, v: T, stamp: number, make: () => E): IPlotEl<T, E> {
	let it = map.get(key);
	if (!it) {
		it = { el: make(), v, stamp, last: {} };
		map.set(key, it);
	}
	it.v = v;
	it.stamp = stamp;
	return it;
}

/** Whatever this frame did not mention is gone. */
function sweep<K, T, E extends Element>(map: Map<K, IPlotEl<T, E>>, stamp: number, gone?: (it: IPlotEl<T, E>) => void): void {
	for (const [k, it] of map) {
		if (it.stamp !== stamp) {
			gone?.(it);
			it.el.remove();
			map.delete(k);
		}
	}
}

function put(it: IPlotEl<unknown, Element>, part: string, sig: string, write: () => void): void {
	if (it.last[part] !== sig) {
		it.last[part] = sig;
		write();
	}
}

/** The axis head's elements, by key. */
interface IAxisEls {
	readonly track: HTMLElement;
	readonly cells: Map<number, IPlotEl<IDaySlot, HTMLElement>>;
	readonly titles: Map<string, IPlotEl<IDayTitle, HTMLElement>>;
	readonly ticks: Map<string, IPlotEl<IDayTick, HTMLElement>>;
	stamp: number;
	/** A click on a day cell (the day's local midnight). */
	onDay: ((day: number) => void) | undefined;
}

interface IColumns {
	readonly name: number;
	readonly now: number;
	readonly chart: number;
}

function columns(width: number): IColumns {
	const inner = Math.max(0, width - 2 * PAD);
	const name = inner >= 900 ? 160 : inner >= 700 ? 140 : 120;
	// the right-hand column holds a task's title in one line: as wide as the page gives it (the chart slides, so it
	// does not need the room)
	const now = inner >= 1000 ? 360 : inner >= 800 ? 280 : inner >= 700 ? 200 : 0;
	const chart = Math.max(200, inner - name - now - GAP * (now ? 2 : 1));
	return { name, now, chart };
}

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

/** "today, 17:38", "yesterday, 9:05", "Sep 12, 14:02" (the cards' times). */
function whenShort(t: number | null | undefined, now: number): string {
	if (!t) {
		return '';
	}
	const d = new Date(now * 1000);
	d.setHours(0, 0, 0, 0);
	const today = d.getTime() / 1000;
	if (t >= today) {
		return localize('dispatchTaskGraph.today', "today, {0}", hourMinute(t));
	}
	if (t >= today - 86400) {
		return localize('dispatchTaskGraph.yesterday', "yesterday, {0}", hourMinute(t));
	}
	return `${monthDay(t)}, ${hourMinute(t)}`;
}

/** A small glyph for the legend's lines: a right angle down to a new thing's row (dashed when worked out from
 *  the session's order), or up, back to an older thing's. */
function lineGlyph(kind: 'branch' | 'merge' | 'inferred'): SVGSVGElement {
	const s = svg('svg', { class: 'dispatch-tg-line-glyph', width: 14, height: 12, viewBox: '0 0 14 12', 'aria-hidden': 'true' });
	svg('path', { d: kind === 'merge' ? 'M2 11V5Q2 1 6 1H13' : 'M2 1V7Q2 11 6 11H13', class: kind === 'inferred' ? 'dashed' : '' }, s);
	return s;
}

/** The page's hover links (kanban DESIGN.md「联动悬停」): what lights together, and where details go. */
interface IGraphHover {
	row(row: number, on: boolean): void;
	/** A ring on a mark; counted, so two places that ask for the same ring do not take each other's away. */
	ring(mark: IGraphMark<ITaskGraphNode> | undefined, on: boolean): void;
	markOf(taskId: string): IGraphMark<ITaskGraphNode> | undefined;
	/** The task details beside the graph, shown for `by` (a mark's card, a right-hand line); hiding them takes
	 *  the same `by`, so a card closing late does not take away the details the pointer has moved on to. */
	detail(by: object, n: ITaskGraphNode | undefined, place?: 'today' | 'column', row?: number): void;
}

/** A row as drawn (or the fold head): its element, its groups in the drawing (line, marks, end), its slot. */
interface IDrawnRow {
	readonly el: HTMLElement;
	readonly y: number;
	readonly gs: readonly SVGGElement[];
	/** The space over it that belongs to it (the fold head's gap), and its own height. */
	readonly lead: number;
	readonly h: number;
}

/** The drawing's layers, bottom to top (the focus rings above them). */
interface ILayers {
	readonly lines: SVGGElement;
	readonly links: SVGGElement;
	readonly marks: SVGGElement;
	readonly ends: SVGGElement;
}

/** Under the rows: the focus day's band and the line that marks Now. */
interface IBackdrop {
	/** The day the focus is on: a band behind its rows (two while one day gives way to the next). */
	readonly bands: SVGGElement;
	readonly rules: readonly SVGLineElement[];
}

export class DispatchTaskGraphView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchTaskGraph.title', "Task graph"));
	override readonly maxWidth = MAX_WIDTH;

	private readonly data = observableValue<ITaskGraphData | undefined>(this, undefined);
	/** The page's one line of data under its title: how many tasks in how many things, how many wait. */
	override readonly description: IObservable<string | undefined> = derived(this, reader => {
		const data = this.data.read(reader);
		const scope = dispatchGraphScope.read(reader);
		if (!data) {
			return localize('dispatchTaskGraph.loading', "Loading tasks…");
		}
		// nothing to count: the empty state under it says so once (no "Nothing from this session yet." above "No tasks in this session yet.")
		return data.error ? undefined : this.summary(data, scope);
	});
	private readonly width = observableValue<number>(this, MAX_WIDTH);
	private readonly quietOpen = observableValue<boolean>(this, false);
	private requestId = 0;
	/** Where the axis was left (0 the first day open to 1 today open), kept while the page is drawn again. */
	private axisFocus = 1;
	private lastRequest = '';
	private lastProject: string | undefined;
	private container: HTMLElement | undefined;
	private scrollKey = '';
	/** What the last drawing showed: the rows slide from there when only the scope or the fold changes. */
	private drawn: { readonly data: ITaskGraphData; readonly scope: string; readonly fold: boolean; readonly rows: Map<string, IDrawnRow> } | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@IHoverService private readonly hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.quietOpen.set(this.storageService.getBoolean(FOLD_KEY, StorageScope.PROFILE, false), undefined);
	}

	render(container: HTMLElement): void {
		this.container = container;
		container.classList.add('dispatch-graph-page');
		const backRow = DOM.append(container, $('.dispatch-graph-back'));
		const bar = DOM.append(container, $('.dispatch-tg-bar'));
		const body = DOM.append(container, $('.dispatch-tg-body'));
		const store = this._register(new DisposableStore());

		// "‹ session": back to the session the graph was opened over (Esc and the title bar's ← do the same)
		const backStore = this._register(new DisposableStore());
		this._register(autorun(reader => {
			const from = dispatchCustomViewOrigin.read(reader);
			backStore.clear();
			DOM.clearNode(backRow);
			if (from) {
				// a session without a title yet is the new-session page
				renderBackCrumb(backRow, from.title || localize('dispatchTaskGraph.newSession', "New session"), () => void this.commandService.executeCommand(DISPATCH_CUSTOM_VIEW_BACK_COMMAND), backStore);
			}
		}));

		this._register(autorun(reader => {
			const scope = dispatchGraphScope.read(reader);
			const chosen = dispatchGraphProject.read(reader);
			const session = this.sessionsService.activeSession.read(reader);
			session?.workspace.read(reader);
			void this.load(scope, chosen);
		}));
		// the sessions with an agent at work now, among those the tasks came from (the ping moves when this
		// set changes, not on every status change)
		const liveKey = derived(this, reader => {
			const data = this.data.read(reader);
			const live: string[] = [];
			if (data?.nodes?.length) {
				const asked = new Set(data.nodes.map(n => n.session).filter(Boolean));
				for (const s of this.management.getSessions()) {
					const id = sessionIdOf(s.resource);
					if (asked.has(id) && s.status.read(reader) === SessionStatus.InProgress) {
						live.push(id);
					}
				}
			}
			return live.sort().join('\n');
		});
		// A session without a project folder (Chats) has no project around it: This session only, unless the person
		// picked a project's graph from the sidebar (task-p0za2: a chat's graph opened on the whole kanban project)
		this._register(autorun(reader => {
			const session = this.sessionsService.activeSession.read(reader);
			session?.isQuickChat?.read(reader);
			session?.workspace.read(reader);
			const scope = dispatchGraphScope.read(reader);
			if (scope !== 'session' && !dispatchGraphProject.read(reader) && isChatSession(session)) {
				queueMicrotask(() => { if (dispatchGraphScope.get() === scope && !dispatchGraphProject.get()) { this.setScope('session'); } });
			}
		}));
		// Which scope the page shows: the one the person picked last in this project; else This session when the
		// session has tasks and the project's swimlanes when it has none (a new session would otherwise open on one
		// empty line, and the graph was never seen)
		this._register(autorun(reader => {
			const data = this.data.read(reader);
			const scope = dispatchGraphScope.read(reader);
			if (!data || data.error || !data.project || dispatchGraphProject.read(reader)) { return; }
			const picked = this.storageService.get(SCOPE_KEY(data.project), StorageScope.PROFILE);
			const want = picked === 'project' || picked === 'session' ? picked : data.nodes?.some(n => n.mine) ? 'session' : 'project';
			if (want !== scope) { queueMicrotask(() => { if (dispatchGraphScope.get() === scope) { this.setScope(want); } }); }
		}));
		this._register(autorun(reader => {
			const data = this.data.read(reader);
			const scope = dispatchGraphScope.read(reader);
			const width = this.width.read(reader);
			const foldOpen = scope === 'session' ? sessionFoldOpen.read(reader) : this.quietOpen.read(reader);
			const key = liveKey.read(reader);
			const live = new Set(key ? key.split('\n') : []);
			store.clear();
			this.renderBar(bar, scope, data, store);
			this.renderBody(body, data, scope, width, foldOpen, live, store);
		}));
		// where the page was scrolled, for coming back from a task page
		this._register(toDisposable(() => {
			const scroller = container.closest('.custom-view-scroll-content');
			if (scroller && this.scrollKey) {
				lastScroll = { key: this.scrollKey, top: scroller.scrollTop };
			}
		}));
	}

	private async load(scope: 'project' | 'session', chosen: IDispatchTaskProject | undefined): Promise<void> {
		const id = ++this.requestId;
		const session = this.sessionsService.activeSession.get();
		const folder = activeSessionFolder(this.sessionsService);
		// the last 30 days (older tasks are the project's Archive). The answer is always the whole project with
		// the active session's own tasks marked, so This session and the project draw from one answer (the
		// switch then only moves rows); the folder names the project when the session asked nothing yet.
		const req: Record<string, unknown> = { op: 'graph' };
		if (scope === 'project' && chosen) {
			req.project = chosen.name;
		} else if (folder && !this.chat()) {
			req.folder = folder;
		}
		if (session) {
			req.session = session.resource.toString();
		}
		req.days = TASK_WINDOW_DAYS;
		if (scope === 'session' || (this.chat() && !req.project) ? !session : !req.project && !req.folder) {
			this.lastRequest = '';
			this.data.set({ error: localize('dispatchTaskGraph.noSession', "Open a session in a project folder to see its task graph.") }, undefined);
			return;
		}
		const key = JSON.stringify(req);
		const have = this.data.get();
		if (key === this.lastRequest && have && !have.error) {
			return;
		}
		this.lastRequest = key;
		this.axisFocus = 1;
		this.data.set(undefined, undefined);
		const ans = await askTasks<ITaskGraphData>(this.commandService, req);
		if (id === this.requestId) {
			this.data.set(ans, undefined);
		}
	}

	/** The active session works without a project folder and no project was picked: This session is all there is. */
	private chat(): boolean {
		return !dispatchGraphProject.get() && isChatSession(this.sessionsService.activeSession.get());
	}

	private projectLabel(data: ITaskGraphData | undefined): string {
		// while the first answer is on its way: the project it asked about last, else the session's folder
		const folder = activeSessionFolder(this.sessionsService)?.split('/').filter(Boolean).pop();
		const label = dispatchGraphProject.get()?.label || activeProjectLabel(this.sessionsService) || data?.project || this.lastProject || folder;
		if (data?.project) {
			this.lastProject = data.project;
		}
		return label || localize('dispatchTaskGraph.project', "Project");
	}

	private renderBar(bar: HTMLElement, scope: 'project' | 'session', data: ITaskGraphData | undefined, store: DisposableStore): void {
		DOM.clearNode(bar);
		// the same order and shape as the Tasks tab's switch
		const seg = DOM.append(bar, $('.dispatch-tg-seg', { role: 'tablist' }));
		const scopes: ['project' | 'session', string][] = [
			['session', localize('dispatchTaskGraph.thisSession', "This session")],
		];
		if (!this.chat()) {
			scopes.push(['project', this.projectLabel(data)]);
		}
		for (const [s, label] of scopes) {
			const btn = DOM.append(seg, $('button.dispatch-tg-seg-btn', { type: 'button', role: 'tab' }));
			btn.classList.toggle('on', s === scope);
			btn.setAttribute('aria-selected', String(s === scope));
			btn.textContent = label;
			store.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => {
				// remembered per project: the page opens on it next time
				if (data?.project) { this.storageService.store(SCOPE_KEY(data.project), s, StorageScope.PROFILE, StorageTarget.USER); }
				this.setScope(s);
			}));
		}
		const hasRows = !!data && !data.error && !!data.nodes?.length && (scope === 'project' || data.nodes.some(n => n.mine));
		if (!data || hasRows) {
			const legend = DOM.append(bar, $('.dispatch-tg-legend'));
			const item = (parent: HTMLElement, glyph: Element, label: string, title?: string) => {
				const it = DOM.append(parent, $('span.dispatch-tg-legend-item'));
				it.appendChild(glyph);
				DOM.append(it, $('span', undefined, label));
				if (title) {
					it.title = title;
				}
			};
			item(legend, $('span.dispatch-tg-glyph.open'), localize('dispatchTaskGraph.notDone', "Not done"));
			item(legend, $('span.dispatch-tg-glyph.done'), localize('dispatchTaskGraph.done', "Done"));
			item(legend, $('span.dispatch-tg-glyph.in_progress'), localize('dispatchTaskGraph.inProgress', "In progress"));
			item(legend, $('span.dispatch-tg-glyph.waiting'), localize('dispatchTaskGraph.waiting', "Waiting for you"));
			if (scope === 'project') {
				// what a line between two rows means: a new thing started from a task of the one above; a session
				// went back to an older thing (shown while its row is under the pointer); worked out, not written down
				const lines = DOM.append(legend, $('span.dispatch-tg-legend-lines'));
				item(lines, lineGlyph('branch'), localize('dispatchTaskGraph.legendBranch', "Branched off"),
					localize('dispatchTaskGraph.legendBranchTip', "A new thing: asked while the session was on the task this line comes down from."));
				item(lines, lineGlyph('merge'), localize('dispatchTaskGraph.legendMerge', "Back to an older thing"),
					localize('dispatchTaskGraph.legendMergeTip', "A session went back to an older thing after working on another. Point at a row to see these lines."));
				item(lines, lineGlyph('inferred'), localize('dispatchTaskGraph.legendInferred', "From session order"),
					localize('dispatchTaskGraph.legendInferredTip', "Dashed: worked out from the order of the session's tasks, not written down by the agent."));
			}
		}
	}

	private setScope(s: 'project' | 'session'): void {
		if (s === 'session') {
			// This session is the active one's, in its own project
			dispatchGraphProject.set(undefined, undefined);
		}
		dispatchGraphScope.set(s, undefined);
	}

	private renderBody(body: HTMLElement, data: ITaskGraphData | undefined, scope: 'project' | 'session', width: number, foldOpen: boolean, live: ReadonlySet<string>, store: DisposableStore): void {
		DOM.clearNode(body);
		this.container?.removeAttribute('data-render-ms');
		if (!data) {
			this.renderSkeleton(body, width, store);
			return;
		}
		if (data.error) {
			DOM.append(body, $('.dispatch-tg-error', undefined, data.error));
			return;
		}
		const started = performance.now();
		const now = Date.now() / 1000;
		const cols = columns(width);
		const relayout = (focus: number) => layoutTaskGraph<ITaskGraphNode>({
			data, scope, width: cols.chart, now, foldOpen, live, focus,
			statusOf: n => this.statusOf(n),
		});
		const layout = relayout(this.axisFocus);
		// the same answer drawn again for another scope or with the fold opened: the rows slide from where they were
		const before = this.drawn && this.drawn.data === data && (this.drawn.scope !== scope || this.drawn.fold !== foldOpen) ? this.drawn.rows : undefined;
		this.drawn = undefined;
		if (layout.empty) {
			this.renderEmpty(body, layout.empty, data, store);
			return;
		}
		const rows = this.renderGraph(body, layout, relayout, cols, scope, store, before);
		this.drawn = { data, scope, fold: foldOpen, rows };
		store.add(linkifyDispatchTasksWith(this.commandService, body));
		const ms = Math.round((performance.now() - started) * 10) / 10;
		// read by the end-to-end check (how long drawing a project takes)
		this.container?.setAttribute('data-render-ms', String(ms));
		this.container?.setAttribute('data-rows', String(layout.rows.length));
		this.restoreScroll(scope, data);
	}

	private summary(data: ITaskGraphData, scope: 'project' | 'session'): string | undefined {
		const { tasks, things, waiting, empty } = graphCounts(data, scope, n => this.statusOf(n));
		const days = data.days || TASK_WINDOW_DAYS;
		if (empty) {
			return undefined;
		}
		const head = scope === 'session'
			? localize('dispatchTaskGraph.sumSession', "{0} {1} from this session, in {2} {3}.", tasks, plural(tasks, localize('dispatchTaskGraph.task', "task"), localize('dispatchTaskGraph.tasks', "tasks")),
				things, plural(things, localize('dispatchTaskGraph.thing', "thing"), localize('dispatchTaskGraph.things', "things")))
			: localize('dispatchTaskGraph.sumProject', "{0} {1} in {2} {3} over the last {4} days.", tasks, plural(tasks, localize('dispatchTaskGraph.task', "task"), localize('dispatchTaskGraph.tasks', "tasks")),
				things, plural(things, localize('dispatchTaskGraph.thing', "thing"), localize('dispatchTaskGraph.things', "things")), days);
		return waiting
			? `${head} ${waiting === 1 ? localize('dispatchTaskGraph.oneWaiting', "1 is waiting for you.") : localize('dispatchTaskGraph.nWaiting', "{0} are waiting for you.", waiting)}`
			: head;
	}

	// ---- the graph ------------------------------------------------------------------------------

	private renderGraph(body: HTMLElement, layout: IGraphLayout<ITaskGraphNode>, relayout: (g: number) => IGraphLayout<ITaskGraphNode>, cols: IColumns, scope: 'project' | 'session', store: DisposableStore,
		before?: ReadonlyMap<string, IDrawnRow>): Map<string, IDrawnRow> {
		const W = cols.chart;
		const win = DOM.getWindow(body);
		const graph = DOM.append(body, $('.dispatch-tg'));
		graph.classList.toggle('session', scope === 'session');
		graph.style.setProperty('--tg-name', `${cols.name}px`);
		graph.style.setProperty('--tg-now', `${cols.now}px`);
		graph.classList.toggle('no-now', !cols.now);

		const axisEls = this.renderAxis(graph, cols, store);

		const lanes = DOM.append(graph, $('.dispatch-tg-lanes'));
		lanes.style.height = `${layout.height}px`;
		const H = layout.height;
		// the chart column is a window on the axis, which slides sideways in it: a clipped box PLOT_BLEED taller than
		// the rows each way (rings, pings and the focus day's band run past them), the drawing in it moved as one
		const viewBox = `0 -${PLOT_BLEED} ${W} ${H + 2 * PLOT_BLEED}`;
		const mkSvg = (plot: HTMLElement) => svg('svg', { class: 'dispatch-tg-svg', width: W, height: H + 2 * PLOT_BLEED, viewBox, 'aria-hidden': 'true' }, plot);

		// the day the focus is on gets a band behind its rows (under them, so the row pointed at stays lit all the way across)
		const back = DOM.append(lanes, $('.dispatch-tg-plot.back'));
		back.style.width = `${W}px`;
		back.style.height = `${H + 2 * PLOT_BLEED}px`;
		const gBack = svg('g', {}, mkSvg(back));
		const backdrop: IBackdrop = {
			bands: svg('g', { class: 'bands' }, gBack),
			rules: [svg('line', { class: 'nowl', x1: 0, x2: 0, y1: -4, y2: H + 4 }, gBack)],
		};
		const bandEls = new Map<number, SVGRectElement>();

		const rowEls: HTMLElement[] = [];
		const nowEls: HTMLElement[] = [];
		for (const row of layout.rows) {
			const el = this.renderRow(lanes, row, store);
			rowEls[row.index] = el;
			nowEls[row.index] = el.querySelector<HTMLElement>('.dispatch-tg-now')!;
		}
		const foldEl = layout.fold ? this.renderFold(lanes, layout, store) : undefined;

		// the drawing: over the chart column of the rows. Each row's line, marks and end are a group of their own
		// in their layer, so they can move with the row's name
		const plot = DOM.append(lanes, $('.dispatch-tg-plot'));
		plot.style.width = `${W}px`;
		plot.style.height = `${H + 2 * PLOT_BLEED}px`;
		const gPan = svg('g', {}, mkSvg(plot));
		const layers: ILayers = { lines: svg('g', {}, gPan), links: svg('g', { class: 'links' }, gPan), marks: svg('g', {}, gPan), ends: svg('g', {}, gPan) };
		const rowGs = layout.rows.map(r => [
			svg('g', { 'data-thing': r.thing.id }, layers.lines), svg('g', { 'data-thing': r.thing.id }, layers.marks), svg('g', { 'data-thing': r.thing.id }, layers.ends),
		] as const);

		// what is drawn, by key: a sliding axis moves these elements frame by frame, it never draws them again
		const lineEls = new Map<string, IPlotEl<IGraphLine>>();
		const linkEls = new Map<string, IPlotEl<IGraphPath>>();
		const markEls = new Map<string, IPlotEl<IGraphMark<ITaskGraphNode>>>();
		const endEls = new Map<number, IPlotEl<IGraphEnd>>();
		const markOfTask = new Map<string, IGraphMark<ITaskGraphNode>>();
		// focus rings go on top: the mark pointed at (or its task, from anywhere on the page)
		const gFocus = svg('g', { class: 'focus' }, gPan);
		const rings = new Map<string, SVGElement>();
		const ringCount = new Map<string, number>();
		// the marks' hover targets, moved with the drawing
		const hits = DOM.append(plot, $('.dispatch-tg-hits'));
		const cardTimer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
		store.add(toDisposable(() => clearTimeout(cardTimer.id)));
		let cur = layout;

		// the task details that come up in a free spot (a row of a mark's card; the right-hand line): the card's look
		const detail = DOM.append(lanes, $('.dispatch-tg-detail'));
		detail.setAttribute('aria-hidden', 'true');
		const detailStore = store.add(new DisposableStore());
		let detailBy: object | undefined;

		const hover: IGraphHover = {
			row: (row, on) => {
				rowEls[row]?.classList.toggle('hot', on);
				nowEls[row]?.classList.toggle('lit', on);
				endEls.get(row)?.el.lastElementChild?.classList.toggle('hot', on);
				for (const l of lineEls.values()) {
					if (l.v.row === row) {
						l.el.classList.toggle('hot', on);
					}
				}
				for (const l of linkEls.values()) {
					if (l.v.kind !== 'route' && l.v.rows.includes(row)) {
						l.el.classList.toggle('hot', on);
					}
				}
			},
			ring: (m, on) => {
				if (!m) {
					return;
				}
				const n = Math.max(0, (ringCount.get(m.key) ?? 0) + (on ? 1 : -1));
				ringCount.set(m.key, n);
				if (n && !rings.has(m.key)) {
					const at = markEls.get(m.key)?.v ?? m;
					rings.set(m.key, svg('circle', { class: 'ring', cx: at.x, cy: at.y, r: at.r + 3.5 }, gFocus));
				} else if (!n) {
					rings.get(m.key)?.remove();
					rings.delete(m.key);
				}
			},
			markOf: id => markOfTask.get(id),
			detail: (by, n, place, row) => {
				if (!n || row === undefined || !place) {
					// only whoever showed them takes them away
					if (by === detailBy) {
						detail.classList.remove('show');
						detailBy = undefined;
					}
					return;
				}
				detailBy = by;
				const r = layout.rows[row];
				const column = place === 'column' && !!cols.now;
				detailStore.clear();
				detail.classList.remove('show');
				detail.classList.add('measure');
				detail.classList.toggle('column', column);
				const width = column ? cols.now : DETAIL_W;
				const chartLeft = cols.name + GAP;
				detail.style.width = `${width}px`;
				detail.style.height = '';
				// the right-hand column: in place of the row's line, from its left edge (clear of Now and the ends);
				// the chart: its right edge 8 px left of Now
				detail.style.left = `${Math.max(0, column ? chartLeft + W + GAP : chartLeft + W - 8 - width)}px`;
				detail.style.top = '0px';
				this.fillDetail(detail, n, layout.axis.now);
				let h = detail.offsetHeight;
				let top: number;
				if (column) {
					// whole rows, from the row's top down (up from its bottom when there is no room), so no row
					// shows half its words under it
					h = Math.ceil((h - 0.5) / ROW_H) * ROW_H;
					detail.style.height = `${h}px`;
					top = r.y + h <= layout.height ? r.y : Math.max(0, r.y + ROW_H - h);
				} else {
					// under the row (over it when there is no room below): the row, its end and the ring on the
					// task's mark stay in sight
					const below = r.y + ROW_H + 4;
					top = below + h <= layout.height ? below : Math.max(0, r.y - 4 - h);
				}
				detail.style.top = `${top}px`;
				detail.classList.remove('measure');
				detailStore.add(linkifyDispatchTasksWith(this.commandService, detail));
				detail.classList.add('show');
			},
		};

		// ---- one frame: everything that depends on the focus, moved to where it goes ----
		let stamp = 0;
		const apply = (l: IGraphLayout<ITaskGraphNode>) => {
			cur = l;
			stamp++;
			const ax = l.axis;
			const fd = focusDay(ax);
			gPan.setAttribute('transform', `translate(${-n1(ax.pan)} 0)`);
			gBack.setAttribute('transform', `translate(${-n1(ax.pan)} 0)`);
			hits.style.transform = `translateX(${-n1(ax.pan)}px)`;
			graph.dataset.focus = String(fd.start);
			graph.dataset.g = String(Math.round(ax.g * 1e4) / 1e4);
			graph.dataset.pan = String(Math.round(ax.pan));
			// the edges fade where there is more to slide to, by how much more
			graph.style.setProperty('--tg-fl', `${Math.round(Math.min(20, ax.pan))}px`);
			graph.style.setProperty('--tg-fr', `${Math.round(Math.min(20, Math.max(0, ax.room - ax.pan)))}px`);
			// what sits on the focus day's band takes its colour for the ring round a mark and the inside of an open one
			const inBand = (px: number) => fd.e >= 0.5 && px >= fd.x0 - 0.5 && px <= fd.x1 + 0.5;
			for (const d of ax.days) {
				let r = bandEls.get(d.start);
				if (d.e <= 0.003) {
					if (r) {
						r.remove();
						bandEls.delete(d.start);
					}
					continue;
				}
				if (!r) {
					r = svg('rect', { class: 'band', y: -4, height: H + 8, rx: 6 }, backdrop.bands);
					bandEls.set(d.start, r);
				}
				r.setAttribute('x', String(n1(d.x0)));
				r.setAttribute('width', String(n1(d.x1 - d.x0)));
				r.style.opacity = String(Math.round(d.e * 100) / 100);
			}
			backdrop.rules[0].setAttribute('x1', String(n1(ax.width)));
			backdrop.rules[0].setAttribute('x2', String(n1(ax.width)));
			for (const ln of l.lines) {
				const it = grow(lineEls, ln.key, ln, stamp, () => svg('line', { class: `ln${ln.idle ? ' idle' : ''}${ln.dim ? ' dim' : ''}`, y1: ln.y, y2: ln.y }, rowGs[ln.row][0]));
				put(it, 'x', `${n1(ln.x1)}|${n1(ln.x2)}`, () => {
					it.el.setAttribute('x1', String(n1(ln.x1)));
					it.el.setAttribute('x2', String(n1(ln.x2)));
				});
			}
			sweep(lineEls, stamp);
			for (const p of l.paths) {
				const it = grow(linkEls, p.key, p, stamp, () => svg('path', { class: p.kind === 'route' ? 'route' : `lk ${p.kind === 'merge' ? 'm' : 'b'}${p.inferred ? ' inferred' : ''}`, d: p.d }, layers.links));
				put(it, 'd', p.d, () => it.el.setAttribute('d', p.d));
			}
			sweep(linkEls, stamp);
			markOfTask.clear();
			for (const m of l.marks) {
				const it = grow(markEls, m.key, m, stamp, () => svg('circle', {
					class: `mk${m.open ? ' o' : ''}${m.kind === 'context' ? ' ctx' : ''}${m.kind === 'mine' ? ' me' : ''}${m.dim ? ' dim' : ''}`, cy: m.y,
				}, rowGs[m.row][1]));
				const lit = inBand(m.x);
				put(it, 'm', `${n1(m.x)}|${m.r}|${m.fade.toFixed(2)}|${lit}`, () => {
					it.el.setAttribute('cx', String(n1(m.x)));
					it.el.setAttribute('r', String(m.r));
					(it.el as SVGElement).style.setProperty('--f', m.fade < 1 ? m.fade.toFixed(2) : '');
					it.el.classList.toggle('inb', lit);
				});
				if (m.kind !== 'context' && (m.fade >= 0.5 || !markOfTask.has(m.items[0].id))) {
					for (const n of m.items) {
						markOfTask.set(n.id, m);
					}
				}
				const ring = rings.get(m.key);
				if (ring) {
					ring.setAttribute('cx', String(n1(m.x)));
					ring.setAttribute('cy', String(m.y));
					ring.setAttribute('r', String(m.r + 3.5));
				}
				if (m.kind !== 'context') {
					it.hit ??= this.renderHit(hits, it, layout, W, () => cur.axis.pan, hover, rowEls, cardTimer, store);
					const hit = it.hit;
					put(it, 'h', `${n1(m.x)}|${n1(m.y)}|${m.hitR}|${m.fade >= 0.5}`, () => {
						hit.style.transform = `translate(${n1(m.x - m.hitR)}px, ${n1(m.y - m.hitR)}px)`;
						hit.style.width = hit.style.height = `${2 * m.hitR}px`;
						hit.style.display = m.fade >= 0.5 ? '' : 'none';
					});
				}
			}
			sweep(markEls, stamp, it => {
				it.hit?.remove();
				rings.get(it.v.key)?.remove();
				rings.delete(it.v.key);
				ringCount.delete(it.v.key);
			});
			for (const e of l.ends) {
				const it = grow(endEls, e.row, e, stamp, () => {
					const g = svg('g', {}, rowGs[e.row][2]);
					if (e.live) {
						svg('circle', { class: 'ping', cy: e.y, r: 4 }, g);
					}
					svg('circle', { class: `end ${e.state}`, cy: e.y, r: 4 }, g);
					return g;
				});
				const lit = inBand(e.x);
				put(it, 'x', `${n1(e.x)}|${lit}`, () => {
					for (const c of Array.from(it.el.children)) {
						c.setAttribute('cx', String(n1(e.x)));
					}
					it.el.lastElementChild?.classList.toggle('inb', lit);
				});
			}
			sweep(endEls, stamp);
			this.paintAxis(axisEls, l);
		};
		apply(layout);

		// the focus: wheel, drag, a click on a day, the arrow keys
		const reduced = () => win.matchMedia('(prefers-reduced-motion: reduce)').matches || !!graph.closest('.monaco-workbench')?.classList.contains('monaco-reduce-motion');
		const focus = new DayFocus(layout.axis.g, () => cur.axis, g => {
			this.axisFocus = g;
			const t0 = win.performance.now();
			apply(relayout(g));
			// read by the end-to-end check (how long one frame of sliding takes to compute and draw)
			graph.dataset.frameMs = (win.performance.now() - t0).toFixed(2);
		}, { frame: cb => win.requestAnimationFrame(cb), cancelFrame: id => win.cancelAnimationFrame(id), later: (cb, ms) => win.setTimeout(cb, ms), cancelLater: id => win.clearTimeout(id) }, reduced);
		store.add(toDisposable(() => focus.dispose()));
		const quiet = () => {
			// a card or a task's details hanging over a graph that is moving would point at nothing
			this.hoverService.hideHover(true);
			detail.classList.remove('show');
			detailBy = undefined;
		};
		this.attachMotion(graph, focus, cols, () => cur.axis, quiet, store);
		axisEls.onDay = start => {
			const i = cur.axis.days.findIndex(d => d.start === start);
			if (i >= 0) {
				quiet();
				focus.goTo(cur.axis.centers[i]);
			}
		};
		store.add(DOM.addDisposableListener(graph, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
			if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
				return;
			}
			const cs = cur.axis.centers;
			const at = cs.indexOf(nearestCenter(cs, focus.g));
			if (at + dir >= 0 && at + dir < cs.length) {
				e.preventDefault();
				quiet();
				focus.goTo(cs[at + dir]);
			}
		}));

		for (const row of layout.rows) {
			const el = rowEls[row.index];
			store.add(DOM.addDisposableListener(el, DOM.EventType.MOUSE_ENTER, () => hover.row(row.index, true)));
			store.add(DOM.addDisposableListener(el, DOM.EventType.MOUSE_LEAVE, () => hover.row(row.index, false)));
			// the right-hand line: its task's mark gets a ring, its details come up over the chart
			const now = nowEls[row.index];
			let ringed: IGraphMark<ITaskGraphNode> | undefined;
			store.add(DOM.addDisposableListener(now, DOM.EventType.MOUSE_ENTER, () => {
				ringed = hover.markOf(row.nowTask.id);
				hover.ring(ringed, true);
				hover.detail(now, row.nowTask, 'today', row.index);
			}));
			store.add(DOM.addDisposableListener(now, DOM.EventType.MOUSE_LEAVE, () => {
				hover.ring(ringed, false);
				ringed = undefined;
				hover.detail(now, undefined);
			}));
		}
		const drawn = new Map<string, IDrawnRow>(layout.rows.map(r => [r.thing.id, { el: rowEls[r.index], y: r.y, gs: rowGs[r.index], lead: 0, h: ROW_H }]));
		if (foldEl && layout.fold) {
			drawn.set(FOLD_ROW, { el: foldEl, y: layout.fold.y, gs: [], lead: FOLD_GAP, h: FOLD_H });
		}
		if (before) {
			this.slide(lanes, plot, layers, backdrop, drawn, before, H);
		}
		return drawn;
	}

	/**
	 * The graph slides sideways by hand (nothing in the chart column scrolls): a trackpad's sideways swipe, Shift and
	 * the wheel, or a drag moves the focus, and when the movement stops the page glides to the nearest day. A drag
	 * has to travel 5 px before it is one (below that it is a click on a mark). Vertical wheel turns still scroll
	 * the page.
	 */
	private attachMotion(graph: HTMLElement, focus: DayFocus, cols: IColumns, axis: () => IDayAxis, quiet: () => void, store: DisposableStore): void {
		store.add(DOM.addDisposableListener(graph, DOM.EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
			const d = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
			if (!sideways || !d) {
				return;
			}
			e.preventDefault();
			quiet();
			focus.scrollBy(d);
		}, { passive: false }));

		let down: { readonly id: number; readonly x: number; readonly g0: number; readonly scale: number; moved: boolean; readonly samples: { t: number; x: number }[] } | undefined;
		let swallow = false;
		store.add(DOM.addDisposableListener(graph, DOM.EventType.POINTER_DOWN, (e: PointerEvent) => {
			const left = graph.getBoundingClientRect().left + cols.name + GAP;
			if (e.button !== 0 || !e.isPrimary || e.clientX < left || e.clientX > left + cols.chart) {
				return;
			}
			down = { id: e.pointerId, x: e.clientX, g0: focus.g, scale: Math.max(axis().room, 240), moved: false, samples: [{ t: e.timeStamp, x: e.clientX }] };
		}));
		store.add(DOM.addDisposableListener(graph, DOM.EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!down || e.pointerId !== down.id) {
				return;
			}
			const dx = e.clientX - down.x;
			if (!down.moved) {
				if (Math.abs(dx) < 5) {
					return;
				}
				down.moved = true;
				graph.classList.add('dragging');
				graph.setPointerCapture(e.pointerId);
				quiet();
			}
			down.samples.push({ t: e.timeStamp, x: e.clientX });
			while (down.samples.length > 2 && e.timeStamp - down.samples[0].t > 100) {
				down.samples.shift();
			}
			focus.dragTo(down.g0 - dx / down.scale);
		}));
		const up = (e: PointerEvent) => {
			if (!down || e.pointerId !== down.id) {
				return;
			}
			const d = down;
			down = undefined;
			if (!d.moved) {
				return;
			}
			graph.classList.remove('dragging');
			if (graph.hasPointerCapture(e.pointerId)) {
				graph.releasePointerCapture(e.pointerId);
			}
			const a = d.samples[0];
			const b = d.samples[d.samples.length - 1];
			// the speed of the last 100 ms, as the focus per ms (a drag to the right goes back in time)
			focus.release(b.t > a.t ? -((b.x - a.x) / (b.t - a.t)) / d.scale : 0);
			// the click that follows a drag is not a click on whatever was under the pointer
			swallow = true;
			DOM.getWindow(graph).setTimeout(() => { swallow = false; }, 60);
		};
		store.add(DOM.addDisposableListener(graph, DOM.EventType.POINTER_UP, up));
		store.add(DOM.addDisposableListener(graph, 'pointercancel', up));
		store.add(DOM.addDisposableListener(graph, DOM.EventType.CLICK, (e: MouseEvent) => {
			if (swallow) {
				e.stopPropagation();
				e.preventDefault();
			}
		}, true));
	}

	/**
	 * Another scope or the fold, same answer (DESIGN.md 列表行进入 / 离开; the designer's review of 2026-09-28):
	 * a row that comes opens from nothing to its height and fades in, a row that goes closes to nothing and
	 * fades out, and the rest move only as far as those push them, so no two rows overlap in any frame
	 * (planSwitch in dispatchTaskGraphLayout.ts works it out). A row's line, marks and end move with its name,
	 * frame for frame; the lines between rows come back once the rows have landed. Nothing moves under reduced
	 * motion.
	 */
	private slide(lanes: HTMLElement, plot: HTMLElement, layers: ILayers, backdrop: IBackdrop, now: ReadonlyMap<string, IDrawnRow>, before: ReadonlyMap<string, IDrawnRow>, height: number): void {
		const win = DOM.getWindow(lanes);
		if (win.matchMedia('(prefers-reduced-motion: reduce)').matches || lanes.closest('.monaco-workbench')?.classList.contains('monaco-reduce-motion')) {
			return;
		}
		const slots = (m: ReadonlyMap<string, IDrawnRow>) => [...m].map(([id, r]) => ({ id, y: r.y, lead: r.lead, h: r.h }));
		const { moves, heights } = planSwitch(slots(before), slots(now));
		const D = 150;
		const timing: KeyframeAnimationOptions = { duration: D, easing: 'linear' };
		lanes.classList.add('moving');
		for (const mv of moves) {
			const row = (mv.kind === 'go' ? before : now).get(mv.id);
			if (!row) {
				continue;
			}
			if (mv.kind === 'go') {
				// what goes is drawn where it was: its row under the drawing, its groups back in their layers
				row.el.classList.remove('hot');
				row.el.classList.add('leaving');
				row.el.style.top = `${row.y}px`;
				lanes.insertBefore(row.el, plot);
				const [gl, gm, ge] = row.gs;
				if (gl && gm && ge) {
					layers.lines.appendChild(gl);
					layers.marks.appendChild(gm);
					layers.ends.appendChild(ge);
				}
			}
			const base = row.el.classList.contains('dim') ? 0.28 : 1;
			const html: Keyframe[] = mv.frames.map(f => mv.kind === 'stay'
				? { offset: f.offset, transform: `translateY(${f.dy}px)` }
				: { offset: f.offset, transform: `translateY(${f.dy}px)`, opacity: base * f.open, clipPath: `inset(${f.cut}px 0px)` });
			const draw: Keyframe[] = mv.frames.map(f => mv.kind === 'stay'
				? { offset: f.offset, transform: `translateY(${f.dy}px)` }
				: { offset: f.offset, transform: `translateY(${f.dy}px)`, opacity: f.open });
			const a = row.el.animate(html, timing);
			for (const g of row.gs) {
				g.animate(draw, timing);
			}
			if (mv.kind === 'go') {
				a.onfinish = a.oncancel = () => {
					row.el.remove();
					for (const g of row.gs) {
						g.remove();
					}
				};
			}
		}
		const at = (k: number) => k / (heights.length - 1);
		lanes.animate(heights.map((h, k) => ({ offset: at(k), height: `${h}px` })), timing);
		// the focus day's band and the Now line grow and shrink with the rows
		for (const rule of [backdrop.bands, ...backdrop.rules]) {
			rule.style.transformBox = 'fill-box';
			rule.style.transformOrigin = 'top';
			rule.animate(heights.map((h, k) => ({ offset: at(k), transform: `scaleY(${(h + 8) / (height + 8)})` })), timing);
		}
		// the lines between rows come back once the rows have landed
		layers.links.animate([{ opacity: 0 }, { opacity: 0, offset: D / (D + 150) }, { opacity: 1 }], { duration: D + 150, easing: 'linear' });
		win.setTimeout(() => lanes.classList.remove('moving'), D);
	}

	private renderFold(lanes: HTMLElement, layout: IGraphLayout<ITaskGraphNode>, store: DisposableStore): HTMLElement {
		const f = layout.fold!;
		const fold = DOM.append(lanes, $('button.dispatch-tg-fold', { type: 'button' }));
		fold.style.top = `${f.y}px`;
		fold.classList.toggle('open', f.open);
		fold.setAttribute('aria-expanded', String(f.open));
		const caret = renderIcon(Codicon.chevronRight);
		caret.classList.add('dispatch-tg-caret');
		fold.appendChild(caret);
		DOM.append(fold, $('span', undefined, f.kind === 'session'
			? localize('dispatchTaskGraph.notInSession', "Not in this session")
			: localize('dispatchTaskGraph.quiet', "No activity in 7 days")));
		DOM.append(fold, $('span.dispatch-tg-fold-count', undefined, String(f.count)));
		store.add(DOM.addDisposableListener(fold, DOM.EventType.CLICK, () => {
			if (f.kind === 'session') {
				sessionFoldOpen.set(!f.open, undefined);
			} else {
				this.storageService.store(FOLD_KEY, !f.open, StorageScope.PROFILE, StorageTarget.USER);
				this.quietOpen.set(!f.open, undefined);
			}
		}));
		return fold;
	}

	/** One mark's hover target: the row lights at once, a card after 250 ms, a click opens the task. `at` is the mark's
	 *  entry, so whatever the mark is on this frame is what the card is for. */
	private renderHit(hits: HTMLElement, at: IPlotEl<IGraphMark<ITaskGraphNode>>, layout: IGraphLayout<ITaskGraphNode>, W: number, pan: () => number, hover: IGraphHover, rowEls: HTMLElement[],
		card: { id: ReturnType<typeof setTimeout> | undefined }, store: DisposableStore): HTMLButtonElement {
		const hit = DOM.append(hits, $('button.dispatch-tg-hit', { type: 'button', tabindex: '-1' })) as HTMLButtonElement;
		const m0 = at.v;
		const newest0 = m0.items[m0.items.length - 1];
		hit.setAttribute('aria-label', m0.items.length === 1
			? newest0.title
			: localize('dispatchTaskGraph.bucketAria', "{0} tasks in {1}, {2}", m0.items.length, newest0.thing.name, bucketWords(layout.axis, m0.bucket)));
		let carded = false;
		// this mark's own ring, held once however often the pointer comes back while its card is up
		let ringed: IGraphMark<ITaskGraphNode> | undefined;
		const off = () => {
			const m = at.v;
			// the row stays lit while the pointer is still on it
			if (!rowEls[m.row]?.matches(':hover')) {
				hover.row(m.row, false);
			}
			if (ringed) {
				hover.ring(ringed, false);
				ringed = undefined;
			}
			hover.detail(m, undefined);
		};
		store.add(DOM.addDisposableListener(hit, DOM.EventType.MOUSE_ENTER, () => {
			const m = at.v;
			hover.row(m.row, true);
			if (!ringed) {
				ringed = m;
				hover.ring(m, true);
			}
			clearTimeout(card.id);
			card.id = setTimeout(() => {
				if (hit.isConnected) {
					carded = this.showCard(hit, at.v, at.v.x - pan(), layout, W, hover, () => {
						carded = false;
						off();
					}, store);
				}
			}, HOVER_DELAY);
		}));
		store.add(DOM.addDisposableListener(hit, DOM.EventType.MOUSE_LEAVE, () => {
			clearTimeout(card.id);
			if (!carded) {
				off();
			}
		}));
		store.add(DOM.addDisposableListener(hit, DOM.EventType.CLICK, () => {
			clearTimeout(card.id);
			this.hoverService.hideHover(true);
			const items = at.v.items;
			this.openTask(items[items.length - 1].id);
		}));
		return hit;
	}

	/** The axis head (the Projects Timeline's has its own), over the chart column; it stays on top while the rows
	 *  scroll, and slides with the graph: a day cell per day (a click opens it), month and day titles, the ticks. */
	private renderAxis(graph: HTMLElement, cols: IColumns, store: DisposableStore): IAxisEls {
		const bar = DOM.append(graph, $('.dispatch-tg-axis'));
		const view = DOM.append(bar, $('.dispatch-tg-axisview'));
		view.style.marginLeft = `${cols.name + GAP}px`;
		view.style.width = `${cols.chart}px`;
		const track = DOM.append(view, $('.dispatch-tg-axistrack'));
		const els: IAxisEls = { track, cells: new Map(), titles: new Map(), ticks: new Map(), stamp: 0, onDay: undefined };
		store.add(DOM.addDisposableListener(track, DOM.EventType.CLICK, (e: MouseEvent) => {
			const cell = (e.target as Element).closest<HTMLElement>('.dispatch-tg-daycell');
			if (cell) {
				els.onDay?.(Number(cell.dataset.day));
			}
		}));
		return els;
	}

	private paintAxis(els: IAxisEls, l: IGraphLayout<ITaskGraphNode>): void {
		const stamp = ++els.stamp;
		const ax = l.axis;
		els.track.style.transform = `translateX(${-n1(ax.pan)}px)`;
		for (const d of ax.days) {
			const it = grow(els.cells, d.start, d, stamp, () => {
				const b = $('button.dispatch-tg-daycell', { type: 'button', tabindex: '-1', 'aria-label': localize('dispatchTaskGraph.openDay', "Open {0}", d.today ? localize('dispatchTaskGraph.todayWord', "today") : monthDay(d.start)) });
				b.dataset.day = String(d.start);
				els.track.appendChild(b);
				return b;
			});
			put(it, 'x', `${n1(d.x0)}|${n1(d.x1)}|${d.e.toFixed(3)}`, () => {
				it.el.style.transform = `translateX(${n1(d.x0)}px)`;
				it.el.style.width = `${n1(d.x1 - d.x0)}px`;
				it.el.dataset.e = d.e.toFixed(3);
				it.el.classList.toggle('open', d.e >= 0.5);
			});
		}
		for (const t of l.labels.titles) {
			const it = grow(els.titles, t.key, t, stamp, () => {
				const el = $('.dispatch-tg-axis-title', undefined, t.text);
				els.track.appendChild(el);
				return el;
			});
			put(it, 'x', `${n1(t.x)}|${t.alpha.toFixed(2)}`, () => {
				it.el.style.transform = `translateX(${n1(t.x)}px)`;
				it.el.style.opacity = t.alpha.toFixed(2);
			});
		}
		for (const t of l.labels.ticks) {
			const it = grow(els.ticks, t.key, t, stamp, () => {
				const el = $(`.dispatch-tg-axis-tick.${t.kind}`);
				el.appendChild($('i'));
				els.track.appendChild(el);
				return el;
			});
			put(it, 'x', `${n1(t.x)}|${t.alpha.toFixed(2)}|${t.label ?? ''}`, () => {
				it.el.style.transform = `translateX(${n1(t.x)}px)`;
				it.el.style.opacity = t.alpha.toFixed(2);
				let b = it.el.querySelector('b');
				if (t.label && !b) {
					b = it.el.appendChild($('b'));
				}
				if (b && !t.label) {
					b.remove();
				} else if (b && b.textContent !== t.label) {
					b.textContent = t.label ?? '';
				}
			});
		}
		sweep(els.cells, stamp);
		sweep(els.titles, stamp);
		sweep(els.ticks, stamp);
	}

	private renderRow(lanes: HTMLElement, row: IGraphRow<ITaskGraphNode>, store: DisposableStore): HTMLElement {
		const el = DOM.append(lanes, $('.dispatch-tg-lane'));
		el.dataset.thing = row.thing.id;
		el.style.top = `${row.y}px`;
		el.classList.toggle('dim', row.dim);
		const name = DOM.append(el, $('.dispatch-tg-name'));
		const nameText = DOM.append(name, $('span.dispatch-tg-name-text', undefined, row.thing.name));
		DOM.append(name, $('span.dispatch-tg-count', undefined, String(row.count)));
		// the whole name on our card, where the column cuts it off
		store.add(setupDispatchTextHover(this.hoverService, name, () => ({ text: row.thing.name }), { when: [nameText] }));
		DOM.append(el, $('.dispatch-tg-chart'));
		const task = row.nowTask;
		const state = row.state;
		const now = DOM.append(el, $('button.dispatch-tg-now', { type: 'button' }));
		now.classList.toggle('done', state === 'done');
		const pre = state === 'waiting' ? localize('dispatchTaskGraph.preWaiting', "Waiting for you: ")
			: state === 'todo' ? localize('dispatchTaskGraph.preTodo', "To do: ")
				: state === 'done' ? localize('dispatchTaskGraph.preLast', "Last: ") : '';
		if (pre) {
			DOM.append(now, $('span.dispatch-tg-now-pre', undefined, pre));
		}
		DOM.append(now, $('span.dispatch-tg-now-title', undefined, task.title));
		now.setAttribute('aria-label', `${pre}${task.title}`);
		store.add(DOM.addDisposableListener(now, DOM.EventType.CLICK, () => this.openTask(task.id)));
		return el;
	}

	private openTask(id: string): void {
		void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, id, 'graph');
	}

	private restoreScroll(scope: string, data: ITaskGraphData): void {
		const scroller = this.container?.closest('.custom-view-scroll-content');
		this.scrollKey = `${scope}:${data.project ?? ''}:${data.session ?? ''}`;
		if (scroller && lastScroll?.key === this.scrollKey) {
			const top = lastScroll.top;
			lastScroll = undefined;
			DOM.getWindow(scroller).requestAnimationFrame(() => {
				scroller.scrollTop = top;
			});
		}
	}

	// ---- details --------------------------------------------------------------------------------

	private statusOf(n: ITaskGraphNode): GraphStatus {
		return shownStatus(n, this.management) as GraphStatus;
	}

	private statusWord(status: GraphStatus): string {
		switch (status) {
			case 'waiting': return localize('dispatchTaskGraph.waiting', "Waiting for you");
			case 'in_progress': return localize('dispatchTaskGraph.inProgress', "In progress");
			case 'todo': return localize('dispatchTaskGraph.todo', "To do");
			default: return localize('dispatchTaskGraph.doneWord', "Done");
		}
	}

	/** A card's state mark: the Tasks tab's (DESIGN.md「符号表」), 14px wherever it is. */
	private dot(status: GraphStatus): HTMLElement {
		return statusMark(status);
	}

	/** Who and when, in the card's words: the status (the detail always says it, the card when it is not plain
	 *  in progress), the agent, when it was asked or done. */
	private metaParts(n: ITaskGraphNode, status: GraphStatus, now: number, always: boolean): { readonly kind: 'status' | 'agent' | 'when'; readonly text: string }[] {
		const agent = agentName(n.agent);
		const parts: { kind: 'status' | 'agent' | 'when'; text: string }[] = [];
		if (status === 'done') {
			parts.push({ kind: 'when', text: localize('dispatchTaskGraph.doneWhenCap', "Done {0}", whenShort(n.done_at || n.at, now)) });
			if (agent) {
				parts.push({ kind: 'agent', text: agent });
			}
			return parts;
		}
		if (always || status !== 'in_progress') {
			parts.push({ kind: 'status', text: this.statusWord(status) });
		}
		if (agent) {
			parts.push({ kind: 'agent', text: agent });
		}
		parts.push({ kind: 'when', text: localize('dispatchTaskGraph.askedWhen', "asked {0}", whenShort(n.at, now)) });
		return parts;
	}

	/** One task beside the graph, the card's component (kanban DESIGN.md「联动悬停」): the status dot and the
	 *  title (two lines at most), then status · who · when on one line, where its plan is, what it delivered. */
	private fillDetail(el: HTMLElement, n: ITaskGraphNode, now: number): void {
		DOM.clearNode(el);
		const status = this.statusOf(n);
		const head = DOM.append(el, $('.dispatch-tg-detail-head'));
		head.appendChild(this.dot(status));
		const text = DOM.append(head, $('.dispatch-tg-detail-text'));
		DOM.append(text, $('.dispatch-tg-detail-title', undefined, n.title));
		const meta = DOM.append(text, $('.dispatch-tg-detail-meta'));
		const parts = this.metaParts(n, status, now, true);
		if (n.plan_total && n.plan_now) {
			const plan = DOM.append(text, $('.dispatch-tg-detail-row'));
			plan.appendChild(renderIcon(Codicon.listOrdered));
			DOM.append(plan, $('span', undefined, status === 'done'
				? localize('dispatchTaskGraph.planDone', "Plan done, {0} steps", n.plan_total)
				: localize('dispatchTaskGraph.planAt', "Step {0} of {1}: {2}", n.plan_now.n, n.plan_total, n.plan_now.text)));
		}
		if (n.deliverables.length) {
			const row = DOM.append(text, $('.dispatch-tg-detail-row.dispatch-tg-detail-deliverables'));
			for (const d of n.deliverables.slice(0, 3)) {
				const item = DOM.append(row, $('span.dispatch-tg-detail-deliverable'));
				item.appendChild(renderIcon(DELIVERABLE_ICON[d.kind] ?? Codicon.file));
				DOM.append(item, $('span', undefined, d.kind === 'commit' ? d.ref.slice(0, 7) : deliverableLabel(d)));
			}
			if (n.deliverables.length > 3) {
				DOM.append(row, $('span', undefined, `+${n.deliverables.length - 3}`));
			}
		}
		// one line, never wrapped: when it does not fit the agent goes first, then the status word (the dot says
		// it); the time always stays whole
		for (const drop of [[], ['agent'], ['agent', 'status']]) {
			meta.textContent = parts.filter(p => !drop.includes(p.kind)).map(p => p.text).join(' · ');
			if (meta.scrollWidth <= meta.clientWidth + 0.5) {
				break;
			}
		}
	}

	// ---- the card on a mark ---------------------------------------------------------------------

	private showCard(target: HTMLElement, m: IGraphMark<ITaskGraphNode>, vx: number, layout: IGraphLayout<ITaskGraphNode>, W: number, hover: IGraphHover, onGone: () => void, store: DisposableStore): boolean {
		const cardStore = new DisposableStore();
		// one task: its details straight away (user 09-27: hovering a point shows the task); two or more: the list,
		// each row with its details beside it
		const card = m.items.length === 1 ? this.taskCard(m.items[0], layout, cardStore) : this.bucketCard(m, layout, hover, cardStore);
		cardStore.add(linkifyDispatchTasksWith(this.commandService, card));
		// under the row (over it when the window has no room below), so the row and its marks stay in sight; beside
		// the mark, 24 px off, on the side that keeps the right-hand column free for a row's details: its left edge
		// right of the mark while the card fits in the chart, else its right edge left of the mark
		const row = layout.rows[m.row];
		const toLeft = vx + 24 + CARD_W > W;
		const anchor = DOM.append(target.parentElement ?? target, $('.dispatch-tg-anchor'));
		anchor.style.left = `${toLeft ? m.x - 25 : m.x + 24}px`;
		anchor.style.top = `${row.y - 4}px`;
		anchor.style.height = `${ROW_H + 8}px`;
		cardStore.add(toDisposable(() => anchor.remove()));
		const widget = this.hoverService.showInstantHover({
			content: card,
			target: { targetElements: [anchor, target] },
			position: { hoverPosition: HoverPosition.BELOW, anchorAlignment: toLeft ? AnchorAlignment.RIGHT : AnchorAlignment.LEFT },
			appearance: { showPointer: false },
			persistence: { hideOnHover: false },
			additionalClasses: ['dispatch-tg-hover'],
		});
		if (!widget) {
			cardStore.dispose();
			onGone();
			return false;
		}
		let done = false;
		const gone = () => {
			if (!done) {
				done = true;
				onGone();
				cardStore.dispose();
			}
		};
		const onDispose = (widget as IHoverWidget & { readonly onDispose?: Event<void> }).onDispose;
		if (onDispose) {
			cardStore.add(onDispose(gone));
		} else {
			const watch = setInterval(() => (widget.isDisposed || !card.isConnected) && gone(), 150);
			cardStore.add(toDisposable(() => clearInterval(watch)));
		}
		store.add(cardStore);
		return true;
	}

	/** One task: the same details as everywhere else, with where it came from on this graph. */
	private taskCard(n: ITaskGraphNode, layout: IGraphLayout<ITaskGraphNode>, store: DisposableStore): HTMLElement {
		const o = layout.origin.get(n.id);
		const origin = o ? { kind: o.kind, gapDays: o.gapDays, fromThing: o.from.thing.name, fromTitle: o.from.title, inferred: o.inferred } : undefined;
		const card = this.instantiationService.invokeFunction(renderTaskDetail, { ...n, status: this.statusOf(n), ...(origin ? { origin } : {}) }, store);
		card.classList.add('dispatch-tg-task-card');
		return card;
	}

	/** The tasks of one hour / half day / day in a thing: newest first, each opens its task page; pointing
	 *  at one shows its details over the row's right-hand column. */
	private bucketCard(m: IGraphMark<ITaskGraphNode>, layout: IGraphLayout<ITaskGraphNode>, hover: IGraphHover, store: DisposableStore): HTMLElement {
		const items = [...m.items].reverse();
		const card = $('.session-summary-hover.dispatch-tg-card');
		const head = DOM.append(card, $('.session-summary-hover-title'));
		DOM.append(head, $('span.session-summary-hover-detail', undefined,
			localize('dispatchTaskGraph.bucketHead', "{0} · {1} tasks in {2}", bucketWords(layout.axis, m.bucket), items.length, items[0].thing.name)));
		const sec = DOM.append(card, $('.session-summary-hover-section.dispatch-tg-card-list'));
		for (const n of items.slice(0, 6)) {
			const row = DOM.append(sec, $('button.session-summary-hover-row.dispatch-tg-card-row', { type: 'button' }));
			row.appendChild(this.dot(this.statusOf(n)));
			DOM.append(row, $('span.dispatch-tg-card-row-title', undefined, n.title));
			DOM.append(row, $('span.dispatch-tg-card-row-at', undefined, hourMinute(n.at)));
			setupDispatchRowDetail(card, row, detailStore => this.instantiationService.invokeFunction(renderTaskDetail, { ...n, status: this.statusOf(n) }, detailStore), store, { onShow: () => hover.ring(m, true), onHide: () => hover.ring(m, false) });
			store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => {
				e.preventDefault();
				this.hoverService.hideHover(true);
				this.openTask(n.id);
			}));
		}
		if (items.length > 6) {
			DOM.append(sec, $('.dispatch-tg-card-more', undefined, localize('dispatchTaskGraph.andMore', "and {0} more", items.length - 6)));
		}
		store.add(toDisposable(() => hover.detail(m, undefined)));
		return card;
	}


	// ---- waiting and empty ----------------------------------------------------------------------

	private renderSkeleton(body: HTMLElement, width: number, store: DisposableStore): void {
		const cols = columns(width);
		const skel = DOM.append(body, $('.dispatch-tg-skel'));
		skel.style.setProperty('--tg-name', `${cols.name}px`);
		skel.style.setProperty('--tg-now', `${cols.now}px`);
		skel.setAttribute('aria-busy', 'true');
		skel.setAttribute('aria-label', localize('dispatchTaskGraph.loading', "Loading tasks…"));
		const widths: [number, number, number, number][] = [[.7, .38, .18, .62], [.5, .34, .34, .8], [.62, .5, .12, .5], [.44, .12, .46, .7], [.56, .4, .24, .66], [.4, .6, .08, .4], [.66, .3, .3, .74]];
		for (const [n, at, len, nw] of widths) {
			const r = DOM.append(skel, $('.dispatch-tg-skel-row'));
			DOM.append(r, $('i')).style.width = `${n * 100}%`;
			const chart = DOM.append(r, $('i.chart'));
			chart.style.marginLeft = `${at * 100}%`;
			chart.style.width = `${Math.min(len + .14, 1 - at) * 100}%`;
			DOM.append(r, $('i')).style.width = `${nw * 100}%`;
		}
		// under 120 ms nothing shows (no flash); after that the rows fade in and the shimmer runs
		const t = setTimeout(() => skel.classList.add('show'), SKELETON_AFTER);
		store.add(toDisposable(() => clearTimeout(t)));
	}

	private renderEmpty(body: HTMLElement, kind: 'session' | 'project', data: ITaskGraphData, store: DisposableStore): void {
		const empty = DOM.append(body, $('.dispatch-tg-empty'));
		const icon = renderIcon(Codicon.gitMerge);
		icon.classList.add('dispatch-tg-empty-icon');
		empty.appendChild(icon);
		const project = this.projectLabel(data);
		const all = data.nodes?.length ?? 0;
		if (kind === 'session') {
			DOM.append(empty, $('.dispatch-tg-empty-title', undefined, localize('dispatchTaskGraph.emptySession', "No tasks in this session yet.")));
			if (this.chat()) {
				// a chat has no project around it: nothing to show instead
				DOM.append(empty, $('.dispatch-tg-empty-text', undefined, localize('dispatchTaskGraph.emptySessionText0', "Tasks show up here once the agent plans something you asked for.")));
				return;
			}
			DOM.append(empty, $('.dispatch-tg-empty-text', undefined, all
				? localize('dispatchTaskGraph.emptySessionText', "Tasks show up here once the agent plans something you asked for. The {0} graph has {1}.", project, all)
				: localize('dispatchTaskGraph.emptySessionText0', "Tasks show up here once the agent plans something you asked for.")));
			const btn = DOM.append(empty, $('button.dispatch-tg-empty-btn', { type: 'button' }, localize('dispatchTaskGraph.showProject', "Show {0}", project)));
			store.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => this.setScope('project')));
			return;
		}
		DOM.append(empty, $('.dispatch-tg-empty-title', undefined, localize('dispatchTaskGraph.emptyProject', "No tasks in the last {0} days.", data.days || TASK_WINDOW_DAYS)));
		DOM.append(empty, $('.dispatch-tg-empty-text', undefined, localize('dispatchTaskGraph.emptyProjectText', "Older tasks are in the Archive on the project page.")));
		const name = dispatchGraphProject.get()?.name || data.project;
		if (name) {
			const btn = DOM.append(empty, $('button.dispatch-tg-empty-btn', { type: 'button' }));
			btn.appendChild(renderIcon(Codicon.archive));
			DOM.append(btn, $('span', undefined, localize('dispatchTaskGraph.openArchive', "Open Archive")));
			store.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, { name, label: project })));
		}
	}

	layout(width: number, _height: number): void {
		if (width > 0 && Math.abs(width - this.width.get()) > 1) {
			this.width.set(width, undefined);
		}
	}
}
