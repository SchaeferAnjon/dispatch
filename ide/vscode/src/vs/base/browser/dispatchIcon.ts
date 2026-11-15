/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the app icon as an SVG element, and its blocks' drop run on it (the layout, the drawing and the
 *  design's numbers are base/common/dispatchIcon.ts).
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../common/lifecycle.js';
import { DISPATCH_ICON_DROP, dispatchIconRound, dispatchDropStart, dispatchDropStep, dispatchIconNodes, type IDispatchDropState, type IDispatchIconNode, type IDispatchIconSvgOptions } from '../common/dispatchIcon.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The icon (dispatchIconNodes) as an element in `doc`; the device's pixel ratio is the window's unless given. The dot's
 * breath is CSS: in the workbench base/browser/dispatchPalette.ts installs it, the loading splash writes its own (this
 * module loads before the workbench, so it imports nothing of the DOM helpers).
 */
export function dispatchIconElement(size: number, opts: IDispatchIconSvgOptions = {}, doc: Document = document): SVGSVGElement {
	const make = (n: IDispatchIconNode): Node => {
		if (n.tag === '#text') {
			return doc.createTextNode(n.attrs.text);
		}
		const el = doc.createElementNS(SVG_NS, n.tag);
		for (const [k, v] of Object.entries(n.attrs)) {
			if (k !== 'xmlns') {
				el.setAttribute(k, v);
			}
		}
		n.children?.forEach(c => el.appendChild(make(c)));
		return el;
	};
	const dpr = opts.dpr ?? doc.defaultView?.devicePixelRatio ?? 1;
	return make(dispatchIconNodes(size, { ...opts, dpr })) as SVGSVGElement;
}

export interface IDispatchIconDrop extends IDisposable {
	/** Drop these blocks (indices into DISPATCH_ICON_BLOCKS) one after another, `gapMs` apart; `elapsedMs` already
	 *  passed (a drawing made again in the middle of a drop carries on where it was). A block that is still
	 *  falling is left to land. */
	drop(blocks: readonly number[], opts?: { gapMs?: number; elapsedMs?: number }): void;
	/** Hide every block (and show the empty slots): the drawing waits for its drop. */
	hideAll(): void;
	/** Every block in its place at once, nothing falling. */
	formAll(): void;
	/** Whether a block is falling or waiting to. */
	readonly running: boolean;
}

/**
 * Runs the drop on a drawing from dispatchIconElement: each block falls by the design's numbers, scaled from its 22px
 * block to this drawing's (`translate(0 y)` on its rect, readable in the DOM), its empty slot goes when it has landed.
 * `still()`: reduced motion, the blocks are in place at once. `onLanded` runs for each block that lands, `onFormed`
 * when the last one has (the dot lights then).
 */
