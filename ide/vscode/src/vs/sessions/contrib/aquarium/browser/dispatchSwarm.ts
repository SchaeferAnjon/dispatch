/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the new session page's easter egg, VS Code's aquarium with Dispatch's blocks
 *  (kanban design/icon-swarm). Same place and the same switch as the aquarium (the button at the top
 *  left shows it, ✕ hides it), on by default.
 *
 *  35 blocks in the app icon's colours, muted halfway to the stone grey (kanban preference「方块配色别太艳」),
 *  14 to 30px, swim over the whole page on a faint tint of the icon's green and blue, leave at one edge and
 *  come back at the other, and now and then three or four gather for a moment. While the input has text, the
 *  ten blocks nearest to it are called back and make the app icon just above the input: the Dock icon's blocks,
 *  their shapes and colours (base/common/dispatchIcon.ts lays them out; kanban preferences「图标处处同 Dock」
 *  「图标和 Dock 统一」「logo 处处同应用图标」); the others fade; once it is whole the Dock's white-centred dot shows at its bottom right, its glow breathing
 *  (base/common/dispatchDot.ts's drawing). Every colour here comes from that palette. When the
 *  message goes out the icon shrinks and flies to the new session's row in the sessions list, where the
 *  status icon takes over, and the rest fade away. Reduced motion, and Motion › Less (the decoration stops):
 *  the blocks stand still.
 *
 *  The Assistant's home (Home and Timeline) is that folder's new-session page: the same background (kanban
 *  preference「首页同款背景」). A block never covers a control or a word (dispatchSwarmSpace.ts): the page's
 *  buttons, inputs, icons and text are kept out, a block is placed only where it is free and swims around them;
 *  the icon gathers only where it covers nothing. While the page has no size (hidden), nothing moves. Before,
 *  every block folded into the top left corner then (the wrap-around of a 0 × 0 page) and sat on the ✕ when the
 *  page came back (0.9.2: from the Assistant's home, New).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSwarm.css';
import { $, getWindow } from '../../../../base/browser/dom.js';
import { DISPATCH_ICON_COLORS, DISPATCH_ICON_THEME, type DispatchIconColor } from '../../../../base/common/dispatchPalette.js';
import { dispatchIconLayout } from '../../../../base/common/dispatchIcon.js';
import { DISPATCH_DOT_ALPHA, dispatchDotBreath } from '../../../../base/common/dispatchDot.js';
import { drawDispatchDot } from '../../../../base/browser/dispatchDot.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { isDispatchWindowIdle, onDidChangeDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISwarmRect, swarmFreeSpot, swarmHit, swarmPushOut, swarmRectFree, swarmRescale } from './dispatchSwarmSpace.js';

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (c: number[]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
/** The stone grey the swimming blocks are muted toward, light and dark (DESIGN.md's stone 400 and 500). */
const STONE = { light: rgb('#a8a29e'), dark: rgb('#78716c') };
/** How much of the icon's colour a swimming block keeps (kanban preference「方块配色别太艳」). */
const KEEP = 0.5;
const SWIM_COLORS = Object.keys(DISPATCH_ICON_COLORS) as DispatchIconColor[];
/** A swimming block's colour: the icon's (its theme's), muted toward the stone grey. */
const SWIM = {
	light: Object.fromEntries(SWIM_COLORS.map(c => [c, hexOf(rgb(DISPATCH_ICON_THEME.light[c]).map((v, i) => v * KEEP + STONE.light[i] * (1 - KEEP)))])) as Record<DispatchIconColor, string>,
	dark: Object.fromEntries(SWIM_COLORS.map(c => [c, hexOf(rgb(DISPATCH_ICON_THEME.dark[c]).map((v, i) => v * KEEP + STONE.dark[i] * (1 - KEEP)))])) as Record<DispatchIconColor, string>,
};
const rgba = (hex: string, a: number) => `rgba(${rgb(hex).join(',')},${a})`;
const COUNT = 35;
const SPEED = 35;
const ICON_W = 120;		// the logo the blocks make, px wide: its blocks 22px, the dot's glow inside (base/common/dispatchIcon.ts's mark)
const ICON = dispatchIconLayout(ICON_W, { mark: true, tight: true });
/** Its blocks and dot, from the top of the blocks (the layout centres them in a square box). */
const ICON_TOP = ICON.blocks[0].y;
const ICON_H = ICON.height - ICON_TOP;
const FLY_MS = 700;
const FADE_MS = 900;
const LOOK_MS = 250;		// how often the page's controls and words are looked up while the blocks swim
const LOOK_STILL_MS = 500;	// and while they stand still: the page changes under them (a list opens)
const LOOK_SOON_MS = 50;	// the page changed (an element came or went): look again on the next frame or so
const FRAME_MS = 1000 / 30;	// the blocks drift slowly: 30 frames a second look the same as the display's 120 (task-yocgz)
const SHOW_MS = 400;		// a block moved to a free place fades in
const DEEP = 12;		// pushed further than this: the page changed under the block, it moves elsewhere
/** What a block must not cover: controls, icons and pictures; every piece of text is found on its own. */
const KEEP_OUT = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="combobox"], [role="textbox"], [role="menuitem"], .monaco-editor, .monaco-button, .codicon, .dispatch-block, svg, img';

/** Where one of the icon's blocks goes: its centre, size, corner, colour and opacity. */
interface ISlot { x: number; y: number; w: number; h: number; r: number; c: DispatchIconColor; o: number }

interface IBlock { x: number; y: number; s: number; h: number; c: DispatchIconColor; vx: number; vy: number; ph: number; rot: number; a: number; out: boolean }

/** The swarm on screen now: the new session page tells it when a message goes out. */
let current: { send(): void } | undefined;

/** The first message of a new session went out (newChatWidget._send). */
export function dispatchSwarmSend(): void {
	current?.send();
}

/** Same contract as the aquarium it replaces: dispose at once, or exit with a fade. */
export interface IDispatchSwarm extends IDisposable {
	exit(onDidComplete: () => void): IDisposable;
}

export function createDispatchSwarm(mainContainer: HTMLElement, layoutService: IWorkbenchLayoutService, accessibilityService: IAccessibilityService): IDispatchSwarm | undefined {
	const win = getWindow(mainContainer);
	const part = layoutService.getContainer(win, Parts.SESSIONS_PART);
	if (!part || !layoutService.isVisible(Parts.SESSIONS_PART, win)) {
		return undefined;
	}
	const store = new DisposableStore();
	const water = $('.agents-aquarium-water.dispatch-swarm');
	water.setAttribute('aria-hidden', 'true');
	part.insertBefore(water, part.firstChild);
	part.classList.add('aquarium-active');
	store.add(toDisposable(() => { water.remove(); part.classList.remove('aquarium-active'); }));
	win.requestAnimationFrame(() => water.classList.add('visible')); // the aquarium's fade in
	const canvas = water.appendChild($('canvas')) as HTMLCanvasElement;
	const ctx = canvas.getContext('2d')!;

	// Reduced motion, or Motion › Less (the decoration stops): the blocks stand still
	const still = () => accessibilityService.isMotionReduced() || win.document.body.classList.contains('dispatch-motion-less');

	const blocks: IBlock[] = [];
	let chosen: { b: IBlock; slot: ISlot }[] | undefined;
	let W = 0, H = 0;

	// ---- what the blocks keep out of: the page's controls, icons and words, in the water's coordinates
	let keep: ISwarmRect[] = [];
	let lookedAt = 0;
	let changed = false;
	const look = () => {
		lookedAt = performance.now();
		hasText = inputHasText();
		const wr = water.getBoundingClientRect();
		const area = wr.width * wr.height;
		const out: ISwarmRect[] = [];
		const add = (r: DOMRect) => {
			if (r.width <= 0 || r.height <= 0 || r.right < wr.left || r.left > wr.right || r.bottom < wr.top || r.top > wr.bottom) {
				return;
			}
			out.push({ l: r.left - wr.left, t: r.top - wr.top, r: r.right - wr.left, b: r.bottom - wr.top });
		};
		const shown = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
		for (const el of part.querySelectorAll(KEEP_OUT)) {
			if (water.contains(el) || !shown(el)) {
				continue;
			}
			const r = el.getBoundingClientRect();
			// a frame around most of the page (a list, a scroll area) is not a control: its words count below
			if (r.width * r.height < area * 0.4) {
				add(r);
			}
		}
		const doc = win.document;
		const walker = doc.createTreeWalker(part, NodeFilter.SHOW_TEXT);
		const range = doc.createRange();
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const el = n.parentElement;
			if (!el || !n.nodeValue?.trim() || water.contains(el) || !shown(el)) {
				continue;
			}
			range.selectNodeContents(n);
			for (const r of range.getClientRects()) {
				add(r);
			}
		}
		keep = out;
	};
	/** A block somewhere free; out of sight (tried again at the next look) when the page has no free place for it. */
	const place = (b: IBlock, fadeIn: boolean) => {
		const spot = swarmFreeSpot(b.s, W, H, keep);
		b.out = !spot;
		if (spot) {
			b.x = spot.x;
			b.y = spot.y;
		}
		b.a = spot && !(fadeIn && !still()) ? 1 : 0;
	};
	/** After a look: a block the page now has a control or a word on (it changed under it) goes to a free place. */
	const settle = () => {
		const icon = new Set((chosen ?? []).map(c => c.b));
		for (const b of blocks) {
			if (!icon.has(b) && (b.out || swarmHit(b.x, b.y, b.s, keep))) {
				place(b, true);
			}
		}
	};
	const spawn = () => {
		blocks.length = 0;
		look();
		for (let i = 0; i < COUNT; i++) {
			const s = 14 + Math.random() * 16;
			const b: IBlock = { x: 0, y: 0, s, h: s, c: SWIM_COLORS[Math.floor(Math.random() * SWIM_COLORS.length)], vx: Math.random() - 0.5, vy: Math.random() - 0.5, ph: Math.random() * 6.28, rot: (Math.random() - 0.5) * 0.6, a: 1, out: false };
			place(b, false);
			blocks.push(b);
		}
	};

	// Set once drawing runs. Resizing a canvas wipes it, and a ResizeObserver callback runs before the paint: without a
	// frame drawn right here, every step of a sash drag painted an empty canvas for a frame (the flicker).
	let repaint: (() => void) | undefined;
	const resize = () => {
		const dpr = Math.min(2, win.devicePixelRatio || 1);
		const w = water.clientWidth, h = water.clientHeight;
		if (w === W && h === H && canvas.width === Math.round(w * dpr) && canvas.height === Math.round(h * dpr)) {
			return;
		}
		// a new size keeps every block at the same share of the page (the window or the side bar changed); a hidden
		// page (0 × 0) changes nothing: the blocks wait where they were
		if (w > 0 && h > 0 && W > 0 && H > 0) {
			swarmRescale(blocks, W, H, w, h);
		}
		if (w > 0 && h > 0) {
			W = w;
			H = h;
		}
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		lookedAt = 0;
		repaint?.();
	};
	const ro = new win.ResizeObserver(resize);
	ro.observe(water);
	store.add(toDisposable(() => ro.disconnect()));
	resize();
	const showing = () => water.clientWidth > 0 && water.clientHeight > 0;

	// the input and the chips above it, in the water's coordinates
	const input = () => part.querySelector<HTMLElement>('.new-chat-input-area');
	const inputHasText = () => ((input()?.querySelector('.view-lines') as HTMLElement | null)?.innerText ?? '').trim().length > 0;
	// innerText lays the page out: read when the page was looked at or a key came, not on every frame
	let hasText = false;
	/** The icon's blocks and dot above the input, in the water's coordinates, and the box around them. */
	const slots = () => {
		const wr = water.getBoundingClientRect();
		const chips = part.querySelector('.new-session-workspace-picker-container') ?? input();
		const top = chips ? chips.getBoundingClientRect().top - wr.top : H * 0.44;
		const x0 = Math.round(W / 2 - ICON_W / 2), y0 = Math.round(top - ICON_H - 36);
		const d = ICON.dot;
		return {
			blocks: ICON.blocks.map((b): ISlot => ({ x: x0 + b.x + b.w / 2, y: y0 + b.y - ICON_TOP + b.h / 2, w: b.w, h: b.h, r: b.rx, c: b.color, o: b.opacity })),
			dot: { x: x0 + d.cx, y: y0 + d.cy - ICON_TOP, r: d.r, inner: d.inner ?? 0 },
			box: { l: x0, t: y0, r: x0 + ICON_W, b: y0 + ICON_H },
		};
	};
	/** The icon's place covers nothing and is on the page (on the Assistant's home its words are there: no icon). */
	const iconFits = ({ box }: ReturnType<typeof slots>) => {
		const { l, t, r, b } = box;
		return l >= 0 && t >= 0 && r <= W && b <= H && swarmRectFree(l - 6, t - 6, r + 6, b + 6, keep);
	};


	const pick = () => {
		const sl = slots();
		if (!iconFits(sl)) {
			return;
		}
		const cx = W / 2, cy = sl.box.t;
		chosen = blocks.filter(b => !b.out).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy)).slice(0, sl.blocks.length).map((b, i) => ({ b, slot: sl.blocks[i] }));
		if (chosen.length < sl.blocks.length) {
			chosen = undefined;
		}
	};

	const dark = () => !!mainContainer.closest('.vs-dark, .hc-black') || mainContainer.classList.contains('vs-dark') || mainContainer.classList.contains('hc-black');
	const rr = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

	let group: { x: number; y: number; members: IBlock[]; until: number } | undefined;
	let groupIn = 4000;
	let typing = 0;			// eases 0 → 1 while the input has text
	let fading = 0;			// set when the message went out: the rest fade from then
	let last = performance.now();
	let frame = 0;
	let timer = 0;

	const draw = (now: number) => {
		// hidden (the page is not on screen): nothing moves until it has a size again (the ResizeObserver kicks)
		if (!showing() || !W || !H) {
			return;
		}
		// the first frame with a size makes the blocks (the page may have started hidden, or still laying out)
		if (!blocks.length) {
			spawn();
		}
		const dt = Math.min(50, now - last);
		last = now;
		const t = now / 1000;
		const reduced = still();
		if (now - lookedAt > (reduced ? LOOK_STILL_MS : changed ? LOOK_SOON_MS : LOOK_MS)) {
			changed = false;
			look();
			settle();
		}
		ctx.clearRect(0, 0, W, H);
		// the faint tint, green to blue
		const g = ctx.createLinearGradient(0, 0, W, H);
		g.addColorStop(0, rgba(DISPATCH_ICON_COLORS.green, dark() ? 0.10 : 0.12));
		g.addColorStop(0.5, 'rgba(0,0,0,0)');
		g.addColorStop(1, rgba(DISPATCH_ICON_COLORS.blue, dark() ? 0.10 : 0.14));
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);

		const want = !fading && hasText ? 1 : 0;
		typing += (want - typing) * Math.min(1, dt / 250);
		if (want && !chosen) {
			pick();
		} else if (!want && typing < 0.02 && !fading) {
			chosen = undefined;
		}
		if (!reduced && !fading) {
			groupIn -= dt;
			if (groupIn <= 0) {
				groupIn = 4000 + Math.random() * 4000;
				const i = Math.floor(Math.random() * blocks.length);
				group = { x: blocks[i].x, y: blocks[i].y, members: [0, 1, 2, 3].map(k => blocks[(i + k * 7) % blocks.length]), until: now + 2200 };
			}
		}
		let sl = chosen ? slots() : undefined;
		if (chosen && sl && !fading && !iconFits(sl)) {
			// the page moved something onto the icon's place: no icon there (the blocks swim on)
			chosen = undefined;
			sl = undefined;
		}
		if (chosen && sl) {
			chosen.forEach((c, i) => { c.slot = sl!.blocks[i]; });
		}
		const theme = dark() ? 'dark' : 'light';
		const picked = new Map((chosen ?? []).map(c => [c.b, c]));
		let allIn = !!chosen;
		let drawn = 0;			// read by e2e, with out, keep and icon below
		for (const b of blocks) {
			const c = picked.get(b);
			if (c) {
				const k = reduced ? 1 : 1 - Math.pow(0.001, dt / 1000 * 1.2 * Math.max(0.3, typing));
				b.x += (c.slot.x - b.x) * k; b.y += (c.slot.y - b.y) * k; b.s += (c.slot.w - b.s) * k; b.h += (c.slot.h - b.h) * k;
				b.a = 1;
				allIn &&= Math.hypot(b.x - c.slot.x, b.y - c.slot.y) < 1.5;
				if (fading) {
					continue; // the icon itself flies on the overlay
				}
				// on its way it passes behind the page's controls and words, never over them (its place is free: iconFits)
				if (swarmHit(b.x, b.y, Math.max(b.s, b.h), keep)) {
					continue;
				}
				// the icon's own colour (its theme's) once it is being made, the muted one before
				const own = typing > 0.5;
				ctx.globalAlpha = own ? c.slot.o : 1;
				ctx.fillStyle = own ? DISPATCH_ICON_THEME[theme][c.slot.c] : SWIM[theme][b.c];
				rr(b.x - b.s / 2, b.y - b.h / 2, b.s, b.h, own ? c.slot.r : Math.min(b.s, b.h) * 0.22);
				ctx.fill();
				drawn++;
				continue;
			}
			if (b.out) {
				continue;
			}
			const fade = fading ? Math.max(0, 1 - (now - fading) / FADE_MS) : 1;
			if (!reduced && !fading) {
				b.vx += Math.cos(t * 0.6 + b.ph) * 0.004;
				b.vy += Math.sin(t * 0.5 + b.ph) * 0.004;
				const gi = group && now < group.until ? group.members.indexOf(b) : -1;
				if (group && gi >= 0) {
					b.vx += (group.x + (gi % 2) * (b.s + 4) - b.s / 2 - b.x) * 0.0015;
					b.vy += (group.y + Math.floor(gi / 2) * (b.s + 4) - b.s / 2 - b.y) * 0.0015;
				}
				const sp = Math.hypot(b.vx, b.vy), max = 0.5 + (b.s - 14) / 16 * 0.5;
				if (sp > max) { b.vx *= max / sp; b.vy *= max / sp; }
				b.x += b.vx * dt * SPEED / 90 * 0.09;
				b.y += b.vy * dt * SPEED / 90 * 0.09;
				if (b.x < -40) { b.x = W + 30; } else if (b.x > W + 40) { b.x = -30; }
				if (b.y < -40) { b.y = H + 30; } else if (b.y > H + 40) { b.y = -30; }
				// around the page's controls and words, never over them; a block the page changed under goes elsewhere
				if (swarmPushOut(b, keep) > DEEP) {
					place(b, true);
					if (b.out) {
						continue;
					}
				}
				b.a = Math.min(1, b.a + dt / SHOW_MS);
				b.h += (b.s - b.h) * Math.min(1, dt / 300);	// a card of the icon becomes a square again
			} else {
				b.a = 1;
				b.h = b.s;
			}
			ctx.save();
			ctx.translate(b.x, b.y);
			ctx.rotate(reduced ? 0 : Math.sin(t * 0.4 + b.ph) * b.rot);
			ctx.globalAlpha = (dark() ? 0.9 : 1) * fade * b.a * (0.35 + 0.65 * (1 - typing));
			ctx.fillStyle = SWIM[theme][b.c];
			rr(-b.s / 2, -b.h / 2, b.s, b.h, Math.min(b.s, b.h) * 0.22);
			ctx.fill();
			drawn++;
			ctx.restore();
		}
		ctx.globalAlpha = 1;
		if (allIn && sl && !fading) {
			// the logo's big dot at the blocks' bottom right, solid, its glow breathing (base/common/dispatchDot.ts's drawing,
			// 1.6s a round; still when motion is reduced)
			const d = sl.dot;
			const breath = reduced ? undefined : dispatchDotBreath(now);
			drawDispatchDot(ctx, d.x, d.y, d.r, 'green', breath, dark());
			// the Dock dot's cream centre (preference「logo 处处同应用图标」)
			ctx.fillStyle = DISPATCH_ICON_COLORS.cream;
			ctx.beginPath();
			ctx.arc(d.x, d.y, d.inner, 0, Math.PI * 2);
			ctx.fill();
			// where it is, how big and how bright its glow is this frame, 1 at a breath's top (read by e2e)
			const A = DISPATCH_DOT_ALPHA;
			const glow = (breath === undefined ? (dark() ? A.dark : A.light) : A.breathLow + (A.breathHigh - A.breathLow) * breath) / A.breathHigh;
			water.dataset.dot = `${d.x.toFixed(2)},${d.y.toFixed(2)},${d.r.toFixed(3)},${glow.toFixed(3)}`;
		}
		// how many blocks are out of sight for want of room, and how much the page keeps them out of (read by e2e)
		const mark = (key: string, value: string) => { if (water.dataset[key] !== value) { water.dataset[key] = value; } };
		mark('out', String(blocks.filter(b => b.out).length));
		mark('keep', String(keep.length));
		mark('drawn', String(drawn));
		mark('icon', chosen ? (allIn ? 'whole' : 'gathering') : '');
		mark('iconBox', chosen && sl ? `${sl.box.l},${sl.box.t},${ICON_W},${ICON_H}` : '');
		const busy = !reduced || typing > 0.01 && typing < 0.99 || (fading && now - fading < FADE_MS);
		if (busy && win.document.visibilityState === 'visible' && !isDispatchWindowIdle()) {
			// the next frame in 1/30 s: a timer first, so the display's own rate (120 Hz) does not wake the page for nothing
			win.clearTimeout(timer);
			timer = win.setTimeout(() => { frame = win.requestAnimationFrame(draw); }, Math.max(0, FRAME_MS - (performance.now() - now)));
		}
	};
	const kick = () => { win.cancelAnimationFrame(frame); win.clearTimeout(timer); last = performance.now(); frame = win.requestAnimationFrame(draw); };
	repaint = () => {
		win.cancelAnimationFrame(frame);
		win.clearTimeout(timer);
		// back from hidden while swimming: no jump for the time it was away
		last = performance.now();
		draw(last);
	};
	store.add(toDisposable(() => { win.cancelAnimationFrame(frame); win.clearTimeout(timer); }));
	// the window went idle (hidden, or untouched for 30 s): the blocks stop where they are; awake again they swim on
	store.add(onDidChangeDispatchWindowIdle(idle => { if (!idle) { kick(); } }));
	// typing (and still blocks, where nothing else redraws): look again on every key
	store.add(toDisposable((() => { const h = () => { hasText = inputHasText(); kick(); }; part.addEventListener('keyup', h, true); return () => part.removeEventListener('keyup', h, true); })()));
	// the page scrolled: its words moved, look again at once
	store.add(toDisposable((() => { const h = () => { lookedAt = 0; if (still()) { kick(); } }; part.addEventListener('scroll', h, true); return () => part.removeEventListener('scroll', h, true); })()));
	const onVisible = () => { if (win.document.visibilityState === 'visible') { kick(); } };
	win.document.addEventListener('visibilitychange', onVisible);
	store.add(toDisposable(() => win.document.removeEventListener('visibilitychange', onVisible)));
	// motion turned on or off (Settings › Appearance › Motion, the Mac's own setting): swim again, or stand still
	store.add(accessibilityService.onDidChangeReducedMotion(() => kick()));
	const mo = new win.MutationObserver(() => kick());
	mo.observe(win.document.body, { attributes: true, attributeFilter: ['class'] });
	store.add(toDisposable(() => mo.disconnect()));
	// the page itself changed (a list opened, a card came): its controls and words are looked up again at once
	let soon = 0;
	const pageMo = new win.MutationObserver(records => {
		if (!records.some(r => !water.contains(r.target))) {
			return;
		}
		changed = true;
		// standing still nothing draws by itself: draw once the change has settled
		if (still() && !soon) {
			soon = win.setTimeout(() => { soon = 0; lookedAt = 0; kick(); }, LOOK_SOON_MS);
		}
	});
	pageMo.observe(part, { childList: true, subtree: true, characterData: true });
	store.add(toDisposable(() => { pageMo.disconnect(); win.clearTimeout(soon); }));
	// standing still, nothing redraws by itself: look now and then, so a block the page changed under moves away
	const watch = win.setInterval(() => { if (still() && showing() && blocks.length) { kick(); } }, LOOK_STILL_MS);
	store.add(toDisposable(() => win.clearInterval(watch)));

	// the first frame waits for a size: the part may still be laying out, or hidden (the ResizeObserver brings it)
	// (its own handle: a kick, which cancels `frame`, must not cancel it; before, a page busy from the start, the
	// Assistant's home loading, kicked first and the blocks were never made)
	const first = win.requestAnimationFrame(() => { resize(); repaint?.(); });
	store.add(toDisposable(() => win.cancelAnimationFrame(first)));

	const me = {
		send: () => {
			if (fading) {
				return;
			}
			if (!chosen) {
				pick();
			}
			fading = performance.now();
			const theme = dark() ? 'dark' : 'light';
			// to the row's small icon, which draws the theme's colours (no plate there)
			flyToSessionRow(mainContainer, water, (chosen ?? []).map(c => ({ ...c.slot, c: DISPATCH_ICON_THEME[theme][c.slot.c] })), still());
			kick();
		},
	};
	current = me;
	store.add(toDisposable(() => { if (current === me) { current = undefined; } }));

	return {
		dispose: () => store.dispose(),
		exit: (onDidComplete: () => void) => {
			water.classList.add('exiting');
			const handle = win.setTimeout(() => { store.dispose(); onDidComplete(); }, 300);
			return toDisposable(() => { win.clearTimeout(handle); store.dispose(); });
		},
	};
}

