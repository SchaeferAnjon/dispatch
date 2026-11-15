/*---------------------------------------------------------------------------------------------
 *  Tasks, their deliveries and Docs share one transient focus. Hidden counterparts point to the
 *  existing tab; the summary sits in free space without moving the list or switching its scope.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchLinkedHover.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { renderDispatchHoverCard, setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { planMark, planProgress, planStepTip, type IDispatchDeliverable, type IDispatchPlanItem, type IDispatchTask } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import type { IDispatchDoc } from './dispatchDocsEditor.js';

interface IPreview { title: string; detail: string; plan?: readonly IDispatchPlanItem[]; taskDone?: boolean; open: () => void }
interface ILink {
	folder: string;
	side: 'Tasks' | 'Docs';
	kind: 'task' | 'delivery' | 'doc';
	tasks: readonly string[];
	paths: readonly string[];
	load: () => Promise<IPreview[]>;
	/** Only light the counterpart (the row has its own card, e.g. a delivery with a Where to look picture). */
	quiet?: boolean;
	/** What the row shows when it has no counterpart after all (a report that is not in Docs): the file's own tip. */
	fallback?: string;
	/** For the card on a plan step's circle (what done, in progress and not started mean). */
	hover?: IHoverService;
}
interface ITarget { root: HTMLElement; el: HTMLElement; link: ILink }

/** How long a card stays once the pointer leaves its row or the card (VS Code's hovers keep one too). */
const LEAVE_GRACE_MS = 400;
/** The gap between the right panel's left edge and the card. */
const LEFT_GAP = 6;
/** On the way from a row to its card the pointer may cross other rows: they take over only after this long. */
const SWITCH_MS = 250;

const managers = new WeakMap<Document, LinkedHover>();
const reads = new Map<string, { at: number; value: Promise<unknown> }>();

/** Coalesce reads for one hover sweep, including the icon and the row of the same delivery. */
function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
	const hit = reads.get(key);
	if (hit && Date.now() - hit.at < 10_000) {
		return hit.value as Promise<T>;
	}
	if (reads.size > 100) { reads.clear(); }
	const value = read().catch(e => { reads.delete(key); throw e; });
	reads.set(key, { at: Date.now(), value });
	return value;
}

function pathKey(path: string): string {
	try { return path.startsWith('file:') ? URI.parse(path).fsPath : path; } catch { return path; }
}

/** What a row stands for. A list refresh rebuilds its rows: the new row is the same target by this key. */
function linkKey(link: ILink): string {
	return [link.folder, link.kind, link.tasks.join(','), link.paths.join(',')].join('|');
}

function matches(a: ILink, b: ILink): boolean {
	if (a.folder !== b.folder) { return false; }
	if (a.kind === 'task' || b.kind === 'task') {
		return a.tasks.some(id => b.tasks.includes(id));
	}
	return a.paths.some(path => b.paths.includes(path));
}

function visible(el: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	if (!el.isConnected || r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility === 'hidden') { return false; }
	const root = el.closest('.dispatch-tasks, .dispatch-docs');
	const clip = root?.getBoundingClientRect();
	return !clip || (r.bottom > clip.top && r.top < clip.bottom && r.right > clip.left && r.left < clip.right);
}

class LinkedHover {
	readonly targets = new Set<ITarget>();
	private active: ITarget | undefined;
	/** The row Esc cleared (by `linkKey`): it stays quiet while the pointer stays on it, through list refreshes that rebuild it. */
	private suppressed: string | undefined;
	private panel: HTMLElement | undefined;
	private sourceFocus: HTMLElement | undefined;
	private readonly shown = new DisposableStore();
	private readonly listening = new DisposableStore();
	private painted: HTMLElement[] = [];
	private showTimer: number | undefined;
	private leaveTimer: number | undefined;
	private switchTimer: number | undefined;
	private leavePending = false;
	private lastDistance = Infinity;
	private approachedAt = 0;
	private serial = 0;
	constructor(private readonly doc: Document) { }

