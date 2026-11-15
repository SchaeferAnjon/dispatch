/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the app icon laid out at any size, and its blocks' drop. The icon's data (colours, blocks, dots,
 *  plate) is base/common/dispatchPalette.ts; this is the one place that turns it into pixels, so every drawing of
 *  the icon (the Assistant's mark, the loading splash, the empty editor and Files view, the new session page, the
 *  session rows' small icon, Turbo's mark, the static SVG files) has the Dock icon's blocks at its size (kanban
 *  preferences「图标处处同 Dock」「图标和 Dock 统一」). Before, each place wrote its own pixels (37px columns, 17px
 *  cards, 7px corners). The logo (`mark`) has the Dock's own dot where the Dock has it, green with its cream centre, in
 *  a breathing glow (preference「logo 处处同应用图标」, 10-31); the small drawings (session rows, Turbo, the Agents
 *  button) keep a small running dot in the blocks' corner.
 *
 *  The drop is design/icon-motion/index.html's third scheme (落块), its numbers as they are there: the blocks fall
 *  one after another 220ms apart, bottom row first, from above the stage under a constant pull (0.0018px/ms² for its
 *  22px blocks), and bounce back at 0.28 of their speed while they land faster than 0.12px/ms (twice), then rest.
 *  base/browser/dispatchIcon.ts runs it on a drawing.
 *--------------------------------------------------------------------------------------------*/

import { DISPATCH_DOT_ALPHA, DISPATCH_DOT_BREATH_MS, DISPATCH_DOT_GLOW, DISPATCH_DOT_GLOW_STOP } from './dispatchDot.js';
import { DISPATCH_ICON_BLOCKS, DISPATCH_ICON_COLORS, DISPATCH_ICON_DOT, DISPATCH_ICON_PLATE, DISPATCH_ICON_RUNNING_DOT, DISPATCH_ICON_SIZE, DISPATCH_ICON_THEME, type DispatchIconColor } from './dispatchPalette.js';

export interface IDispatchIconRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly rx: number;
}

export interface IDispatchIconLayoutBlock extends IDispatchIconRect {
	/** Its index in DISPATCH_ICON_BLOCKS. */
	readonly i: number;
	readonly row: number;
	readonly col: number;
	readonly color: DispatchIconColor;
	readonly opacity: number;
}

export interface IDispatchIconLayout {
	/** The box, in pixels: `size` wide, `height` high (`size` too unless tight). */
	readonly size: number;
	readonly height: number;
	/** Icon units to pixels. */
	readonly k: number;
	readonly plate?: IDispatchIconRect;
	readonly blocks: readonly IDispatchIconLayoutBlock[];
	/** The running dot (DISPATCH_ICON_RUNNING_DOT); in the mark the Dock's big dot (DISPATCH_ICON_DOT): its cream centre
	 *  `inner` across and its glow `glow` across. */
	readonly dot: { readonly cx: number; readonly cy: number; readonly r: number; readonly inner?: number; readonly glow?: number };
}

export interface IDispatchIconLayoutOptions {
	/** The Dock icon's plate fills the box and the blocks sit on it where the Dock has them; without (the app's
	 *  drawings), the blocks fill the box's width, centred. */
	readonly plate?: boolean;
	/** Each block's corner and size on the device's pixels: a small icon stays sharp, every block the same size. */
	readonly dpr?: number;
	/** Without the plate: the box is as high as the blocks, not square (a drawing with room around it). */
	readonly tight?: boolean;
	/** The app's logo: the blocks and, at their bottom right, the Dock's own dot (green with a cream centre, as the
	 *  Dock icon has it: preference「logo 处处同应用图标」, blurt DIS-1 10-31) in a glow, no plate (the person's call
	 *  10-21); the box holds the glow too (DISPATCH_ICON_MARK). */
	readonly mark?: boolean;
}

/** The mark's box in the icon's units: the blocks' corner to the far edge of the dot's glow. */
export const DISPATCH_ICON_MARK = {
	w: DISPATCH_ICON_DOT.cx + DISPATCH_ICON_DOT.r * DISPATCH_DOT_GLOW,
	h: DISPATCH_ICON_DOT.cy + DISPATCH_ICON_DOT.r * DISPATCH_DOT_GLOW,
} as const;

