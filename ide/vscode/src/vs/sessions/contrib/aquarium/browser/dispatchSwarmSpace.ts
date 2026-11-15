/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where the swarm's blocks may be (dispatchSwarm.ts), as plain geometry so it is tested on its own
 *  (ide/tests/swarm-space.test.mjs). The page's controls and words are kept-out rectangles: a block never covers
 *  one. It is placed only where it is free, pushed back out when it swims into one, and a block that cannot be
 *  anywhere free waits out of sight.
 *--------------------------------------------------------------------------------------------*/

/** A kept-out rectangle, in the swarm's own coordinates. */
export interface ISwarmRect { readonly l: number; readonly t: number; readonly r: number; readonly b: number }

/** A block: its centre, its side, its velocity. */
export interface ISwarmBody { x: number; y: number; s: number; vx: number; vy: number }

/** Room left around a control or a word, beyond the block's own half side (a block turns a little: its corners). */
export const SWARM_GAP = 6;

function half(b: { s: number }): number {
	return b.s * 0.6 + SWARM_GAP;
}

/** The first kept-out rectangle the block at (x, y) with side s touches, if any. */
export function swarmHit(x: number, y: number, s: number, rects: readonly ISwarmRect[]): ISwarmRect | undefined {
	const h = half({ s });
	for (const r of rects) {
		if (x + h > r.l && x - h < r.r && y + h > r.t && y - h < r.b) {
			return r;
		}
	}
	return undefined;
}

/**
 * Moves a block that swam into a kept-out rectangle back out by the shortest way, turning its velocity away. Returns
 * how far the deepest push went (0: it was free), or Infinity when it is still inside something after a few pushes
 * (the place is packed: the caller takes the block somewhere else).
 */
export function swarmPushOut(b: ISwarmBody, rects: readonly ISwarmRect[]): number {
	let deepest = 0;
	for (let round = 0; round < 4; round++) {
		const r = swarmHit(b.x, b.y, b.s, rects);
		if (!r) {
			return deepest;
		}
		const h = half(b);
		const left = b.x + h - r.l, right = r.r - (b.x - h), up = b.y + h - r.t, down = r.b - (b.y - h);
		const m = Math.min(left, right, up, down);
		deepest = Math.max(deepest, m);
		if (m === left) {
			b.x -= left; b.vx = -Math.abs(b.vx);
		} else if (m === right) {
			b.x += right; b.vx = Math.abs(b.vx);
		} else if (m === up) {
			b.y -= up; b.vy = -Math.abs(b.vy);
		} else {
			b.y += down; b.vy = Math.abs(b.vy);
		}
	}
	return swarmHit(b.x, b.y, b.s, rects) ? Infinity : deepest;
}

/** A free place for a block of side s inside w × h, or undefined when none turned up in `tries` random picks. */
export function swarmFreeSpot(s: number, w: number, h: number, rects: readonly ISwarmRect[], random: () => number = Math.random, tries = 80): { x: number; y: number } | undefined {
	const m = half({ s });
	if (w <= 2 * m || h <= 2 * m) {
		return undefined;
	}
	for (let i = 0; i < tries; i++) {
		const x = m + random() * (w - 2 * m), y = m + random() * (h - 2 * m);
		if (!swarmHit(x, y, s, rects)) {
			return { x, y };
		}
	}
	return undefined;
}

/** The blocks' places when the swarm's size changes from w0 × h0 to w × h: the same share of the width and height. */
export function swarmRescale(bodies: ISwarmBody[], w0: number, h0: number, w: number, h: number): void {
	if (w0 <= 0 || h0 <= 0) {
		return;
	}
	for (const b of bodies) {
		b.x *= w / w0;
		b.y *= h / h0;
	}
}

/** Whether a rectangle of the page touches any kept-out one (the icon's place above the input). */
export function swarmRectFree(l: number, t: number, r: number, b: number, rects: readonly ISwarmRect[]): boolean {
	return !rects.some(k => r > k.l && l < k.r && b > k.t && t < k.b);
}
