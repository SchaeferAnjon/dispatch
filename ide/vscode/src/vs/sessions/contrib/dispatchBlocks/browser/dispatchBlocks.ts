/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Dispatch's block symbols and seven motions, one shared module (patches/
 *  050-blocks.patch; kanban design/identity/bold A4 and A5). Every page of ours uses these
 *  instead of drawing its own:
 *
 *  Static symbols are product icons from Dispatch's font (media/dispatch-blocks.ttf, drawn by
 *  make-blocks-font.py): `DispatchBlockIcons.folder`, `$(dispatch-working)` in a label, or the class
 *  `codicon codicon-dispatch-<name>`. The seven state glyphs carry their colour.
 *
 *    states   working, waiting, done, handoff, stopped, todo, sub-agent, step-now
 *    things   assistant, task, plan, delivery, delivery-new, pass-on
 *    devices  macbook, mac-mini, iphone
 *    places   folder, automations, chats, knowledge, settings, editor, new, plus, search, filter,
 *             sidebar, right-panel, theme, permission, branch, send, stop, open, claude
 *
 *  The seven motions (DESIGN.md's three curves only; reduced motion keeps all of them still):
 *    1 done        stateBlock('done', { play: true })      the block fills, the check draws itself
 *    2 working     stateBlock('working', { breathe: true }) or breathe(el): one clock for all
 *    3 waiting     knock(el)                                two small lifts, three times, then still
 *    4 delivery    arrive(list, newRow), rollCount(el, n)  drops in, the rest slide down, the count rolls
 *    5 handoff     handoffTravel(fromEl, toEl), handoffLine(text)
 *    6 phone       linkMark() / setLinkState(el, 'connecting' | 'connected' | 'off')
 *    7 the app's mark assistantMark(size, place, state)      the Dock's icon: drops in (落块), knocks, breathes, waves
 *                     (named after the Assistant, whose mark it was until 2026-11-11; now the empty side pane's logo)
 *
 *  and engineBlock(icon): an engine's mark in a small rounded block (the input box, the Now tab).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchBlocks.css';
import './media/dispatchBlockGlyphs.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { DISPATCH_BLOCK_GLYPHS, type DispatchBlockGlyph } from './dispatchBlockGlyphs.js';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';
import { DISPATCH_ICON_DROP } from '../../../../base/common/dispatchIcon.js';
import { dispatchIconDrop, dispatchIconElement, type IDispatchIconDrop } from '../../../../base/browser/dispatchIcon.js';

export { DISPATCH_BLOCK_GLYPHS, type DispatchBlockGlyph };

// every state colour here is the app icon's (--dispatch-state-*, base/common/dispatchPalette.ts)
ensureDispatchPalette();

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Every glyph as a product icon, `dispatch-<name>` (the codicon fallback only shows if the font fails). */
export const DispatchBlockIcons: Readonly<Record<DispatchBlockGlyph, ThemeIcon>> = Object.fromEntries(
	DISPATCH_BLOCK_GLYPHS.map(name => [name, registerIcon(`dispatch-${name}`, Codicon.circleSmallFilled, localize('dispatchBlockIcon', "Dispatch symbol: {0}", name))])
) as Record<DispatchBlockGlyph, ThemeIcon>;

/** The states a block can say. `step-now` and `step-done` are a plan's steps (purple, the plan's colour). */
export type DispatchBlockState = 'working' | 'waiting' | 'done' | 'handoff' | 'stopped' | 'todo' | 'sub-agent' | 'step-now' | 'step-done';

/** What a state is called, for hovers and screen readers. */
export const DISPATCH_STATE_LABEL: Readonly<Record<DispatchBlockState, string>> = {
	'working': localize('dispatchState.working', "Working"),
	'waiting': localize('dispatchState.waiting', "Waiting for you"),
	'done': localize('dispatchState.done', "Done"),
	'handoff': localize('dispatchState.handoff', "Handed over to a fresh session"),
	'stopped': localize('dispatchState.stopped', "Stopped, needs a look"),
	'todo': localize('dispatchState.todo', "Not started"),
	'sub-agent': localize('dispatchState.sub', "Sub-agent working for this session"),
	'step-now': localize('dispatchState.stepNow', "Doing this step now"),
	'step-done': localize('dispatchState.stepDone', "Step done"),
};

const MARKS: Partial<Record<DispatchBlockState, string>> = {
	'done': 'M5.2 8.3l1.9 1.9 3.7-3.9',
	'step-done': 'M5.2 8.3l1.9 1.9 3.7-3.9',
	'handoff': 'M5 8h5.6M8.6 5.8L10.8 8l-2.2 2.2',
	'stopped': 'M5.4 8h5.2',
};

let maskSeq = 0;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, parent?: Element): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		e.setAttribute(k, v);
	}
	parent?.appendChild(e);
	return e;
}