/** The icon in a `size` px square (or `size` wide and the blocks' height, tight). */
export function dispatchIconLayout(size: number, opts: IDispatchIconLayoutOptions = {}): IDispatchIconLayout {
	const P = DISPATCH_ICON_PLATE;
	let k: number, ox: number, oy: number;
	const M = DISPATCH_ICON_MARK;
	if (opts.plate) {
		k = size / P.size;
		ox = P.x * k;
		oy = P.y * k;
	} else if (opts.mark) {
		k = size / M.w;
		ox = 0;
		oy = opts.tight ? 0 : (M.w - M.h) / 2 * k;
	} else {
		k = size / DISPATCH_ICON_SIZE.w;
		ox = 0;
		oy = opts.tight ? 0 : (DISPATCH_ICON_SIZE.w - DISPATCH_ICON_SIZE.h) / 2 * k;
	}
	const dpr = opts.dpr;
	const at = (v: number) => dpr ? Math.round(v * dpr) / dpr : v;
	const len = (v: number) => dpr ? Math.max(1, Math.round(v * dpr)) / dpr : v;
	// on device pixels: the grid's corner rounded, every block of a row the same size, one column step for all (the
	// gaps stay equal) and each row's step rounded, never so small that two rows or columns touch
	const unit = dpr ? 1 / dpr : 0;
	const B = DISPATCH_ICON_BLOCKS;
	const pitch = Math.max(len((B[1].x - B[0].x) * k), len(B[0].w * k) + unit);
	const rowY: number[] = [];
	for (const b of B) {
		if (rowY[b.row] === undefined) {
			const above = B.find(a => a.row === b.row - 1);
			rowY[b.row] = above ? rowY[above.row] + Math.max(len((b.y - above.y) * k), len(above.h * k) + unit) : 0;
		}
	}
	const x0 = at(ox), y0 = at(oy);
	const blocks = B.map((b, i): IDispatchIconLayoutBlock => ({
		i, row: b.row, col: b.col, color: b.color, opacity: b.opacity,
		x: dpr ? x0 + b.col * pitch : ox + b.x * k, y: dpr ? y0 + rowY[b.row] : oy + b.y * k, w: len(b.w * k), h: len(b.h * k), rx: b.rx * k,
	}));
	// the dot: right-aligned with the last column, centred on the bottom row, as the blocks were placed
	const d = DISPATCH_ICON_RUNNING_DOT;
	const last = blocks[3], bottom = blocks[9];
	const r = d.r * k;
	const D = DISPATCH_ICON_DOT;
	return {
		size, k, blocks,
		height: opts.tight && !opts.plate ? (opts.mark ? M.h : DISPATCH_ICON_SIZE.h) * k : size,
		plate: opts.plate ? { x: 0, y: 0, w: size, h: size, rx: P.rx * k } : undefined,
		// the mark: the Dock's dot where the Dock has it, against the blocks' corner
		dot: opts.mark ? { cx: blocks[0].x + D.cx * k, cy: blocks[0].y + D.cy * k, r: D.r * k, inner: D.inner * k, glow: D.r * k * DISPATCH_DOT_GLOW }
			: { cx: last.x + last.w - r, cy: bottom.y + bottom.h / 2, r },
	};
}

// ---------------------------------------------------------------- the drawing as nodes (SVG)

export interface IDispatchIconNode {
	readonly tag: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly children?: readonly IDispatchIconNode[];
}

