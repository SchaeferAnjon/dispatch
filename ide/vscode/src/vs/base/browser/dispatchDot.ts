/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the dot in the workbench (the drawing and its reasons are in base/common/dispatchDot.ts).
 *--------------------------------------------------------------------------------------------*/

import { createStyleSheet } from './domStylesheets.js';
import { ensureDispatchPalette } from './dispatchPalette.js';
import { DISPATCH_DOT_ALPHA, DISPATCH_DOT_COLORS, DISPATCH_DOT_GLOW, DISPATCH_DOT_GLOW_STOP, type DispatchDotTone, dispatchDotCss } from '../common/dispatchDot.js';

const styled = new Set<string>();

/**
 * Add the dot's rules for `selector` once, as a global stylesheet (auxiliary windows get a copy). Call it
 * where an element with that class is made; `.dispatch-dot` is the class to use for new dots.
 */
export function ensureDispatchDotStyles(selector = '.dispatch-dot'): void {
	if (styled.has(selector)) {
		return;
	}
	styled.add(selector);
	ensureDispatchPalette();
	createStyleSheet(undefined, style => { style.textContent = dispatchDotCss(selector); });
}

function withAlpha(hex: string, alpha: number): string {
	const n = parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Paint the dot on a canvas: the disc of radius `r` at (`x`, `y`) and its glow. `breath` is where a breath
 * is (dispatchDotBreath: 1 the top, 0 the bottom); leave it out for a still dot, whose glow depends on
 * `dark` (the background).
 */
export function drawDispatchDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tone: DispatchDotTone = 'green', breath?: number, dark = false): void {
	const color = DISPATCH_DOT_COLORS[tone];
	const a = DISPATCH_DOT_ALPHA;
	const alpha = breath === undefined ? (dark ? a.dark : a.light) : a.breathLow + (a.breathHigh - a.breathLow) * breath;
	const glow = r * DISPATCH_DOT_GLOW;
	const gradient = ctx.createRadialGradient(x, y, 0, x, y, glow);
	gradient.addColorStop(0, withAlpha(color, 1));
	gradient.addColorStop(DISPATCH_DOT_GLOW_STOP, withAlpha(color, alpha));
	gradient.addColorStop(1, withAlpha(color, 0));
	ctx.fillStyle = gradient;
	ctx.beginPath();
	ctx.arc(x, y, glow, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fill();
}