export interface IStateBlockOptions {
	/** Size in px (12, 14, 16, 20, 24); default 14. */
	readonly size?: number;
	/** Play the done motion once (done, step-done): the block fills in and the check draws itself. */
	readonly play?: boolean;
	/** Breathe while working (working, sub-agent); step-now always breathes its inner block. */
	readonly breathe?: boolean;
	/** Knock three times (waiting), as when it first shows up. */
	readonly knock?: boolean;
	/** Hover text; default the state's name. Pass '' for none. */
	readonly title?: string;
}

/**
 * One state as one block (the SVG twin of the state glyphs): the colour is the state and the mark cut
 * out of it says it again (dot: waiting, check: done, arrow: handed over, dash: stopped).
 */
export function stateBlock(state: DispatchBlockState, options: IStateBlockOptions = {}): HTMLElement {
	const size = options.size ?? 14;
	const host = document.createElement('span');
	host.className = `dispatch-block ${state}`;
	host.setAttribute('role', 'img');
	const title = options.title ?? DISPATCH_STATE_LABEL[state];
	if (title) {
		host.setAttribute('aria-label', title);
		host.title = title;
	} else {
		host.setAttribute('aria-hidden', 'true');
	}
	const svg = svgEl('svg', { width: String(size), height: String(size), viewBox: '0 0 16 16' }, host);
	if (state === 'todo') {
		svgEl('rect', { x: '2.75', y: '2.75', width: '10.5', height: '10.5', rx: '3.2', class: 'ol' }, svg);
	} else if (state === 'step-now') {
		svgEl('rect', { x: '2.75', y: '2.75', width: '10.5', height: '10.5', rx: '3.2', class: 'ol' }, svg);
		svgEl('rect', { x: '5.4', y: '5.4', width: '5.2', height: '5.2', rx: '1.5', class: 'pin' }, svg);
		breathe(host);
	} else if (state === 'sub-agent') {
		svgEl('rect', { x: '3', y: '3', width: '10', height: '10', rx: '3', class: 'b' }, svg);
	} else {
		const block: Record<string, string> = { x: '2', y: '2', width: '12', height: '12', rx: '3.6', class: 'b' };
		const mark = MARKS[state];
		if (mark || state === 'waiting') {
			// the mark is cut out of the block, so the row behind shows through it on any background
			const id = `dispatch-block-mask-${++maskSeq}`;
			const mask = svgEl('mask', { id, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '16', height: '16' }, svgEl('defs', {}, svg));
			svgEl('rect', { x: '0', y: '0', width: '16', height: '16', fill: '#fff' }, mask);
			if (mark) {
				svgEl('path', { d: mark, class: 'mk' }, mask);
			} else {
				svgEl('circle', { cx: '8', cy: '8', r: '1.9', class: 'mkd' }, mask);
			}
			block.mask = `url(#${id})`;
		}
		svgEl('rect', block, svg);
	}
	if (options.play && (state === 'done' || state === 'step-done')) {
		host.classList.add('play-done');
	}
	if (options.breathe && (state === 'working' || state === 'sub-agent')) {
		host.classList.add('breathe');
		breathe(host);
	}
	if (options.knock && state === 'waiting') {
		knock(host);
	}
	return host;
}

