/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a Turbo run in the sessions list (patches/420-turbo.patch; kanban design/frenzy
 *  direction A: "a run is one row under its folder, with the ten blocks and 2/10; its parts are rows under it").
 *
 *  While a run goes (and for an hour after it is done) one row sits first under the project's folder: a bolt in the
 *  run's colour (green working, amber something waits for you, grey stopped, teal done), its name, the app icon's
 *  ten blocks filling as parts are combined and "2/10". A plan waiting for Start has the same row, amber, with
 *  "plan" for the count (the plan waits on the Timeline page and needs a way in). A click opens the Timeline page; the
 *  caret at the
 *  right folds its parts away. Each part is a row under it, its block saying how it is; hovering one lights its
 *  lane in the Timeline and the other way round. The folder is added when it has no sessions yet.
 *  sessionsList.ts asks this file for the rows, their heights and how to draw them; nothing else of it changes.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { stateBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { dispatchProjectsRegistry } from '../../sessions/browser/dispatchProjectsModel.js';
import { dispatchTurboHooks, ITurboLive, onDispatchTurboChange, setDispatchTurboHover, turboGoing } from './dispatchTurboHooks.js';
import { markCells, PartStatus, partBlock } from './dispatchTurboModel.js';
import { turboMark } from './dispatchTurboMark.js';

const RUN_PREFIX = 'dispatch-turbo:';
const PART_PREFIX = 'dispatch-turbo-part:';
const RUN_ROW_HEIGHT = 32;
const PART_ROW_HEIGHT = 28;
/** More parts than this: the run's row starts folded. */
const FOLDED_OVER = 8;

interface ISectionLike {
	readonly id: string;
	readonly label: string;
	readonly sessions: readonly unknown[];
}

interface IRowTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	readonly newBadge: HTMLElement;
	readonly chevron: HTMLElement;
	readonly toolbarContainer?: HTMLElement;
	readonly collapsed: { set(value: boolean, tx: undefined): void };
	readonly elementDisposables: DisposableStore;
}

export function isTurboSidebarRow(id: string): boolean {
	return id.startsWith(RUN_PREFIX) || id.startsWith(PART_PREFIX);
}

export function turboSidebarRowHeight(id: string): number {
	return id.startsWith(PART_PREFIX) ? PART_ROW_HEIGHT : RUN_ROW_HEIGHT;
}

/** The run the list shows: one that goes, a plan waiting for Start, or one done within the hour (the contribution keeps only those). */
function shownRun(): ITurboLive | undefined {
	const live = dispatchTurboHooks.live;
	const shown = !!live && (live.state === 'done' || live.state === 'planned' || turboGoing(live));
	return shown && live?.parts?.length ? live : undefined;
}

/** The folder's label in the list: the registered project at the run's folder, else the folder's name. */
function folderLabel(live: ITurboLive): string {
	const project = dispatchProjectsRegistry.get()?.find(p => p.host === 'local' && p.dir && p.dir.replace(/\/+$/, '') === live.repo.replace(/\/+$/, ''));
	return project?.label || live.project;
}

/** The row's tree element by id, as last put in the list: the caret folds it through the list's own tree. */
const elements = new Map<string, object>();
let toggle: ((element: object) => void) | undefined;

/** sessionsList.ts: how the caret folds the run's row (the tree is the list's). */
export function bindTurboSidebarTree(fold: (element: object) => void): { dispose(): void } {
	toggle = fold;
	return toDisposable(() => { if (toggle === fold) { toggle = undefined; } });
}

/** The list redraws when a run appears, ends, or its parts change; a part's state alone redraws only its row. */
const watched = new WeakSet<object>();
function watch(owner: { update(): void }): void {
	if (watched.has(owner)) {
		return;
	}
	watched.add(owner);
	let shape = structureKey();
	onDispatchTurboChange(what => {
		if (what !== 'live') {
			return;
		}
		const now = structureKey();
		if (now !== shape) {
			shape = now;
			owner.update();
		}
	});
}

function structureKey(): string {
	const live = shownRun();
	return live ? JSON.stringify([live.id, live.repo, live.title, (live.parts ?? []).map(p => [p.n, p.name])]) : '';
}

/**
 * Put the run's row first under its folder in the list's top-level `children` (sessionsList.ts, after it built
 * them), its parts under it; a folder without sessions yet gets its group so the row has a place.
 */
