/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a selection across table cells and pictures painted line by line (830-markdown-editor.patch). editor.ts calls repaintSelectionPerLine.
 *--------------------------------------------------------------------------------------------*/

import type { EditorModel, EditorView } from '@vscode/markdown-editor';
import { autorun, type IDisposable, type IObservable } from '@vscode/observables';

/*
 * Dispatch: the selection layer of `@vscode/markdown-editor` outlines the selected lines as one
 * vertical stack per group (right edges down, left edges up). Table cells put several lines side by
 * side, so a selection across a table became one polygon that swallowed the images and spilled into
 * the neighbouring cells; the gap fillers between rows and the rects of image-only blocks were
 * painted on top of the images as well. When the package's path covers an image or the selection
 * has lines side by side, repaint the path here: one rect per selected line, images left out, each column of lines
 * outlined on its own. Other selections keep the package's own path.
 */

interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface SourceRun { readonly sourceStart: number; readonly sourceEndExclusive: number }
interface SourceLine {
	readonly runs: readonly SourceRun[];
	readonly rect: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly height: number };
	xAtOffset(offset: number): number;
}
interface SelectionBlock {
	readonly absoluteStart: number;
	readonly block: { readonly length: number };
	readonly viewportClip?: { readonly left: number; readonly right: number };
}
interface PackageInternals {
	/** `rendering` holds the rects the package painted, in overlay coordinates. */
	readonly _selectionView?: { readonly element: SVGSVGElement; readonly rendering: IObservable<unknown> };
	readonly _selectionBlocksObs?: IObservable<readonly SelectionBlock[]>;
	readonly measuredLayout: { readonly visualLineMap: IObservable<{ readonly sourceLines: readonly SourceLine[] }> };
	readonly coordinateSpace: { capture(): { toLocalRect(rect: DOMRect): { left: number; top: number; width: number; height: number } } };
}

const HARD_BREAK_EXTRA = 0.4;
const RADIUS = 4;

export function repaintSelectionPerLine(model: EditorModel, view: EditorView): IDisposable | undefined {
	const internals = view as unknown as PackageInternals;
	const layer = internals._selectionView;
	const blocksObs = internals._selectionBlocksObs;
	const path = layer?.element.querySelector('.md-selection-path');
	if (!layer || !blocksObs || !path) {
		return undefined;
	}
	return autorun(reader => {
		// read the package's own rendering first: its derived writes the path, this autorun then
		// overwrites it when needed
		const painted = (reader.readObservable(layer.rendering) as { rects?: readonly Rect[] } | undefined)?.rects ?? [];
		const selection = reader.readObservable(model.selection);
		const lineMap = reader.readObservable(internals.measuredLayout.visualLineMap);
		const blocks = reader.readObservable(blocksObs);
		if (!selection || selection.isCollapsed) {
			return;
		}
		const rects = lineRects(selection.range, lineMap.sourceLines, blocks);
		const images = imageRects(view, internals);
		const coversImage = painted.some(r => images.some(img => overlapArea(r, img) > 0));
		if (!coversImage && !hasSideBySide(rects)) {
			return;
		}
		const kept = rects.filter(r => !images.some(img => overlapArea(r, img) > 0.5 * r.width * r.height));
		path.setAttribute('d', columns(kept).map(outline).join(' '));
	});
}

function sourceRange(line: SourceLine): { start: number; endExclusive: number } | undefined {
	if (line.runs.length === 0) {
		return undefined;
	}
	let start = Infinity, endExclusive = -Infinity;
	for (const run of line.runs) {
		start = Math.min(start, run.sourceStart);
		endExclusive = Math.max(endExclusive, run.sourceEndExclusive);
	}
	return { start, endExclusive };
}

