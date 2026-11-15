/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the loading splash (040-loading-splash.patch), shown by both windows' bootstrap
 *  (code/electron-browser/workbench/workbench.ts, sessions/electron-browser/sessions.ts).
 *  It keeps the icon as it was before 10-10 (kanban task-24xd4, preference「启动图标用之前的」): its own drawing of
 *  the blocks and the Dock's big dot, not the one layout every other place takes (base/common/dispatchIcon.ts).
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

import { dispatchDotCss } from '../common/dispatchDot.js';
import { DISPATCH_ICON_BLOCKS, DISPATCH_ICON_COLORS, DISPATCH_ICON_DOT, DISPATCH_ICON_THEME } from '../common/dispatchPalette.js';

/** The drop: a block every 80 ms, each falling in 380 ms; the dot lights at 1 s, in 220 ms. */
const SPLASH_GAP_MS = 80;
const SPLASH_DROP_MS = 380;
const SPLASH_DOT_AT_MS = 1000;
const SPLASH_DOT_MS = 220;
/** Every part of the drop lasts as long as the whole (the wait and the rest written in): they all end together. */
const SPLASH_ALL_MS = SPLASH_DOT_AT_MS + SPLASH_DOT_MS;
/** The steps of a block's drop (a share of its 380 ms, and the CSS) and of the dot's lighting. */
const DROP_FRAMES: readonly [number, string][] = [[0, 'transform:translateY(-72px);opacity:0'], [0.15, 'opacity:var(--o,1)'], [0.7, 'transform:translateY(0)'], [0.85, 'transform:translateY(-5px)'], [1, 'transform:translateY(0);opacity:var(--o,1)']];
const DOT_FRAMES: readonly [number, string][] = [[0, 'transform:scale(0);opacity:0'], [0.7, 'transform:scale(1.15);opacity:1'], [1, 'transform:scale(1);opacity:1']];

/** Keyframes over `totalMs` that wait `waitMs` at the first step, play `frames` over `playMs`, then hold the last. */
function splashKeyframes(name: string, waitMs: number, playMs: number, frames: readonly [number, string][], totalMs: number): string {
	const at = (share: number) => Math.round((waitMs + share * playMs) / totalMs * 10000) / 100;
	const steps = frames.map(([share, css]) => `${at(share)}%{${css}}`);
	const last = frames[frames.length - 1][1];
	return `@keyframes ${name}{${waitMs ? `0%{${frames[0][1]}}` : ''}${steps.join('')}${waitMs + playMs < totalMs ? `100%{${last}}` : ''}}`;
}

/** The blocks and the Dock's dot together, in the icon's units (the icon's whole box as it was before 10-10). */
const SPLASH_MARK = { w: 622, h: 542 } as const;

/**
 * While a window loads (the editor and the Agents window), Dispatch's icon on the warm stone background (following light /
 * dark): its ten blocks drop in one by one and the green dot lights last, then breathes (about 1.2 s, the empty editor's
 * drop), still under reduced motion. The workbench fades it out when it is laid out (partsSplash.ts).
 */
export function showDispatchSplash(dark: boolean): void {
	// the app icon's blocks in its own colours (base/common/dispatchPalette.ts), bottom row first
	const colors = DISPATCH_ICON_THEME[dark ? 'dark' : 'light'];
	const blocks = [...DISPATCH_ICON_BLOCKS].sort((a, b) => b.row - a.row || a.col - b.col);
	const K = 28 / DISPATCH_ICON_BLOCKS[0].w;	// the icon's units to pixels: 28px blocks
	const icDot = DISPATCH_ICON_DOT;
	const style = document.createElement('style');
	style.textContent = [
		'#dispatch-splash{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;-webkit-app-region:drag;transition:opacity 150ms ease-out}',
		`#dispatch-splash .mark{position:relative;width:${SPLASH_MARK.w * K}px;height:${SPLASH_MARK.h * K}px}`,
		`#dispatch-splash .b{position:absolute;width:${DISPATCH_ICON_BLOCKS[0].w * K}px;opacity:var(--o,1)}`,
		// each block's own drop with its wait written into it, all of them as long as the whole drop: an animation-delay,
		// or animations ending one after another, has the page ask for a main-thread frame every frame (313 in 1.2 s,
		// measured), and while the window loads the workbench's script on a cold disk those frames come late, so the
		// blocks stood still for 200 to 330 ms twice (user 2026-10-21: 「每次打开的时候 这个图标不丝滑 会卡一下」). Started
		// together and ending together, the compositor runs them alone.
		...blocks.map((_, i) => `#dispatch-splash .b.d${i}{animation:dispatch-splash-drop-${i} ${SPLASH_ALL_MS}ms cubic-bezier(.3,0,.5,1) both}`
			+ splashKeyframes(`dispatch-splash-drop-${i}`, i * SPLASH_GAP_MS, SPLASH_DROP_MS, DROP_FRAMES, SPLASH_ALL_MS)),
		// the dot: the shared drawing (a disc and its glow, base/common/dispatchDot.ts), where and as big as the app
		// icon has it (DISPATCH_ICON_DOT); it lights last, then its glow breathes
		dispatchDotCss(),
		`#dispatch-splash .dot{position:absolute;left:${(icDot.cx - icDot.r) * K}px;top:${(icDot.cy - icDot.r) * K}px;--dispatch-dot-size:${2 * icDot.r * K}px;animation:dispatch-splash-dot ${SPLASH_ALL_MS}ms ease-out both}`,
		// and the Dock dot's cream centre (preference「logo 处处同应用图标」)
		`#dispatch-splash .dot::after{content:'';position:absolute;left:50%;top:50%;width:${2 * icDot.inner * K}px;height:${2 * icDot.inner * K}px;margin:${-icDot.inner * K}px 0 0 ${-icDot.inner * K}px;border-radius:50%;background:${DISPATCH_ICON_COLORS[icDot.center]}}`,
		splashKeyframes('dispatch-splash-dot', SPLASH_DOT_AT_MS, SPLASH_DOT_MS, DOT_FRAMES, SPLASH_ALL_MS),
		'@media (prefers-reduced-motion: reduce){#dispatch-splash .mark .b,#dispatch-splash .dot,#dispatch-splash .dot::before{animation:none}}',
	].join('\n');
	window.document.head.appendChild(style);
	const splash = document.createElement('div');
	splash.id = 'dispatch-splash';
	splash.style.background = dark ? '#0c0a09' : '#fafaf9';
	const mark = document.createElement('div');
	mark.className = 'mark';
	// where the Dock icon has them (base/common/dispatchPalette.ts), not rounded to whole pixels of their own
	blocks.forEach(({ x, y, h, rx, color, opacity }, i) => {
		const b = document.createElement('div');
		b.className = 'b';
		b.style.left = `${x * K}px`;
		b.style.top = `${y * K}px`;
		b.style.height = `${h * K}px`;
		b.style.borderRadius = `${rx * K}px`;
		b.style.background = colors[color];
		if (opacity !== 1) {
			b.style.setProperty('--o', String(opacity));
		}
		b.classList.add(`d${i}`);
		mark.appendChild(b);
	});
	const dot = document.createElement('div');
	dot.className = dark ? 'dot dispatch-dot breathing on-dark' : 'dot dispatch-dot breathing';
	mark.appendChild(dot);
	splash.appendChild(mark);
	window.document.body.appendChild(splash);
}
