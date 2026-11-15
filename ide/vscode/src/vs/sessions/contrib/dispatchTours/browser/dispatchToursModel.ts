/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: tips that point at the real thing (kanban task "弹窗提示引导", design/orca-study
 *  G4 and G7; patches/475-tours.patch). The rules of this file, no imports on purpose so it
 *  can be tested alone:
 *
 *  - what a tour is: one to four steps, each a bubble on a UI element (an anchor: a CSS selector,
 *    narrowed by visible text or aria-label) with a short title and one or two plain sentences
 *  - when a tour may start (the gate): never over the first-run setup, never while another tip, a
 *    dialog, a menu or What's new is up, never twice, never right after another one ended
 *  - where the bubble goes (placeBubble): beside its element on the side with room, the arrow on the
 *    element's centre, kept inside the window; over the element when it is a whole page
 *  - the progress of the Getting started checklist (the ring)
 *
 *  The gate, the step lists and the placement follow Orca's contextual tours (github.com/stablyai/orca,
 *  src/renderer/src/components/contextual-tours/contextual-tour-gate.ts and
 *  contextual-tour-floating-position.ts, src/shared/contextual-tours.ts), which is under the MIT License:
 *
 *      Copyright (c) 2026 Lovecast Inc.
 *
 *      Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *      associated documentation files (the "Software"), to deal in the Software without restriction,
 *      including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *      sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *      furnished to do so, subject to the following conditions:
 *
 *      The above copyright notice and this permission notice shall be included in all copies or
 *      substantial portions of the Software.
 *
 *      THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *      BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *      NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *      DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *      OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *--------------------------------------------------------------------------------------------*/

export type DispatchTourPlacement = 'top' | 'right' | 'bottom' | 'left';

/** Where a step's element is: a CSS selector, only the matches whose text or aria-label starts with these words. */
export interface IDispatchTourAnchor {
	readonly selector: string;
	readonly text?: string;
	readonly aria?: string;
}

export interface IDispatchTourAction {
	readonly label: string;
	/** Run this command, or (without one) click the step's element. */
	readonly command?: string;
	readonly args?: readonly unknown[];
}

export interface IDispatchTourStep {
	/** Stable, for the tests and for a step that moves. */
	readonly id: string;
	readonly title: string;
	/** One or two plain sentences: what it is, what it does for you. */
	readonly body: string;
	readonly anchor: IDispatchTourAnchor;
	readonly placement?: DispatchTourPlacement;
	/** Clicking the element itself is the real thing to do: the tip moves on (on the last step it ends). */
	readonly advanceOnClick?: boolean;
	/** A button that does the thing (Open Tasks) and ends the tour. */
	readonly action?: IDispatchTourAction;
}

export interface IDispatchTour {
	readonly id: string;
	/** The place: the tour may start while this is on screen (default: the first step's anchor). */
	readonly place?: IDispatchTourAnchor;
	/** Lower goes first when several places are on screen at once. */
	readonly order: number;
	readonly steps: readonly IDispatchTourStep[];
}

// ---------------------------------------------------------------- the gate

export type DispatchTourBlock =
	| 'disabled'
	| 'wizard'
	| 'seen'
	| 'active-tour'
	| 'cooling-down'
	| 'blocking-surface'
	| 'missing-start-target';

export type DispatchTourDecision =
	| { readonly kind: 'start'; readonly stepIndex: number }
	| { readonly kind: 'blocked'; readonly reason: DispatchTourBlock };

/** How long after a tip ends the next one waits (a person who just closed one does not want another at once). */
export const TOUR_COOLDOWN_MS = 4000;