// ---------------------------------------------------------------- 2 working: one clock

const BREATH_ROUND_MS = 4800; // 2.4s each way

/**
 * Starts `el` breathing in step with every other breath on screen (a busy list stays calm): the CSS
 * animation's delay is set from a shared clock. `el` itself breathes when it has `.dispatch-breathe`;
 * a stateBlock's inner block reads the same delay.
 */
export function breathe(el: HTMLElement, self = false): HTMLElement {
	const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) % BREATH_ROUND_MS;
	el.style.setProperty('--dispatch-breath-delay', `-${Math.round(t)}ms`);
	if (self) {
		el.classList.add('dispatch-breathe');
	}
	return el;
}

// ---------------------------------------------------------------- 3 waiting: the knock

/** Two 2px lifts, three times 4s apart, then still. Call when a waiting thing first shows up. */
export function knock(el: HTMLElement): void {
	el.classList.remove('dispatch-knock');
	void el.offsetWidth; // restart
	el.classList.add('dispatch-knock');
	el.addEventListener('animationend', () => el.classList.remove('dispatch-knock'), { once: true });
}

// ---------------------------------------------------------------- 4 a delivery arriving

/**
 * `row` (already the first child of `list`) drops in with a fade while the rows after it slide down
 * from where they were, instead of jumping. Call right after inserting it.
 */
