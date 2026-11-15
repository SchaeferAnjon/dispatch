/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the dot (DESIGN.md: green is "running / now", amber "waiting for you", coral "error").
 *  One drawing everywhere: a solid disc in the state colour, and around it a glow out to 1.6 times the
 *  disc's radius. The glow is a radial gradient with three stops: the colour solid at the centre, the colour
 *  at 30% (40% on a dark background) at 45% of the glow's radius, transparent at its edge, so it fades
 *  out without a ring. Breathing only moves the glow's opacity between 30% and 45%, 1.6 s a round; the disc
 *  stays solid and still.
 *
 *  The same drawing in three forms: CSS (dispatchDotCss, for DOM, including the loading splash), an SVG
 *  fragment (dispatchDotSvg, for icons) and a canvas painter (base/browser/dispatchDot.ts).
 *--------------------------------------------------------------------------------------------*/

import { DISPATCH_ICON_COLORS } from './dispatchPalette.js';

/** The app icon's own colours (base/common/dispatchPalette.ts): what a canvas, an SVG file and the splash paint. */
export const DISPATCH_DOT_COLORS = {
	green: DISPATCH_ICON_COLORS.green,
	amber: DISPATCH_ICON_COLORS.amber,
	coral: DISPATCH_ICON_COLORS.coral,
} as const;

/** In the workbench the dot takes its state's colour (light or dark); before it (the splash) the icon's. */
const DOT_STATE = { green: 'working', amber: 'waiting', coral: 'stopped' } as const;
const dotColor = (tone: DispatchDotTone) => `var(--dispatch-state-${DOT_STATE[tone]}, ${DISPATCH_DOT_COLORS[tone]})`;

export type DispatchDotTone = keyof typeof DISPATCH_DOT_COLORS;

/** The glow's outer radius, in disc radii. */
export const DISPATCH_DOT_GLOW = 1.6;

/** Where the middle stop sits, as a fraction of the glow's radius. */
export const DISPATCH_DOT_GLOW_STOP = 0.45;

/** The middle stop's opacity: still on a light background, still on a dark one, and a breath's range. */
export const DISPATCH_DOT_ALPHA = { light: 0.30, dark: 0.40, breathLow: 0.30, breathHigh: 0.45 } as const;

/** One breath, in milliseconds. */
export const DISPATCH_DOT_BREATH_MS = 1600;

/**
 * The dot as CSS rules for `selector` (a class selector by default). The element is the disc, sized with
 * `--dispatch-dot-size` (its diameter, 8px by default); `.amber` / `.coral` pick the tone, `.breathing`
 * breathes, `.on-dark` (or a dark workbench theme) takes the dark background's glow. Reduced motion (the
 * workbench's class or the OS setting) keeps the glow still.
 */
export function dispatchDotCss(selector = '.dispatch-dot'): string {
	const s = selector;
	const a = DISPATCH_DOT_ALPHA;
	const top = a.breathHigh;
	// the gradient's middle stop is drawn at the breath's top; the pseudo element's opacity scales it down
	const stop = `color-mix(in srgb, var(--dispatch-dot-color) ${top * 100}%, transparent) ${DISPATCH_DOT_GLOW_STOP * 100}%`;
	return [
		`${s} { --dispatch-dot-color: ${dotColor('green')}; --dispatch-dot-size: 8px; --dispatch-dot-glow-alpha: ${a.light}; position: relative; display: inline-block; box-sizing: border-box; width: var(--dispatch-dot-size); height: var(--dispatch-dot-size); border-radius: 50%; background: var(--dispatch-dot-color); }`,
		`${s}.amber { --dispatch-dot-color: ${dotColor('amber')}; }`,
		`${s}.coral { --dispatch-dot-color: ${dotColor('coral')}; }`,
		`.vs-dark ${s}, .hc-black ${s}, ${s}.on-dark { --dispatch-dot-glow-alpha: ${a.dark}; }`,
		`${s}::before { content: ''; position: absolute; left: 50%; top: 50%; width: ${DISPATCH_DOT_GLOW * 100}%; height: ${DISPATCH_DOT_GLOW * 100}%; border-radius: 50%; transform: translate(-50%, -50%); background: radial-gradient(closest-side, var(--dispatch-dot-color) 0%, ${stop}, transparent 100%); opacity: calc(var(--dispatch-dot-glow-alpha) / ${top}); pointer-events: none; }`,
		`${s}.breathing::before { animation: dispatch-dot-breathe ${DISPATCH_DOT_BREATH_MS}ms ease-in-out infinite; }`,
		`@keyframes dispatch-dot-breathe { 0%, 100% { opacity: ${round(a.breathLow / top)}; } 50% { opacity: 1; } }`,
		`.monaco-reduce-motion ${s}::before { animation: none; }`,
		`@media (prefers-reduced-motion: reduce) { ${s}::before { animation: none; } }`,
	].join('\n');
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/**
 * The dot as an SVG fragment: the glow (a radial gradient, `id` must be unique in the document) under the
 * disc of radius `r` centred on (`cx`, `cy`). Leave `r * 1.6` of room around the centre for the glow.
 */
export function dispatchDotSvg(cx: number, cy: number, r: number, tone: DispatchDotTone = 'green', id = 'dispatch-dot-glow', alpha: number = DISPATCH_DOT_ALPHA.light): string {
	const color = DISPATCH_DOT_COLORS[tone];
	return `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${color}"/><stop offset="${DISPATCH_DOT_GLOW_STOP}" stop-color="${color}" stop-opacity="${alpha}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>`
		+ `<circle cx="${cx}" cy="${cy}" r="${round(r * DISPATCH_DOT_GLOW)}" fill="url(#${id})"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
}

/** Where a breath is at `timeMs`: 1 is the top (45%), 0 the bottom (30%); a cosine, 1.6 s a round. */
export function dispatchDotBreath(timeMs: number): number {
	return (1 + Math.cos(2 * Math.PI * timeMs / DISPATCH_DOT_BREATH_MS)) / 2;
}