export function tourDecision(args: {
	readonly tour: IDispatchTour;
	/** The Show tips setting. */
	readonly enabled: boolean;
	/** The first-run setup is on screen. */
	readonly wizardVisible: boolean;
	readonly seenIds: readonly string[];
	readonly activeTourId: string | null;
	/** When the last tip ended (ms since epoch), if one did. */
	readonly lastEndedAt?: number;
	readonly now: number;
	/** What covers the window now ('dialog', 'menu', ...), if something does. */
	readonly blockingSurface: string | undefined;
	readonly targetExists: (anchor: IDispatchTourAnchor) => boolean;
	/** A replay by hand ignores seen and cooldown, never the rest. */
	readonly forced?: boolean;
}): DispatchTourDecision {
	if (!args.enabled && !args.forced) {
		return { kind: 'blocked', reason: 'disabled' };
	}
	if (args.wizardVisible) {
		return { kind: 'blocked', reason: 'wizard' };
	}
	if (!args.forced && args.seenIds.includes(args.tour.id)) {
		return { kind: 'blocked', reason: 'seen' };
	}
	if (args.activeTourId !== null) {
		return { kind: 'blocked', reason: 'active-tour' };
	}
	if (!args.forced && args.lastEndedAt !== undefined && args.now - args.lastEndedAt < TOUR_COOLDOWN_MS) {
		return { kind: 'blocked', reason: 'cooling-down' };
	}
	if (args.blockingSurface) {
		return { kind: 'blocked', reason: 'blocking-surface' };
	}
	const place = args.tour.place ?? args.tour.steps[0]?.anchor;
	if (!place || !args.targetExists(place)) {
		return { kind: 'blocked', reason: 'missing-start-target' };
	}
	const first = firstVisibleStepIndex(args.tour, args.targetExists);
	return first === undefined ? { kind: 'blocked', reason: 'missing-start-target' } : { kind: 'start', stepIndex: first };
}

/** The steps whose element is on screen now, in order (a tab the person closed has no step). */
export function visibleStepIndexes(tour: IDispatchTour, targetExists: (anchor: IDispatchTourAnchor) => boolean): number[] {
	const out: number[] = [];
	tour.steps.forEach((s, i) => {
		if (targetExists(s.anchor)) {
			out.push(i);
		}
	});
	return out;
}

export function firstVisibleStepIndex(tour: IDispatchTour, targetExists: (anchor: IDispatchTourAnchor) => boolean): number | undefined {
	return visibleStepIndexes(tour, targetExists)[0];
}

export function nextVisibleStepIndex(tour: IDispatchTour, current: number, targetExists: (anchor: IDispatchTourAnchor) => boolean): number | undefined {
	return visibleStepIndexes(tour, targetExists).find(i => i > current);
}

export function previousVisibleStepIndex(tour: IDispatchTour, current: number, targetExists: (anchor: IDispatchTourAnchor) => boolean): number | undefined {
	return visibleStepIndexes(tour, targetExists).filter(i => i < current).pop();
}

/** "2 of 3": the step's place among the steps that are on screen. */
export function stepProgress(visible: readonly number[], stepIndex: number): { readonly current: number; readonly total: number } | undefined {
	const at = visible.indexOf(stepIndex);
	return at === -1 ? undefined : { current: at + 1, total: visible.length };
}