	bind(target: ITarget): IDisposable {
		if (!this.targets.size) {
			this.listening.add(dom.addDisposableListener(this.doc, 'keydown', (e: KeyboardEvent) => {
				if (!this.active) { return; }
				if (e.key === 'Escape') {
					e.preventDefault(); e.stopImmediatePropagation();
					const source = this.sourceFocus;
					const inPanel = this.panel?.contains(this.doc.activeElement);
					this.suppressed = linkKey(this.active.link);
					this.clear();
					if (inPanel) { source?.focus({ preventScroll: true }); }
				} else if (e.key === 'Tab' && !e.shiftKey && this.active.el.contains(this.doc.activeElement) && this.panel?.querySelector('button')) {
					this.sourceFocus = this.doc.activeElement as HTMLElement;
					e.preventDefault(); this.panel.querySelector<HTMLElement>('button')?.focus();
				}
			}, true));
			this.listening.add(dom.addDisposableListener(this.doc, 'mousemove', e => {
				this.towardPanel(e);
				if (this.suppressed === undefined) { return; }
				const row = (e.target as HTMLElement | null)?.closest?.('[data-dispatch-linked-target]');
				const over = [...this.targets].find(t => t.el === row);
				if (!over || linkKey(over.link) !== this.suppressed) { this.suppressed = undefined; }
			}, true));
			this.listening.add(dom.addDisposableListener(this.doc, 'pointerdown', e => {
				if (!this.panel?.contains(e.target as Node)) { this.clear(); }
			}, true));
			this.listening.add(dom.addDisposableListener(this.doc, 'scroll', e => {
				if (!this.panel?.contains(e.target as Node)) { this.clear(); }
			}, true));
			this.listening.add(dom.addDisposableListener(this.doc.defaultView!, 'resize', () => this.clear()));
			this.listening.add(dom.addDisposableListener(this.doc.defaultView!, 'blur', () => this.clear()));
		}
		this.targets.add(target);
		target.el.dataset.dispatchLinkedTarget = target.link.kind;
		const store = new DisposableStore();
		const enter = (e: Event) => {
			const delivery = (e.target as HTMLElement).closest<HTMLElement>('[data-deliverable]');
			if (delivery && !delivery.hasAttribute('data-dispatch-linked-target')) {
				// a delivery with its own card; passed on the way to the summary it leaves the summary alone
				if (!this.approaching(e)) { this.clearRoot(target.root); }
				return;
			}
			if ((e.target as HTMLElement).closest('[data-dispatch-linked-target]') !== target.el) { return; }
			const key = linkKey(target.link);
			if (this.suppressed === key) { return; }
			this.suppressed = undefined;
			if (this.panel && this.active && this.active !== target) {
				if (this.approaching(e)) { this.approachedAt = performance.now(); }
				// a card is out for another row: only a row the pointer stays on takes over
				// (the task card around a delivery row is such a row too: moving down it toward the card must not switch)
				const later = () => {
					this.doc.defaultView!.clearTimeout(this.switchTimer);
					this.switchTimer = this.doc.defaultView!.setTimeout(() => {
						if (!(target.el.matches(':hover') || target.el.contains(this.doc.activeElement))) { return; }
						if (performance.now() - this.approachedAt < SWITCH_MS) { later(); return; }
						this.activate(target);
					}, SWITCH_MS);
				};
				later();
				return;
			}
			this.activate(target);
		};
		store.add(dom.addDisposableListener(target.el, 'mouseover', enter));
		store.add(dom.addDisposableListener(target.el, 'focusin', enter));
		const leave = (e: MouseEvent | FocusEvent) => {
			if (target.el.contains(e.relatedTarget as Node)) { return; }
			if (this.active !== target) { this.doc.defaultView!.clearTimeout(this.switchTimer); return; }
			if (this.suppressed === linkKey(target.link)) { this.suppressed = undefined; }
			if (this.panel?.contains(e.relatedTarget as Node)) { return; }
			this.laterClear();
		};
		store.add(dom.addDisposableListener(target.el, 'mouseleave', leave));
		store.add(dom.addDisposableListener(target.el, 'focusout', leave));
		store.add(toDisposable(() => {
			this.targets.delete(target);
			delete target.el.dataset.dispatchLinkedTarget;
			if (this.active === target) { this.clear(); }
			if (!this.targets.size) { this.listening.clear(); }
		}));
		return store;
	}