/** The first pass of the package's selection geometry: one rect per selected line, no gap fillers. */
function lineRects(sel: { start: number; endExclusive: number }, lines: readonly SourceLine[], blocks: readonly SelectionBlock[]): Rect[] {
	const out: Rect[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const range = sourceRange(line);
		if (!range) {
			continue;
		}
		const next = i + 1 < lines.length ? sourceRange(lines[i + 1]) : undefined;
		const hardBreak = !next || next.start > range.endExclusive;
		const intersects = sel.start < range.endExclusive && range.start < sel.endExclusive;
		const coversBreak = hardBreak && sel.start <= range.endExclusive && sel.endExclusive > range.endExclusive;
		if (!intersects && !coversBreak) {
			continue;
		}
		let left = sel.start <= range.start ? line.rect.left : line.xAtOffset(sel.start);
		let right = sel.endExclusive < range.endExclusive
			? line.xAtOffset(sel.endExclusive)
			: line.rect.right + (sel.endExclusive > range.endExclusive && hardBreak ? line.rect.height * HARD_BREAK_EXTRA : 0);
		const clip = blocks.find(b => b.absoluteStart <= range.start && range.endExclusive <= b.absoluteStart + b.block.length)?.viewportClip;
		if (clip) {
			left = Math.max(left, clip.left);
			right = Math.min(right, clip.right);
		}
		if (right - left > 0.5) {
			out.push({ x: left, y: line.rect.top, width: right - left, height: line.rect.height });
		}
	}
	return out;
}

function imageRects(view: EditorView, internals: PackageInternals): Rect[] {
	const space = internals.coordinateSpace.capture();
	return Array.from(view.element.querySelectorAll('img')).flatMap(img => {
		const client = img.getBoundingClientRect();
		if (client.width === 0 || client.height === 0) {
			return [];
		}
		const r = space.toLocalRect(client);
		return [{ x: r.left, y: r.top, width: r.width, height: r.height }];
	});
}

function overlapArea(a: Rect, b: Rect): number {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

/** Two lines on the same row that do not overlap horizontally: table cells. */
function hasSideBySide(rects: readonly Rect[]): boolean {
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i], b = rects[j];
			const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
			const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
			if (vertical > 1 && horizontal <= 0) {
				return true;
			}
		}
	}
	return false;
}

/** Chains of lines stacked directly on top of each other and overlapping horizontally. */
function columns(rects: readonly Rect[]): Rect[][] {
	const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
	const chains: Rect[][] = [];
	for (const r of sorted) {
		const chain = chains.find(c => {
			const last = c[c.length - 1];
			return Math.abs(r.y - (last.y + last.height)) <= 1
				&& Math.max(last.x, r.x) < Math.min(last.x + last.width, r.x + r.width);
		});
		if (chain) {
			chain.push(r);
		} else {
			chains.push([r]);
		}
	}
	return chains;
}

/** Outline of a vertical chain (right edges down, left edges up) with rounded corners. */
function outline(chain: readonly Rect[]): string {
	const pts: { x: number; y: number }[] = [];
	const first = chain[0], last = chain[chain.length - 1];
	pts.push({ x: first.x + first.width, y: first.y });
	for (let i = 0; i < chain.length - 1; i++) {
		const a = chain[i], b = chain[i + 1];
		if (Math.abs((a.x + a.width) - (b.x + b.width)) > 0.5) {
			pts.push({ x: a.x + a.width, y: a.y + a.height }, { x: b.x + b.width, y: a.y + a.height });
		}
	}
	pts.push({ x: last.x + last.width, y: last.y + last.height }, { x: last.x, y: last.y + last.height });
	for (let i = chain.length - 1; i > 0; i--) {
		const a = chain[i], b = chain[i - 1];
		if (Math.abs(a.x - b.x) > 0.5) {
			pts.push({ x: a.x, y: a.y }, { x: b.x, y: a.y });
		}
	}
	pts.push({ x: first.x, y: first.y });
	const n = pts.length;
	const toward = (from: { x: number; y: number }, to: { x: number; y: number }, dist: number) => {
		const len = Math.hypot(to.x - from.x, to.y - from.y);
		return len === 0 ? from : { x: from.x + (to.x - from.x) * dist / len, y: from.y + (to.y - from.y) * dist / len };
	};
	const f = (v: number) => v.toFixed(2);
	const parts: string[] = [];
	for (let i = 0; i < n; i++) {
		const prev = pts[(i + n - 1) % n], cur = pts[i], next = pts[(i + 1) % n];
		const r = Math.min(RADIUS, Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2, Math.hypot(next.x - cur.x, next.y - cur.y) / 2);
		const a = toward(cur, prev, r), b = toward(cur, next, r);
		parts.push(`${i === 0 ? 'M' : 'L'}${f(a.x)},${f(a.y)} Q${f(cur.x)},${f(cur.y)} ${f(b.x)},${f(b.y)}`);
	}
	return parts.join(' ') + ' Z';
}