/** The tour to start now: the lowest order among those the gate lets through. */
export function pickTour(tours: readonly IDispatchTour[], decide: (tour: IDispatchTour) => DispatchTourDecision): { readonly tour: IDispatchTour; readonly stepIndex: number } | undefined {
	for (const tour of [...tours].sort((a, b) => a.order - b.order)) {
		const d = decide(tour);
		if (d.kind === 'start') {
			return { tour, stepIndex: d.stepIndex };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------- where the bubble goes

export interface IDispatchTourRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface IDispatchBubblePlacement {
	readonly left: number;
	readonly top: number;
	/** The side of the element the bubble is on; `over` when it floats free of the element (no arrow): no side has
	 *  room (a whole page), or every side would cover a control that is kept clear; `none` when nowhere in the window
	 *  keeps them clear: then the tip waits out of sight (a window too small). */
	readonly side: DispatchTourPlacement | 'over' | 'none';
	/** Where the arrow sits along the bubble's edge (px from its left or top); undefined for `over`. */
	readonly arrowOffset: number | undefined;
}

export const BUBBLE_GAP = 12;
export const BUBBLE_MARGIN = 12;
const ARROW_PADDING = 18;

const FALLBACKS: Record<DispatchTourPlacement, readonly DispatchTourPlacement[]> = {
	top: ['bottom', 'right', 'left'],
	right: ['left', 'bottom', 'top'],
	bottom: ['top', 'right', 'left'],
	left: ['right', 'bottom', 'top'],
};

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

/**
 * The bubble beside `target` on the preferred side, or the first other side with room, slid along that side
 * to stay inside the window; when no side has room it covers the target near its top.
 *
 * It never covers a `keepClear` rect (the message box and its buttons, see KEEP_CLEAR): a target inside one is
 * widened to it (the tip points at the whole box from outside), a side that would cover one slides past it or
 * gives way to the next side, and when no side can, the bubble floats at the nearest free spot without an arrow,
 * or, when the window has none, is not shown (`none`). It used to fall back to the first side, on the box
 * (kanban task-lj06.21, the third time a tip sat on the message box).
 */
export function placeBubble(target: IDispatchTourRect, size: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, preferred: DispatchTourPlacement = 'bottom', keepClear: readonly IDispatchTourRect[] = []): IDispatchBubblePlacement {
	target = keepClear.filter(r => overlaps(target, r)).reduce(union, target);
	const cx = target.left + target.width / 2;
	const cy = target.top + target.height / 2;
	const fits = (side: DispatchTourPlacement): boolean => {
		switch (side) {
			case 'bottom': return target.top + target.height + BUBBLE_GAP + size.height <= viewport.height - BUBBLE_MARGIN;
			case 'top': return target.top - BUBBLE_GAP - size.height >= BUBBLE_MARGIN;
			case 'right': return target.left + target.width + BUBBLE_GAP + size.width <= viewport.width - BUBBLE_MARGIN;
			case 'left': return target.left - BUBBLE_GAP - size.width >= BUBBLE_MARGIN;
		}
	};
	const sides = [preferred, ...FALLBACKS[preferred]].filter(fits);
	const maxLeft = Math.max(BUBBLE_MARGIN, viewport.width - size.width - BUBBLE_MARGIN);
	const maxTop = Math.max(BUBBLE_MARGIN, viewport.height - size.height - BUBBLE_MARGIN);
	// a control the person may want to click right now (a tab, a switch, the message box) stays uncovered: the bubble
	// slides along its side past it while its arrow can still point at the element, else another side is tried (task-5k8a)
	const blocked = (left: number, top: number) => keepClear.some(r => overlaps({ left, top, width: size.width, height: size.height }, r));
	if (!sides.length) {
		const left = clamp(cx - size.width / 2, BUBBLE_MARGIN, maxLeft);
		const top = clamp(target.top + 24, BUBBLE_MARGIN, maxTop);
		return blocked(left, top) ? free(left, top) : { left, top, side: 'over', arrowOffset: undefined };
	}
	let first: IDispatchBubblePlacement | undefined;
	for (const side of sides) {
		const at = sideAt(side);
		first ??= at;
		if (!blocked(at.left, at.top)) {
			return at;
		}
		const vertical = side === 'left' || side === 'right';
		const along = vertical ? at.top : at.left;
		const length = vertical ? size.height : size.width;
		const [lo, hi] = vertical ? [target.top, target.top + target.height] : [target.left, target.left + target.width];
		const max = vertical ? maxTop : maxLeft;
		const candidates = keepClear.flatMap(r => vertical ? [r.top + r.height + BUBBLE_GAP, r.top - BUBBLE_GAP - size.height] : [r.left + r.width + BUBBLE_GAP, r.left - BUBBLE_GAP - size.width])
			.filter(v => v >= BUBBLE_MARGIN && v <= max)
			// the arrow still reaches the element: the bubble's edge and the element share a stretch
			.filter(v => Math.min(v + length - ARROW_PADDING, hi) - Math.max(v + ARROW_PADDING, lo) >= 0)
			.filter(v => !blocked(vertical ? at.left : v, vertical ? v : at.top))
			.sort((a, b) => Math.abs(a - along) - Math.abs(b - along));
		if (candidates.length) {
			const v = candidates[0];
			const centre = vertical ? cy : cx;
			const point = clamp(centre, Math.max(lo, v + ARROW_PADDING), Math.min(hi, v + length - ARROW_PADDING));
			return vertical
				? { left: at.left, top: v, side, arrowOffset: clamp(point - v, ARROW_PADDING, length - ARROW_PADDING) }
				: { left: v, top: at.top, side, arrowOffset: clamp(point - v, ARROW_PADDING, length - ARROW_PADDING) };
		}
	}
	return free(first!.left, first!.top);

	/** The spot nearest (left, top) that covers no kept-clear rect, floating without an arrow; `none` when there is none. */
	function free(left: number, top: number): IDispatchBubblePlacement {
		// every edge a kept-clear rect gives, and the window's own: the nearest free spot touches one of them
		const xs = [left, BUBBLE_MARGIN, maxLeft, ...keepClear.flatMap(r => [r.left + r.width + BUBBLE_GAP, r.left - BUBBLE_GAP - size.width])]
			.filter(v => v >= BUBBLE_MARGIN && v <= maxLeft);
		const ys = [top, BUBBLE_MARGIN, maxTop, ...keepClear.flatMap(r => [r.top + r.height + BUBBLE_GAP, r.top - BUBBLE_GAP - size.height])]
			.filter(v => v >= BUBBLE_MARGIN && v <= maxTop);
		let best: { left: number; top: number; d: number } | undefined;
		for (const x of xs) {
			for (const y of ys) {
				const d = Math.hypot(x - left, y - top);
				if ((!best || d < best.d) && !blocked(x, y)) {
					best = { left: x, top: y, d };
				}
			}
		}
		return best ? { left: best.left, top: best.top, side: 'over', arrowOffset: undefined } : { left, top, side: 'none', arrowOffset: undefined };
	}

	function sideAt(side: DispatchTourPlacement): IDispatchBubblePlacement {
		if (side === 'top' || side === 'bottom') {
			const left = clamp(cx - size.width / 2, BUBBLE_MARGIN, maxLeft);
			return {
				left,
				top: side === 'bottom' ? target.top + target.height + BUBBLE_GAP : target.top - BUBBLE_GAP - size.height,
				side,
				arrowOffset: clamp(cx - left, ARROW_PADDING, size.width - ARROW_PADDING),
			};
		}
		const top = clamp(cy - size.height / 2, BUBBLE_MARGIN, maxTop);
		return {
			left: side === 'right' ? target.left + target.width + BUBBLE_GAP : target.left - BUBBLE_GAP - size.width,
			top,
			side,
			arrowOffset: clamp(cy - top, ARROW_PADDING, size.height - ARROW_PADDING),
		};
	}
}

export function overlaps(a: IDispatchTourRect, b: IDispatchTourRect): boolean {
	return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function union(a: IDispatchTourRect, b: IDispatchTourRect): IDispatchTourRect {
	const left = Math.min(a.left, b.left);
	const top = Math.min(a.top, b.top);
	return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
}

/**
 * What a tip, What's new and any other card that shows by itself never covers (task-5k8a, task-lj06.21): every
 * message box with the controls in and around it (the agent, model and permission chips, Turbo, send, the notice
 * above the box). Whole boxes, not single buttons: a list of single
 * controls let a tip land on the box itself three times (the start page's agent picker, the notice, then a session's
 * box with its agent chip).
 */
export const KEEP_CLEAR = [
	// a session's message box: the input, its toolbars and chips, the attachments and the notice above it
	'.interactive-input-part',
	// the new-session page's box and the row of switches under it (Full auto, Separate copy, Turbo)
	'.new-chat-input-container', '.new-chat-input-area', '.new-chat-bottom-container',
	'.sessions-chat-session-type-picker', '.chat-input-notification-widget',
];

export function sameRect(a: IDispatchTourRect | undefined, b: IDispatchTourRect | undefined): boolean {
	return !!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

// ---------------------------------------------------------------- what is remembered

/** A list of ids kept as JSON in storage: anything else reads as empty. */
export function parseIdList(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

export function withId(ids: readonly string[], id: string): string[] {
	return ids.includes(id) ? [...ids] : [...ids, id];
}

// ---------------------------------------------------------------- the checklist

export interface IDispatchChecklistProgress {
	readonly done: number;
	readonly total: number;
	readonly complete: boolean;
	/** The ring: its length (2 pi r) and how much of it is drawn. */
	readonly circumference: number;
	readonly drawn: number;
}

export function checklistProgress(itemIds: readonly string[], doneIds: readonly string[], radius = 7): IDispatchChecklistProgress {
	const total = itemIds.length;
	const done = itemIds.filter(id => doneIds.includes(id)).length;
	const circumference = 2 * Math.PI * radius;
	return { done, total, complete: total > 0 && done === total, circumference, drawn: total === 0 ? 0 : circumference * done / total };
}