	clearRoot(root: HTMLElement): void {
		if (this.active?.root === root) { this.clear(); }
	}
	hasActiveRoot(root: HTMLElement): boolean { return this.active?.root === root; }
	/** On the way to the card the grace period starts again with every move that gets closer to it. */
	private towardPanel(e: MouseEvent): void {
		if (!this.panel) { this.lastDistance = Infinity; return; }
		const distance = this.distance(e);
		if (distance < this.lastDistance) {
			this.approachedAt = performance.now();
			// only for a pointer on its way out: keyboard focus in the card or on its row keeps it without any timer
			const focusHere = !!this.active && (this.panel.contains(this.doc.activeElement) || this.active.el.contains(this.doc.activeElement));
			if (this.leavePending && !focusHere) { this.laterClear(); }
		}
		this.lastDistance = distance;
	}
	private distance(e: MouseEvent): number {
		const r = this.panel!.getBoundingClientRect();
		return Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
	}
	/** The pointer is on its way to the card: this event is closer than the last move, or a recent move was. */
	private approaching(e: Event): boolean {
		if (!this.panel) { return false; }
		if (performance.now() - this.approachedAt < SWITCH_MS) { return true; }
		return e instanceof MouseEvent && this.distance(e) < this.lastDistance;
	}
	private laterClear(): void {
		this.leavePending = true;
		this.doc.defaultView!.clearTimeout(this.leaveTimer);
		// a grace period, as VS Code's own hovers have: the pointer crosses the gap from the row to the card
		this.leaveTimer = this.doc.defaultView!.setTimeout(() => this.clear(), LEAVE_GRACE_MS);
	}
	private clear(): void {
		++this.serial;
		this.leavePending = false;
		this.lastDistance = Infinity;
		this.doc.defaultView!.clearTimeout(this.switchTimer);
		this.doc.defaultView!.clearTimeout(this.showTimer);
		this.doc.defaultView!.clearTimeout(this.leaveTimer);
		this.active?.el.removeAttribute('aria-describedby');
		this.active = undefined;
		this.panel?.remove(); this.panel = undefined;
		this.shown.clear();
		for (const el of this.painted) { el.classList.remove('dispatch-linked', 'dispatch-linked-tab'); }
		this.painted = [];
	}
	private paint(target: ITarget, counterpart: boolean): void {
		for (const el of this.painted) { el.classList.remove('dispatch-linked', 'dispatch-linked-tab'); }
		this.painted = [];
		let otherVisible = false;
		for (const t of this.targets) {
			if (visible(t.el) && matches(target.link, t.link)) {
				t.el.classList.add('dispatch-linked'); this.painted.push(t.el);
				if (t.link.side !== target.link.side) { otherVisible = true; }
			}
		}
		if (counterpart && !otherVisible) {
			const name = target.link.side === 'Tasks' ? 'Docs' : 'Tasks';
			const group = target.root.closest('.editor-group-container') ?? this.doc;
			const tab = [...group.querySelectorAll<HTMLElement>('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') ?? '').split(',')[0].trim() === name);
			if (tab) { tab.classList.add('dispatch-linked-tab'); this.painted.push(tab); }
		}
	}
	private activate(target: ITarget): void {
		this.doc.defaultView!.clearTimeout(this.leaveTimer);
		this.leavePending = false;
		if (this.active === target) { return; }
		this.clear(); this.active = target;
		this.sourceFocus = target.el.contains(this.doc.activeElement) ? this.doc.activeElement as HTMLElement : target.el;
		// the Docs / Tasks tab lights only once the counterpart is known to exist
		this.paint(target, false);
		const serial = this.serial;
		const answer = target.link.load();
		// Light the existing route as soon as the actual counterpart is known, before the summary delay.
		void answer.then(rows => { if (this.serial === serial && this.active === target) { this.paint(target, rows.length > 0); } }, () => { });
		if (target.link.quiet) { return; }
		this.showTimer = this.doc.defaultView!.setTimeout(() => {
			if (!visible(target.el) || this.active !== target) { this.clear(); return; }
			this.show(target, [], true);
			void answer.then(rows => {
				if (this.serial !== serial || this.active !== target) { return; }
				if (!rows.length) {
					if (target.link.fallback) { this.show(target, [], false, target.link.fallback); } else { this.clear(); }
					return;
				}
				this.show(target, rows, false);
			}, () => { if (this.serial === serial) { this.clear(); } });
		}, 500);
	}
	private show(target: ITarget, rows: IPreview[], loading: boolean, plain?: string): void {
		this.panel?.remove(); this.shown.clear();
		const side = target.link.side === 'Tasks' ? 'Docs' : 'Tasks';
		const panel = this.panel = dom.$('.dispatch-linked-preview');
		panel.id = 'dispatch-linked-summary';
		panel.setAttribute('role', 'region');
		panel.setAttribute('aria-label', localize('dispatchLinked.summary', "Related {0}", side));
		panel.classList.toggle('loading', loading);
		target.el.setAttribute('aria-describedby', panel.id);
		if (plain !== undefined) {
			// no counterpart: the row's own tip, nothing about Docs
			dom.append(panel, renderDispatchHoverCard({ text: plain }));
		} else {
			dom.append(panel, dom.$('.dispatch-linked-heading', undefined, side === 'Docs'
				? localize('dispatchLinked.docs', "Docs · Related document") : localize('dispatchLinked.tasks', "Tasks · Source task")));
		}
		if (loading) { dom.append(panel, dom.$('.dispatch-linked-loading', undefined, localize('dispatchLinked.loading', "Loading summary…"))); }
		for (const row of rows) {
			const card = renderDispatchHoverCard({ head: row.title, notes: row.plan?.length ? [] : [row.detail] });
			dom.append(panel, card);
			if (row.plan?.length) { this.renderPlan(card, row.detail, row.plan, !!row.taskDone, target.link.hover); }
			const button = dom.append(card, dom.$<HTMLButtonElement>('button.dispatch-linked-open', { type: 'button' }, side === 'Docs'
				? localize('dispatchLinked.openDoc', "Open in Docs") : localize('dispatchLinked.showTask', "Show in Tasks")));
			this.shown.add(dom.addDisposableListener(button, 'click', () => { this.clear(); row.open(); }));
		}
		this.shown.add(dom.addDisposableListener(panel, 'mouseenter', () => { this.leavePending = false; this.doc.defaultView!.clearTimeout(this.leaveTimer); }));
		this.shown.add(dom.addDisposableListener(panel, 'mouseleave', e => { if (!target.el.contains(e.relatedTarget as Node)) { this.laterClear(); } }));
		this.shown.add(dom.addDisposableListener(panel, 'focusin', () => { this.leavePending = false; this.doc.defaultView!.clearTimeout(this.leaveTimer); }));
		this.shown.add(dom.addDisposableListener(panel, 'focusout', e => { if (!panel.contains(e.relatedTarget as Node)) { this.laterClear(); } }));
		this.shown.add(dom.addDisposableListener(panel, 'keydown', (e: KeyboardEvent) => {
			if (e.key !== 'Tab') { return; }
			const buttons = [...panel.querySelectorAll('button')];
			if (e.shiftKey && e.target === buttons[0]) {
				e.preventDefault(); this.sourceFocus?.focus({ preventScroll: true });
			} else if (!e.shiftKey && e.target === buttons.at(-1)) {
				e.preventDefault();
				const focusable = [...target.root.querySelectorAll<HTMLElement>('button, a[tabindex], [tabindex="0"]')].filter(visible);
				const index = focusable.indexOf(this.sourceFocus ?? target.el);
				const next = focusable[index + 1] ?? target.root;
				this.clear(); next.focus({ preventScroll: true });
			}
		}));
		(this.doc.querySelector('.monaco-workbench') ?? this.doc.body).appendChild(panel);
		const root = target.root.getBoundingClientRect();
		const anchor = target.el.getBoundingClientRect();
		panel.style.width = `${Math.min(380, root.width - 24)}px`;
		const height = this.reserveExpanded(panel);
		// Beside the row, on the left over the middle area (the right panel is at the window's right edge), its top on the
		// row's top and pulled up when it would run past the window; below the row only when there is no room on the left.
		// Next to the row, the pointer goes straight from the row into the card without crossing other rows.
		const width = panel.getBoundingClientRect().width;
		let left = root.left - width - LEFT_GAP, top = anchor.top;
		if (left < 8) { left = root.left + 12; top = anchor.bottom + 4; }
		panel.style.left = `${Math.max(8, left)}px`;
		panel.style.top = `${Math.max(40, Math.min(top, this.doc.defaultView!.innerHeight - height - 12))}px`;
	}
	/**
	 * The frame is fixed when the summary opens: every plan list is measured open, each card keeps that height
	 * (its Show button stays at the card bottom), and the panel takes the open height, capped by the window, where
	 * the list scrolls inside its card. Opening or closing a list only changes what is inside the frame.
	 */
	private reserveExpanded(panel: HTMLElement): number {
		const cards = [...panel.querySelectorAll<HTMLElement>('.dispatch-hover-card')].filter(c => c.querySelector('.dispatch-linked-plan'));
		if (!cards.length) { return panel.getBoundingClientRect().height; }
		const lists = cards.map(c => c.querySelector<HTMLElement>('.dispatch-linked-plan')!);
		const was = lists.map(l => l.hidden);
		for (const l of lists) { l.hidden = false; }
		const heights = cards.map(c => c.getBoundingClientRect().height);
		const total = panel.getBoundingClientRect().height;
		lists.forEach((l, i) => { l.hidden = was[i]; });
		cards.forEach((c, i) => { c.classList.add('planned'); c.style.flexBasis = `${heights[i]}px`; });
		const cap = Math.min(440, this.doc.defaultView!.innerHeight - 64);
		const height = Math.min(total, cap);
		panel.style.height = `${height}px`;
		return height;
	}
	/**
	 * The plan starts open every time the card appears (nothing remembers a close): every step with its state,
	 * the Tasks card's shapes. The progress line folds it in place; the frame stays as it was.
	 */
	private renderPlan(card: HTMLElement, detail: string, plan: readonly IDispatchPlanItem[], taskDone: boolean, hover: IHoverService | undefined): void {
		const toggle = dom.append(card, dom.$<HTMLButtonElement>('button.dispatch-linked-plan-toggle', { type: 'button', 'aria-expanded': 'true' }));
		toggle.appendChild(renderIcon(Codicon.chevronRight));
		dom.append(toggle, dom.$('span', undefined, detail));
		const list = dom.append(card, dom.$('ul.dispatch-linked-plan'));
		list.id = `dispatch-linked-plan-${card.parentElement?.childElementCount ?? 0}`;
		toggle.setAttribute('aria-controls', list.id);
		for (const step of plan) {
			// the circle says done / in progress / not started in words on hover (a finished task's open step: not done)
			const tip = planStepTip(step.state, taskDone);
			const li = dom.append(list, dom.$(`li.${step.state}`));
			li.setAttribute('aria-label', `${tip.head}: ${step.text}`);
			const circle = dom.append(li, dom.$('span.dispatch-plan-circle'));
			circle.appendChild(planMark(step.state));
			if (hover) { this.shown.add(setupDispatchTextHover(hover, circle, () => tip, { when: () => true })); }
			dom.append(li, dom.$('span', undefined, step.text));
		}
		// The frame is sized for the open list when the card appears (see reserveExpanded), so this only flips the list.
		this.shown.add(dom.addDisposableListener(toggle, 'click', () => {
			const open = toggle.getAttribute('aria-expanded') !== 'true';
			toggle.setAttribute('aria-expanded', String(open));
			list.hidden = !open;
		}));
	}
}