export interface IDispatchIconSvgOptions extends IDispatchIconLayoutOptions {
	/**
	 * How the blocks are coloured: 'theme' the workbench's `--dispatch-icon-*` (the cream cards a shade darker on a
	 * light theme; the default); 'light' those light values written in (a static file shown on the light and the dark
	 * theme alike, as before); 'none' left to CSS (a state's colour); 'mono' a black silhouette for a mask, with the
	 * plate as an outline.
	 */
	readonly fill?: 'theme' | 'light' | 'none' | 'mono';
	/** Whether the running dot is drawn (default true). */
	readonly dot?: boolean;
	/** The empty slots where the blocks drop in (the design's stage), 8% of the text colour. */
	readonly ghosts?: boolean;
	/** A static file: the dot's breath written into the file (the page's own CSS breathes it otherwise). */
	readonly breatheStyle?: boolean;
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);
/** Each mark's glow has a gradient of its own in the page. */
let glows = 0;
/** The glow's colour: the dot's, as the blocks are coloured. */
const stopColor = (fill: IDispatchIconSvgOptions['fill']): Record<string, string> => fill === 'light' ? { 'stop-color': DISPATCH_ICON_THEME.light.green }
	: fill === 'mono' ? { 'stop-color': '#000' } : { style: `stop-color: var(--dispatch-icon-green, ${DISPATCH_ICON_COLORS.green})` };
const rectAttrs = (r: IDispatchIconRect) => ({ x: num(r.x), y: num(r.y), width: num(r.w), height: num(r.h), rx: num(r.rx) });

/** The dot's breath: its opacity between 1 and 0.4 and its size between 1 and 0.85, 2.4s a round; still when motion is reduced. */
export const DISPATCH_ICON_BREATH = { ms: 2400, opacity: 0.4, scale: 0.85 } as const;

/**
 * The breath as CSS for the dot `selector` (and the keyframes, `dispatch-icon-breathe`). Opacity only: scaling an SVG
 * element made the page lay out on every frame (144 a second on a 120 Hz display, measured, task-yocgz), and 15 % of
 * a dot 3 px across cannot be seen. The canvas drawing (the new-session page's blocks) still breathes its size too.
 */
export function dispatchIconBreathCss(selector: string): string {
	const B = DISPATCH_ICON_BREATH;
	const A = DISPATCH_DOT_ALPHA;
	const ratio = (v: number) => Math.round(v / A.breathHigh * 1000) / 1000;
	return [
		`${selector} { animation: dispatch-icon-breathe ${B.ms}ms ease-in-out infinite; }`,
		`@keyframes dispatch-icon-breathe { 0%, 100% { opacity: 1; } 50% { opacity: ${B.opacity}; } }`,
		// the mark's big dot stays solid and its glow breathes, as the dot does everywhere (base/common/dispatchDot.ts)
		`${selector}:has(> .glow) { animation: none; }`,
		`.vs-dark ${selector} > .glow, .hc-black ${selector} > .glow { opacity: ${ratio(A.dark)}; }`,
		`${selector} > .glow { animation: dispatch-icon-glow ${DISPATCH_DOT_BREATH_MS}ms ease-in-out infinite; }`,
		`@keyframes dispatch-icon-glow { 0%, 100% { opacity: ${ratio(A.breathLow)}; } 50% { opacity: 1; } }`,
		`@media (prefers-reduced-motion: reduce) { ${selector}, ${selector} > .glow { animation: none; } }`,
	].join('\n');
}

/**
 * The icon as SVG nodes, laid out by dispatchIconLayout: `svg.dispatch-icon` holding the blocks in `g.blocks` as
 * `g.slot.c-<colour>` > `rect.blk` with `data-i` and `data-row` (the empty slots before them as `rect.ghost`), and
 * the running dot as `g.now` > `circle.disc`: a small flat green dot, no glow, no ring, no centre (the mark: the Dock's
 * dot, `circle.glow` under `circle.disc` and its cream `circle.centre`).
 */