export function insertTurboRows<T extends { element: unknown }>(children: T[], owner?: { update(): void }): void {
	if (owner) {
		watch(owner);
	}
	elements.clear();
	const live = shownRun();
	if (!live) {
		return;
	}
	const parts = (live.parts ?? []).map(p => {
		const element: ISectionLike = { id: `${PART_PREFIX}${live.id}:${p.n}`, label: p.name, sessions: [] };
		elements.set(element.id, element);
		return { element, children: [], collapsible: false };
	});
	const runElement: ISectionLike = { id: `${RUN_PREFIX}${live.id}`, label: live.title, sessions: [] };
	elements.set(runElement.id, runElement);
	const row = {
		element: runElement,
		children: parts,
		collapsible: true,
		collapsed: parts.length > FOLDED_OVER ? ObjectTreeElementCollapseState.PreserveOrCollapsed : ObjectTreeElementCollapseState.PreserveOrExpanded,
	};
	const label = folderLabel(live);
	const folder = children.find(c => (c.element as ISectionLike).id === `workspace:${label}`) as (T & { children?: Iterable<unknown> }) | undefined;
	if (folder) {
		(folder as { children?: Iterable<unknown> }).children = [row, ...(folder.children ? [...folder.children] : [])];
		return;
	}
	const group = { element: { id: `workspace:${label}`, label, sessions: [] } as ISectionLike, children: [row], collapsible: true, collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded };
	const firstFolder = children.findIndex(c => String((c.element as ISectionLike).id ?? '').startsWith('workspace:'));
	const archived = children.findIndex(c => (c.element as ISectionLike).id === 'archived');
	const at = firstFolder >= 0 ? firstFolder : archived >= 0 ? archived : children.length;
	children.splice(at, 0, group as unknown as T);
}

/** A click on a row: the run opens the Timeline tab, a part its lane there. */
export function openTurboSidebarRow(id: string): void {
	const n = id.startsWith(PART_PREFIX) ? Number(id.slice(id.lastIndexOf(':') + 1)) : undefined;
	dispatchTurboHooks.open?.(Number.isFinite(n) ? n : undefined);
}

function runColour(live: ITurboLive): 'working' | 'waiting' | 'stopped' | 'done' {
	if (live.state === 'done') {
		return 'done';
	}
	if (live.needs || live.state === 'planned') {
		return 'waiting';
	}
	return live.state === 'paused' ? 'stopped' : 'working';
}

function runWords(live: ITurboLive): string {
	if (live.state === 'planned') {
		return localize('dispatchTurboSidebar.planTip', "Turbo plan · {0} · {1} parts · waiting for Start on the Timeline", live.title, live.total);
	}
	const head = localize('dispatchTurboSidebar.runTip', "Turbo run · {0} · {1} of {2} combined", live.title, live.combined, live.total);
	if (live.state === 'done') {
		return localize('dispatchTurboSidebar.runDone', "{0} · done", head);
	}
	if (live.needs) {
		return localize('dispatchTurboSidebar.runNeeds', "{0} · something waits for you", head);
	}
	if (live.state === 'paused') {
		return live.paused
			? localize('dispatchTurboSidebar.runStopped', "{0} · stopped for the allowance", head)
			: localize('dispatchTurboSidebar.runPaused', "{0} · paused", head);
	}
	return head;
}