export function arrive(list: HTMLElement, row: HTMLElement): void {
	const h = row.offsetHeight + parseFloat(getComputedStyle(row).marginTop || '0');
	row.classList.remove('dispatch-arrive');
	void row.offsetWidth;
	row.classList.add('dispatch-arrive');
	row.addEventListener('animationend', () => row.classList.remove('dispatch-arrive'), { once: true });
	if (isStill(list)) {
		return;
	}
	for (let n = row.nextElementSibling as HTMLElement | null; n; n = n.nextElementSibling as HTMLElement | null) {
		n.animate([{ transform: `translateY(-${h}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
	}
}

/** Sets a count, rolling the new number up into place when it changed. */
export function rollCount(el: HTMLElement, value: string): void {
	if (el.textContent === value) {
		return;
	}
	const had = !!el.textContent;
	el.textContent = '';
	const span = document.createElement('span');
	span.textContent = value;
	if (had) {
		span.className = 'dispatch-roll';
	}
	el.appendChild(span);
}

// ---------------------------------------------------------------- 5 handoff

/**
 * A blue block travels from `from` (the old session) to `to` (the fresh one) in 200ms; the old one
 * dims, the new one gets one ring. Both stay in the DOM; nothing is moved.
 */
export function handoffTravel(from: HTMLElement, to: HTMLElement): void {
	from.classList.add('dispatch-handoff-from');
	to.classList.remove('dispatch-handoff-ring');
	void to.offsetWidth;
	to.classList.add('dispatch-handoff-ring');
	setTimeout(() => to.classList.remove('dispatch-handoff-ring'), 900);
	if (isStill(from)) {
		return;
	}
	const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
	const doc = from.ownerDocument;
	const block = doc.createElement('i');
	block.className = 'dispatch-handoff-traveller';
	block.style.left = `${a.left + a.width / 2 - 5}px`;
	block.style.top = `${a.top + a.height / 2 - 5}px`;
	doc.body.appendChild(block);
	void block.offsetWidth;
	block.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
	setTimeout(() => block.remove(), 220);
}

/** The handoff line in a conversation: a thin rule, the two sessions as hollow blocks and a blue one carried across. */
export function handoffLine(text: string): HTMLElement {
	const line = document.createElement('div');
	line.className = 'dispatch-handoff-line';
	const track = document.createElement('span');
	track.className = 'dispatch-handoff-track';
	track.setAttribute('aria-hidden', 'true');
	track.append(document.createElement('i'), document.createElement('i'), document.createElement('b'));
	const words = document.createElement('span');
	words.textContent = text;
	line.append(track, words);
	return line;
}

// ---------------------------------------------------------------- 6 a phone connecting

export type DispatchLinkState = 'connecting' | 'connected' | 'off';

/** Three blocks that light in turn while a device connects, then join into a line. `small`: for a title bar. */
export function linkMark(state: DispatchLinkState = 'connecting', small = false): HTMLElement {
	const el = document.createElement('span');
	el.className = `dispatch-link${small ? ' small' : ''}`;
	el.setAttribute('aria-hidden', 'true');
	el.append(document.createElement('i'), document.createElement('i'), document.createElement('i'), document.createElement('b'));
	setLinkState(el, state);
	return el;
}

export function setLinkState(el: HTMLElement, state: DispatchLinkState): void {
	el.classList.toggle('connecting', state === 'connecting');
	el.classList.toggle('connected', state === 'connected');
}

/** The green dot a device gets once it is connected (it pops in). */
export function onlineDot(on: boolean): HTMLElement {
	const dot = document.createElement('span');
	dot.className = 'dispatch-online-dot';
	dot.setAttribute('aria-hidden', 'true');
	if (on) {
		requestAnimationFrame(() => dot.classList.add('on'));
	}
	return dot;
}

// ---------------------------------------------------------------- 7 the Assistant's mark

/** What the Assistant's mark says: how many things wait, work and were delivered, and whether it is looking. */
export interface IAssistantMarkState {
	readonly waiting?: number;
	readonly working?: number;
	readonly delivered?: number;
	/** The Assistant is looking (or the page is loading): the blocks lift in a diagonal wave. */
	readonly think?: boolean;
}

/** Each state's block in the icon: waiting the amber square, working the green one, delivered the teal card. */
const MARK_STATE_BLOCK = { waiting: 1, working: 2, delivered: 6 } as const;
/** A mark drawn again this soon after its place's first drop carries the drop on (the last block lands at about
 *  2.6s: 9 x 220ms, then its fall and two bounces); later it stands formed. */
const MARK_INTRO_MS = 3000;
/** A block that drops again lands within this (its fall and two bounces): a mark drawn again sooner carries it on. */
const MARK_AGAIN_MS = 1000;
/** What each place's mark said last, when its first drop started and when a block last started to drop again, so a
 *  mark drawn again (the home draws itself afresh when a count changes) carries on the drops where they are and then
 *  drops only the blocks whose count went up. */
const markMemory = new Map<string, { state: IAssistantMarkState; introAt: number; again: Map<number, number> }>();
/** Each mark's drop (base/browser/dispatchIcon.ts). */
const markDrops = new WeakMap<HTMLElement, IDispatchIconDrop>();

/**
 * The Assistant's mark: the app's logo, the Dock's ten blocks and its own green dot with the cream centre, in a glow
 * (laid out by base/common/dispatchIcon.ts; preference「logo 处处同应用图标」). `place` names where it is drawn
 * ('sidebar', 'home'): the first mark of a place in a window drops in block by block as design/icon-motion's 落块
 * does (base/common/dispatchIcon.ts: bottom row first, 220ms apart, falling in from the box's top and bouncing
 * twice), and the dot shows when the last block has landed, then breathes; a mark drawn there again stands formed,
 * and the block of a state whose count went up (a new delivery: the teal card) drops in once more. Waiting: the
 * amber block knocks three times; `think`: the blocks lift in a diagonal wave. Reduced motion: the icon, formed and
 * still.
 */
export function assistantMark(size: number, place: string, state: IAssistantMarkState = {}): HTMLElement {
	const host = document.createElement('span');
	host.className = 'dispatch-assistant-mark';
	host.dataset.place = place;
	host.setAttribute('aria-hidden', 'true');
	const svg = host.appendChild(dispatchIconElement(size, { ghosts: true, mark: true }));
	// before the mark is in the page, the workbench's own reduced motion class says it
	const still = () => isStill(host) || !!host.ownerDocument.querySelector('.monaco-workbench.monaco-reduce-motion');
	const drop = dispatchIconDrop(svg, still, {
		onFormed: () => {
			if (!host.classList.contains('lit')) {
				host.classList.add('lit');
			}
		},
	});
	markDrops.set(host, drop);
	const now = Date.now();
	const last = markMemory.get(place);
	if (!last) {
		markMemory.set(place, { state: {}, introAt: now, again: new Map() });
	}
	const into = now - (last?.introAt ?? now);
	if (into < MARK_INTRO_MS && !still()) {
		// the first drop, or a mark drawn again while it runs: carry on from where it is
		drop.hideAll();
		requestAnimationFrame(() => drop.drop(DISPATCH_ICON_DROP.order, { elapsedMs: into }));
	} else {
		host.classList.add('lit');
		// a block that started to drop again on the mark this one replaces: carry it on
		for (const [i, at] of last?.again ?? []) {
			if (now - at < MARK_AGAIN_MS && !still()) {
				drop.drop([i], { elapsedMs: now - at });
			}
		}
	}
	setAssistantMarkState(host, state, last?.state);
	return host;
}

/** Updates a mark in place: what it says now, and a drop for each state whose count went up since `before`. */
export function setAssistantMarkState(mark: HTMLElement, state: IAssistantMarkState, before: IAssistantMarkState | undefined = markMemory.get(mark.dataset.place ?? '')?.state): void {
	const drop = markDrops.get(mark);
	for (const key of ['waiting', 'working', 'delivered'] as const) {
		const was = before?.[key];
		const now = state[key] ?? 0;
		// only a count Dispatch knew before and that went up: the first answer after a reload drops nothing
		if (drop && typeof was === 'number' && now > was) {
			drop.drop([MARK_STATE_BLOCK[key]]);
			markMemory.get(mark.dataset.place ?? '')?.again.set(MARK_STATE_BLOCK[key], Date.now());
		}
	}
	mark.classList.toggle('waiting', !!state.waiting);
	mark.classList.toggle('working', !!state.working);
	mark.classList.toggle('delivered', !!state.delivered);
	mark.classList.toggle('think', !!state.think);
	breathe(mark);
	const memory = mark.dataset.place ? markMemory.get(mark.dataset.place) : undefined;
	if (memory) {
		// a count not known yet (the page still loading) stays unknown, so its first answer drops nothing
		memory.state = { waiting: state.waiting, working: state.working, delivered: state.delivered };
	}
}

/** Forgets what a place's mark said, so its next mark drops in from the start (the showcase replays it). */
export function resetAssistantMark(place: string): void {
	markMemory.delete(place);
}

// ---------------------------------------------------------------- engines

/** An engine's mark (`$(claude)`, `$(openai)`, `$(dispatch-opencode)`…) in a small rounded block: the engine's avatar. */
export function engineBlock(icon: ThemeIcon, title?: string): HTMLElement {
	const host = document.createElement('span');
	host.className = 'dispatch-engine-block';
	const i = document.createElement('span');
	i.className = ThemeIcon.asClassName(icon);
	host.appendChild(i);
	if (title) {
		host.title = title;
		host.setAttribute('aria-label', title);
	} else {
		host.setAttribute('aria-hidden', 'true');
	}
	return host;
}

// ---------------------------------------------------------------- helpers

/** Whether motion is off for `el` (accessibility.reduceMotion, which follows the Mac's setting by default). */
export function isStill(el: Element): boolean {
	const win = el.ownerDocument.defaultView;
	return !!el.closest('.monaco-reduce-motion') || !!win?.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