export function dispatchIconNodes(size: number, opts: IDispatchIconSvgOptions = {}): IDispatchIconNode {
	const L = dispatchIconLayout(size, opts);
	const fill = opts.fill ?? 'theme';
	const color = (c: DispatchIconColor): Record<string, string> => fill === 'light' ? { fill: DISPATCH_ICON_THEME.light[c] }
		: fill === 'theme' ? { style: `fill: var(--dispatch-icon-${c}, ${DISPATCH_ICON_COLORS[c]})` } : fill === 'mono' ? { fill: '#000' } : {};
	const children: IDispatchIconNode[] = [];
	if (opts.breatheStyle && opts.dot !== false) {
		children.push({ tag: 'style', attrs: {}, children: [{ tag: '#text', attrs: { text: dispatchIconBreathCss('.now') } }] });
	}
	if (L.plate && fill === 'mono') {
		// the plate's outline, inside the box
		const inset = 0.5;
		children.push({ tag: 'rect', attrs: { class: 'plate', ...rectAttrs({ x: inset, y: inset, w: L.size - 2 * inset, h: L.size - 2 * inset, rx: L.plate.rx * (L.size - 2 * inset) / L.size }), fill: 'none', stroke: '#000', 'stroke-width': '1' } });
	}
	const inGroup: IDispatchIconNode[] = [];
	if (opts.ghosts) {
		for (const b of L.blocks) {
			inGroup.push({ tag: 'rect', attrs: { class: 'ghost', 'data-i': String(b.i), ...rectAttrs(b), fill: 'currentColor', 'fill-opacity': '0.08' } });
		}
	}
	for (const b of L.blocks) {
		const blk: Record<string, string> = { class: 'blk', 'data-i': String(b.i), 'data-row': String(b.row), ...rectAttrs(b), ...color(b.color) };
		if (b.opacity !== 1 && fill !== 'mono' && fill !== 'none') {
			blk['fill-opacity'] = String(b.opacity);
		}
		inGroup.push({ tag: 'g', attrs: { class: `slot c-${b.color}`, style: `--d: ${b.col + b.row}` }, children: [{ tag: 'rect', attrs: blk }] });
	}
	children.push({ tag: 'g', attrs: { class: 'blocks' }, children: inGroup });
	if (opts.dot !== false) {
		const d = L.dot;
		const disc: IDispatchIconNode = { tag: 'circle', attrs: { class: 'disc', cx: num(d.cx), cy: num(d.cy), r: num(d.r), ...color(DISPATCH_ICON_RUNNING_DOT.color) } };
		// the Dock dot's cream centre, the Dock's own cream on every theme (the cards' darker light-theme cream is for
		// cards on a light page; this sits on the green); a mask has none
		const centre: IDispatchIconNode[] = d.inner && fill !== 'mono'
			? [{ tag: 'circle', attrs: { class: 'centre', cx: num(d.cx), cy: num(d.cy), r: num(d.inner), fill: DISPATCH_ICON_COLORS[DISPATCH_ICON_DOT.center] } }]
			: [];
		if (d.glow) {
			// the dot's glow (base/common/dispatchDot.ts's drawing): its colour solid at the centre, at 45% opacity 45% out,
			// gone at the edge; the glow's own opacity takes it to the theme's 30% or 40% and breathes
			const id = `dispatch-icon-glow-${++glows}`;
			const stop = (offset: number, opacity: number): IDispatchIconNode => ({ tag: 'stop', attrs: { offset: String(offset), 'stop-opacity': String(opacity), ...stopColor(fill) } });
			children.push({ tag: 'defs', attrs: {}, children: [{ tag: 'radialGradient', attrs: { id }, children: [stop(0, 1), stop(DISPATCH_DOT_GLOW_STOP, DISPATCH_DOT_ALPHA.breathHigh), stop(1, 0)] }] });
			const glow: IDispatchIconNode = { tag: 'circle', attrs: { class: 'glow', cx: num(d.cx), cy: num(d.cy), r: num(d.glow), fill: `url(#${id})`, opacity: num(DISPATCH_DOT_ALPHA.light / DISPATCH_DOT_ALPHA.breathHigh) } };
			children.push({ tag: 'g', attrs: { class: 'now' }, children: [glow, disc, ...centre] });
		} else {
			children.push({ tag: 'g', attrs: { class: 'now' }, children: [disc] });
		}
	}
	return { tag: 'svg', attrs: { xmlns: 'http://www.w3.org/2000/svg', class: opts.mark ? 'dispatch-icon mark' : 'dispatch-icon', width: num(size), height: num(L.height), viewBox: `0 0 ${num(size)} ${num(L.height)}` }, children };
}