/**
 * The icon, shrinking, flies to the new session's status icon in the sessions list. On its own layer over
 * the whole window: the page (and the swarm with it) goes away as soon as the session opens.
 */
function flyToSessionRow(mainContainer: HTMLElement, water: HTMLElement, icon: { x: number; y: number; w: number; h: number; r: number; o: number; c: string }[], reduced: boolean): void {
	if (reduced || !icon.length) {
		return;
	}
	const win = getWindow(mainContainer);
	const origin = water.getBoundingClientRect();
	const from = icon.map(p => ({ ...p, x: origin.left + p.x, y: origin.top + p.y }));
	const layer = mainContainer.appendChild($('canvas.dispatch-swarm-fly')) as HTMLCanvasElement;
	const dpr = Math.min(2, win.devicePixelRatio || 1);
	const W = mainContainer.clientWidth, H = mainContainer.clientHeight;
	layer.width = Math.round(W * dpr);
	layer.height = Math.round(H * dpr);
	layer.style.width = `${W}px`;
	layer.style.height = `${H}px`;
	const ctx = layer.getContext('2d')!;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const base = mainContainer.getBoundingClientRect();
	const cx = from.reduce((a, p) => a + p.x, 0) / from.length, cy = from.reduce((a, p) => a + p.y, 0) / from.length;
	const start = performance.now();
	let target: { x: number; y: number } | undefined;
	const find = () => {
		const el = mainContainer.querySelector('.monaco-list-row.selected .session-icon') ?? mainContainer.querySelector('.session-icon');
		if (el) {
			const r = el.getBoundingClientRect();
			target = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		}
	};
	const step = (now: number) => {
		find(); // the row appears once the session exists: follow it
		const k = Math.min(1, (now - start) / FLY_MS), e = 1 - Math.pow(1 - k, 3);
		const tx = target?.x ?? base.left + 34, ty = target?.y ?? base.top + H * 0.3;
		const scale = 1 + (3 / ICON.blocks[0].w - 1) * e;	// the icon's blocks down to the 16px status icon's 3px
		ctx.clearRect(0, 0, W, H);
		for (const p of from) {
			const x = cx + (tx - cx) * e + (p.x - cx) * scale - base.left;
			const y = cy + (ty - cy) * e + (p.y - cy) * scale - base.top;
			ctx.globalAlpha = p.o * (1 - 0.3 * e);
			ctx.fillStyle = p.c;
			ctx.beginPath(); ctx.roundRect(x - p.w * scale / 2, y - p.h * scale / 2, p.w * scale, p.h * scale, p.r * scale); ctx.fill();
		}
		if (k < 1) {
			win.requestAnimationFrame(step);
		} else {
			layer.remove();
		}
	};
	win.requestAnimationFrame(step);
}