/** Draw a run's row or a part's row into a section template; everything it sets is undone when the template is reused. */
export function renderTurboSidebarRow(template: IRowTemplate, id: string): void {
	const { container, icon, label, count, newBadge, chevron, elementDisposables } = template;
	const part = id.startsWith(PART_PREFIX);
	const cls = part ? ['dispatch-turbo-part-row'] : ['dispatch-turbo-row'];
	container.classList.remove('session-section-shortcut', 'dispatch-waiting-section', 'dispatch-projects-section');
	container.classList.add(...cls);
	newBadge.style.display = 'none';
	template.collapsed.set(false, undefined);
	chevron.className = 'session-section-chevron';
	if (template.toolbarContainer) {
		template.toolbarContainer.style.display = 'none';
	}
	icon.className = 'session-section-icon';
	icon.style.display = '';
	// a template another row drew before (Waiting for you and the rows under it) leaves its own classes on the number
	count.className = 'session-section-count';
	count.style.display = part ? 'none' : '';
	elementDisposables.add(toDisposable(() => {
		DOM.clearNode(icon);
		DOM.clearNode(label);
		DOM.clearNode(count);
		icon.className = 'session-section-icon';
		count.style.display = '';
		container.classList.remove(...cls, 'hl');
		container.removeAttribute('title');
		delete container.dataset.turboRun;
		if (template.toolbarContainer) {
			template.toolbarContainer.style.display = '';
		}
	}));
	const runId = id.slice((part ? PART_PREFIX : RUN_PREFIX).length).split(':')[0];
	const n = part ? Number(id.slice(id.lastIndexOf(':') + 1)) : undefined;
	let drawn = '';
	const draw = () => {
		const live = dispatchTurboHooks.live;
		if (!live || live.id !== runId) {
			return;
		}
		if (part) {
			const p = live.parts?.find(x => x.n === n);
			const key = JSON.stringify([p?.name, p?.status]);
			if (!p || key === drawn) {
				return;
			}
			drawn = key;
			DOM.clearNode(icon);
			icon.appendChild(stateBlock(partBlock(p.status as PartStatus), { size: 12, breathe: p.status === 'working', title: '' }));
			DOM.clearNode(label);
			DOM.append(label, DOM.$('span.dispatch-turbo-row-name', undefined, p.name));
			DOM.clearNode(count);
			container.title = `${p.n} · ${p.name}`;
			return;
		}
		const colour = runColour(live);
		const key = JSON.stringify([live.title, live.combined, live.total, live.state, colour]);
		if (key === drawn) {
			return;
		}
		drawn = key;
		DOM.clearNode(icon);
		const bolt = DOM.append(icon, DOM.$(`span.dispatch-turbo-bolt.${colour}${ThemeIcon.asCSSSelector(Codicon.zap)}`));
		bolt.setAttribute('aria-hidden', 'true');
		DOM.clearNode(label);
		DOM.append(label, DOM.$('span.dispatch-turbo-row-name', undefined, live.title));
		DOM.clearNode(count);
		const done = live.state === 'done';
		const mark = count.appendChild(turboMark(15, done ? Array(10).fill(true) : markCells(live.combined, live.total), { done }));
		mark.classList.add('still');
		DOM.append(count, DOM.$('span.dispatch-turbo-row-n', undefined, live.state === 'planned' ? localize('dispatchTurboSidebar.plan', "plan") : `${live.combined}/${live.total}`));
		const caret = DOM.append(count, DOM.$<HTMLButtonElement>('button.dispatch-turbo-row-caret', { type: 'button', title: localize('dispatchTurboSidebar.fold', "Show or hide the parts") }));
		caret.appendChild(DOM.$(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		container.title = runWords(live);
	};
	draw();
	// the run's own row lights for a lane of its run while its parts are folded away (no part row to light)
	const lightRun = () => {
		const h = dispatchTurboHooks.hover;
		const folded = !container.ownerDocument.querySelector(`.dispatch-turbo-part-row[data-turbo-run="${runId}"]`);
		container.classList.toggle('hl', !!h && h.run === runId && folded);
	};
	elementDisposables.add(onDispatchTurboChange(what => {
		if (what === 'live') {
			draw();
		} else if (part) {
			const h = dispatchTurboHooks.hover;
			container.classList.toggle('hl', !!h && h.run === runId && h.n === n);
		} else {
			lightRun();
		}
	}));
	if (part) {
		container.dataset.turboRun = runId;
		const h = dispatchTurboHooks.hover;
		container.classList.toggle('hl', !!h && h.run === runId && h.n === n);
		elementDisposables.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_ENTER, () => setDispatchTurboHover({ run: runId, n: n! })));
		elementDisposables.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_LEAVE, () => {
			if (dispatchTurboHooks.hover?.run === runId && dispatchTurboHooks.hover.n === n) {
				setDispatchTurboHover(undefined);
			}
		}));
		return;
	}
	// the caret folds the parts; the row itself opens the Timeline (sessionsList.ts opens rows on a click)
	for (const type of [DOM.EventType.POINTER_DOWN, DOM.EventType.MOUSE_DOWN, DOM.EventType.MOUSE_UP, DOM.EventType.CLICK, DOM.EventType.DBLCLICK]) {
		elementDisposables.add(DOM.addDisposableListener(count, type, e => {
			if (!(e.target as HTMLElement).closest('.dispatch-turbo-row-caret')) {
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			if (type === DOM.EventType.CLICK) {
				const el = elements.get(id);
				if (el) {
					toggle?.(el);
				}
			}
		}));
	}
}