/** The nodes as SVG text (the static files: the empty Files view's icon, the Agents button's icons). */
export function dispatchIconSvg(size: number, opts: IDispatchIconSvgOptions = {}): string {
	const text = (n: IDispatchIconNode): string => {
		if (n.tag === '#text') {
			return n.attrs.text;
		}
		const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
		return n.children?.length ? `<${n.tag}${attrs}>${n.children.map(text).join('')}</${n.tag}>` : `<${n.tag}${attrs}/>`;
	};
	return text(dispatchIconNodes(size, opts)) + '\n';
}

// ---------------------------------------------------------------- the drop (design/icon-motion/index.html, 落块)

/** The design's numbers, in its pixels (its blocks are 22px: a drawing scales the distances by its block / 22). */
export const DISPATCH_ICON_DROP = {
	/** Bottom row first, left to right, then the row above. */
	order: [8, 9, 4, 5, 6, 7, 0, 1, 2, 3] as readonly number[],
	/** One block starts this long after the one before. */
	gapMs: 220,
	/** px/ms², down. */
	gravity: 0.0018,
	/** A block that lands faster than `rest` px/ms goes back up at this share of its speed. */
	bounce: 0.28,
	rest: 0.12,
	/** A frame longer than this counts as this long (a busy or hidden window does not throw the blocks through). */
	maxFrameMs: 50,
	/** The design's block. */
	block: 22,
	/** Where a block starts: 40px above the stage, and the icon's top row is 61.2px into it (0.22 of its 460px
	 *  height less half the icon's): 101.2px above that row; a lower row falls that much further. */
	fall: 101.2,
	/** Not the design's (it drops once): a running session's icon (dispatchIconRounds) holds the full icon this long
	 *  after the last block lands, then the grid empties and the next round falls (user 2026-11-15, task-dw425). */
	restMs: 1000,
} as const;

/** A block's drop: `y` is how far above its place it is, in the design's px (negative is above). */
export interface IDispatchDropState {
	started: boolean;
	done: boolean;
	y: number;
	vy: number;
}

/** A block of the icon (its index), at the start of its drop: everything starts at the same height, the stage's top. */
export function dispatchDropStart(i: number): IDispatchDropState {
	const D = DISPATCH_ICON_DROP;
	const b = DISPATCH_ICON_BLOCKS[i];
	return { started: true, done: false, y: -(D.fall + b.y * D.block / b.w), vy: 0 };
}

/** One frame of `dt` ms, the design's integration as it is (stepDrop). */
export function dispatchDropStep(s: IDispatchDropState, dt: number): void {
	if (!s.started || s.done) {
		return;
	}
	const D = DISPATCH_ICON_DROP;
	dt = Math.min(D.maxFrameMs, dt);
	s.vy += D.gravity * dt;
	s.y += s.vy * dt;
	if (s.y >= 0) {
		s.y = 0;
		if (s.vy > D.rest) {
			s.vy = -s.vy * D.bounce;
		} else {
			s.done = true;
			s.vy = 0;
		}
	}
}

/**
 * A round of the running icon (dispatchIconRounds), in ms: `dropMs` until the last block rests (the design's step at
 * 60 frames a second, as a drawing made in the middle of a drop catches up), then the full icon rests and the next
 * round starts at `roundMs`.
 */
export function dispatchIconRound(): { readonly dropMs: number; readonly roundMs: number } {
	const D = DISPATCH_ICON_DROP;
	const dt = 1000 / 60;
	const blocks = D.order.map((i, k) => ({ i, at: k * D.gapMs, s: undefined as IDispatchDropState | undefined }));
	let now = 0;
	while (blocks.some(b => !b.s?.done)) {
		now += dt;
		for (const b of blocks) {
			if (!b.s && now > b.at) {
				b.s = dispatchDropStart(b.i);
			}
			if (b.s) {
				dispatchDropStep(b.s, dt);
			}
		}
	}
	return { dropMs: now, roundMs: now + D.restMs };
}