export function dispatchIconDrop(svg: SVGSVGElement, still: () => boolean, on: { onLanded?(i: number): void; onFormed?(): void } = {}): IDispatchIconDrop {
	const win = svg.ownerDocument.defaultView!;
	const blk = new Map<number, SVGRectElement>();
	svg.querySelectorAll<SVGRectElement>('rect.blk').forEach(r => blk.set(Number(r.dataset.i), r));
	const ghost = new Map<number, SVGRectElement>();
	svg.querySelectorAll<SVGRectElement>('rect.ghost').forEach(r => ghost.set(Number(r.dataset.i), r));
	const first = blk.get(0)!;
	const scale = () => Number(first.getAttribute('width')) / DISPATCH_ICON_DROP.block;
	/** The blocks queued or falling: when each starts (ms after `t0`) and where it is. */
	let queue: { i: number; at: number; s?: IDispatchDropState }[] = [];
	let t0 = 0;
	let last = 0;
	let frame = 0;

	const show = (i: number, y: number | undefined) => {
		const r = blk.get(i)!;
		if (y === undefined) {
			r.setAttribute('visibility', 'hidden');
			r.removeAttribute('transform');
			ghost.get(i)?.removeAttribute('visibility');
			return;
		}
		r.removeAttribute('visibility');
		if (y === 0) {
			r.removeAttribute('transform');
		} else {
			r.setAttribute('transform', `translate(0 ${Math.round(y * scale() * 100) / 100})`);
		}
	};
	const land = (i: number) => {
		show(i, 0);
		ghost.get(i)?.setAttribute('visibility', 'hidden');
		on.onLanded?.(i);
	};
	const finish = () => {
		svg.classList.remove('dropping');
		on.onFormed?.();
	};
	/** Moves the drop on to `now` (ms after t0) by frames of `dt`. */
	const advance = (now: number, dt: number) => {
		for (const q of queue) {
			// the design: a block starts in the frame after its time has come, and moves in that frame already
			if (!q.s && now > q.at) {
				q.s = dispatchDropStart(q.i);
			}
			if (q.s && !q.s.done) {
				dispatchDropStep(q.s, dt);
				if (q.s.done) {
					land(q.i);
				} else {
					show(q.i, q.s.y);
				}
			}
		}
		const before = queue.length;
		queue = queue.filter(q => !q.s?.done);
		if (before && !queue.length) {
			finish();
		}
	};
	const tick = (time: number) => {
		frame = 0;
		const dt = Math.max(0, time - last);
		last = time;
		advance(time - t0, dt);
		svg.dataset.dropAt = String(time); // the frame the blocks stand at now (read by e2e: icon-fall.mjs)
		if (queue.length) {
			frame = win.requestAnimationFrame(tick);
		}
	};
	const stop = () => {
		if (frame) {
			win.cancelAnimationFrame(frame);
			frame = 0;
		}
	};
	const formAll = () => {
		stop();
		const had = queue.length > 0;
		queue = [];
		blk.forEach((_, i) => land(i));
		if (had) {
			finish();
		}
	};
	return {
		get running() { return queue.length > 0; },
		drop(blocks, opts = {}) {
			if (still()) {
				blocks.forEach(i => land(i));
				on.onFormed?.();
				return;
			}
			const gap = opts.gapMs ?? DISPATCH_ICON_DROP.gapMs;
			const now = win.performance.now();
			if (!queue.length) {
				t0 = now - (opts.elapsedMs ?? 0);
				last = now;
				svg.dataset.dropAt = String(now);
			}
			const from = now - t0 - (opts.elapsedMs ?? 0);
			for (const [k, i] of blocks.entries()) {
				if (queue.some(q => q.i === i && q.s && !q.s.done)) {
					continue;
				}
				queue = queue.filter(q => q.i !== i);
				queue.push({ i, at: from + k * gap });
				show(i, undefined);
			}
			svg.classList.add('dropping');
			// time already passed: the frames it would have had, at 60 a second
			for (let t = from; t < now - t0; t += 1000 / 60) {
				advance(t, 1000 / 60);
			}
			if (queue.length && !frame) {
				frame = win.requestAnimationFrame(tick);
			}
		},
		hideAll() {
			stop();
			queue = [];
			blk.forEach((_, i) => show(i, undefined));
		},
		formAll,
		dispose: () => stop(),
	};
}

/**
 * The drop over and over, as a session row's icon shows a running session (design/icon-motion's 落块 as it is,
 * user 2026-11-15, task-dw425): the ten blocks fall 220ms apart, the full icon stays DISPATCH_ICON_DROP.restMs, the
 * grid empties and the next round falls. Every running icon in a window keeps the same clock (the row, the title bar
 * and the Now tab show the same moment); one made in the middle of a round starts where the round is. The drawing
 * must not clip its blocks: they start above it, the design's height scaled to its blocks.
 */
export function dispatchIconRounds(svg: SVGSVGElement): IDisposable {
	const win = svg.ownerDocument.defaultView!;
	const R = dispatchIconRound();
	let epoch = roundEpochs.get(win);
	if (epoch === undefined) {
		epoch = win.performance.now();
		roundEpochs.set(win, epoch);
	}
	const start = epoch;
	const drop = dispatchIconDrop(svg, () => false);
	let next = 0;
	const round = () => {
		const into = (win.performance.now() - start) % R.roundMs;
		drop.hideAll();
		if (into < R.dropMs) {
			drop.drop(DISPATCH_ICON_DROP.order, { elapsedMs: into });
		} else {
			drop.formAll();
		}
		next = win.setTimeout(round, R.roundMs - into);
	};
	round();
	return {
		dispose: () => {
			win.clearTimeout(next);
			drop.dispose();
		},
	};
}

/** When each window's running icons started their rounds (dispatchIconRounds). */
const roundEpochs = new WeakMap<object, number>();