function bind(root: HTMLElement, el: HTMLElement, link: ILink): IDisposable {
	let manager = managers.get(root.ownerDocument);
	if (!manager) { manager = new LinkedHover(root.ownerDocument); managers.set(root.ownerDocument, manager); }
	return manager.bind({ root, el, link });
}


export function clearDispatchLinkedHover(root: HTMLElement): void {
	if (root) { managers.get(root.ownerDocument)?.clearRoot(root); }
}

/** Polling must not detach a row that currently owns the pointer or keyboard summary. */
export function hasDispatchLinkedHover(root: HTMLElement): boolean {
	return !!root && !!managers.get(root.ownerDocument)?.hasActiveRoot(root);
}

/** First prose paragraph only, never execute HTML or read an unbounded document for a hover. */
async function excerpt(files: IFileService, path: string): Promise<string> {
	if (/\.html?$/i.test(path)) { return pageSummary(files, path); }
	if (!/\.(md|markdown|txt)$/i.test(path)) { return path.split('/').pop() ?? path; }
	try {
		const raw = (await files.readFile(URI.file(path), { length: 8192 })).value.toString();
		return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').replace(/```[\s\S]*?```/g, '')
			.split(/\n\s*\n/).find(p => p.trim() && !/^\s*(#|!\[|<)/.test(p))?.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240) ?? '';
	} catch { return localize('dispatchLinked.unavailable', "Preview unavailable. Open the document to check the file."); }
}

/** A delivery page: its <title>, then the first point of the notes.md next to it (what `dispatch deliver` writes). */
async function pageSummary(files: IFileService, path: string): Promise<string> {
	const name = path.split('/').pop() ?? path;
	let title = '';
	try {
		const raw = (await files.readFile(URI.file(path), { length: 16384 })).value.toString();
		title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').replace(/\s+/g, ' ').trim();
	} catch { /* the file name below */ }
	let point = '';
	try {
		const notes = (await files.readFile(URI.file(path.replace(/[^/]+$/, 'notes.md')), { length: 8192 })).value.toString();
		point = (/^\s*(?:[-*]|\d+\.)\s+(.+)$/m.exec(notes)?.[1] ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').trim().slice(0, 200);
	} catch { /* no notes */ }
	return [title || name, point].filter(Boolean).join('\n');
}

/** Paths Dispatch lists in Docs for this folder (test scenarios and a page's side files are not rows of it). */
function docsPaths(commands: ICommandService, folder: string): Promise<Set<string>> {
	return cached(`docs:${folder}`, async () => {
		const ans = await commands.executeCommand<{ docs?: IDispatchDoc[] }>('dispatch.docsList', folder);
		return new Set((ans?.docs ?? []).flatMap(d => [d.path, ...(d.prototype ? [d.prototype] : [])]).map(pathKey));
	});
}

export function linkTaskDelivery(root: HTMLElement, el: HTMLElement, commands: ICommandService, files: IFileService, folder: string, task: IDispatchTask, label: (d: IDispatchDeliverable) => string, ref?: string, options: { quiet?: boolean; fallback?: string } = {}): IDisposable {
	const paths = (ref ? [ref] : task.deliverables.filter(d => d.kind === 'file' || d.kind === 'draft').map(d => d.ref)).map(pathKey).filter(p => p.startsWith('/'));
	if (!paths.length || !folder) { return toDisposable(() => { }); }
	return bind(root, el, { folder, side: 'Tasks', kind: ref ? 'delivery' : 'task', tasks: [task.id], paths, ...options, load: async () => {
		// only what Docs really lists (checked against its catalogue, cached 10 s): a test scenario on the task is not in Docs
		const inDocs = await docsPaths(commands, folder).catch(() => new Set<string>());
		const docs = new Map(task.deliverables.filter(d => (d.kind === 'file' || d.kind === 'draft') && paths.includes(pathKey(d.ref)) && inDocs.has(pathKey(d.ref)) && /\.(md|html?)$/i.test(d.ref)).map(d => [pathKey(d.ref), d]));
		return Promise.all([...docs].map(async ([path, d]) => ({ title: label(d), detail: await cached(`text:${path}`, () => excerpt(files, path)), open: () => { void commands.executeCommand('dispatch.openDoc', path, task.id); } })));
	} });
}

export function linkDocTasks(root: HTMLElement, el: HTMLElement, commands: ICommandService, folder: string, doc: IDispatchDoc, hover?: IHoverService): IDisposable {
	if (!doc.tasks.length || !folder) { return toDisposable(() => { }); }
	return bind(root, el, { folder, side: 'Docs', kind: 'doc', hover, tasks: doc.tasks.map(t => t.id), paths: [doc.path, ...(doc.prototype ? [doc.prototype] : [])], load: async () => {
		return Promise.all(doc.tasks.map(async t => {
			let detail = ({ in_progress: localize('dispatchLinked.progress', "In progress"), waiting: localize('dispatchLinked.waiting', "Waiting for you"), done: localize('dispatchLinked.done', "Done"), todo: localize('dispatchLinked.todo', "To do") } as Record<string, string>)[t.status] ?? '';
			try {
				const task = await cached(`task:${t.id}`, () => commands.executeCommand<IDispatchTask>('dispatch.tasks', { op: 'show', id: t.id, brief: true }));
				const plan = task?.plan ?? [];
				const taskDone = (task?.status ?? t.status) === 'done';
				const current = taskDone ? undefined : plan.find(p => p.state === 'active') ?? plan.find(p => p.state === 'todo');
				// "2 of 4 steps done · the step it is on": words, not a bare "0 / 4" next to empty circles
				if (plan.length) { detail = `${planProgress(plan)}${current ? ` · ${current.text}` : ''}`; }
				return { title: t.title, detail, plan, taskDone, open: () => { void commands.executeCommand('dispatch.showTask', t.id, t.title); } };
			} catch { /* The stored delivery still names its source task. */ }
			return { title: t.title, detail, open: () => { void commands.executeCommand('dispatch.showTask', t.id, t.title); } };
		}));
	} });
}
