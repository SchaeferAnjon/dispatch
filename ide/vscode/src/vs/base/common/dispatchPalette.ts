/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the app icon (app/icons/icon.icns, the Dock's; drawn from kanban design/icon.svg) as data: its
 *  colours, its ten blocks, its live dot and its plate. The one source for every place that draws the icon (laid out
 *  by base/common/dispatchIcon.ts: the Assistant's mark, the loading splash, the empty editor and Files view, the new
 *  session page, a session row's falling blocks) and for every state colour
 *  (DESIGN.md「图标色即图例」; kanban preferences「图标和 Dock 统一」「状态色用图标配色」). Nothing else writes
 *  these colours down: CSS reads the `--dispatch-icon-*` and `--dispatch-state-*` variables (dispatchPaletteCss,
 *  installed by base/browser/dispatchPalette.ts), code reads the constants here. ide/tests/palette.test.mjs
 *  holds the rest of the sources to that.
 *--------------------------------------------------------------------------------------------*/

/** The icon's eight colours, exactly as the Dock shows them. */
export const DISPATCH_ICON_COLORS = {
	gray: '#8a857c',
	amber: '#c28a12',
	green: '#2e8b57',
	blue: '#1d5fd1',
	cream: '#f4f3ef',
	coral: '#c9683f',
	teal: '#2f6f73',
	purple: '#6e56cf',
} as const;

export type DispatchIconColor = keyof typeof DISPATCH_ICON_COLORS;

export interface IDispatchIconBlock {
	readonly col: number;
	readonly row: number;
	/** The block's box in the icon's units (DISPATCH_ICON_SIZE). */
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly rx: number;
	readonly color: DispatchIconColor;
	readonly opacity: number;
}

/**
 * The icon's ten blocks, in its own units (design/icon.svg's 1024 grid, from the corner of the blocks): a row of
 * four squares (the board's four columns: to do, waiting, working, handed on), a row of four cards and a row of
 * two, the cards in the agents' colours and cream.
 */
export const DISPATCH_ICON_BLOCKS: readonly IDispatchIconBlock[] = [
	{ col: 0, row: 0, x: 0, y: 0, w: 120, h: 120, rx: 26, color: 'gray', opacity: 1 },
	{ col: 1, row: 0, x: 160, y: 0, w: 120, h: 120, rx: 26, color: 'amber', opacity: 1 },
	{ col: 2, row: 0, x: 320, y: 0, w: 120, h: 120, rx: 26, color: 'green', opacity: 1 },
	{ col: 3, row: 0, x: 480, y: 0, w: 120, h: 120, rx: 26, color: 'blue', opacity: 1 },
	{ col: 0, row: 1, x: 0, y: 160, w: 120, h: 72, rx: 18, color: 'cream', opacity: 0.92 },
	{ col: 1, row: 1, x: 160, y: 160, w: 120, h: 72, rx: 18, color: 'coral', opacity: 1 },
	{ col: 2, row: 1, x: 320, y: 160, w: 120, h: 72, rx: 18, color: 'teal', opacity: 1 },
	{ col: 3, row: 1, x: 480, y: 160, w: 120, h: 72, rx: 18, color: 'purple', opacity: 1 },
	{ col: 0, row: 2, x: 0, y: 256, w: 120, h: 72, rx: 18, color: 'cream', opacity: 0.55 },
	{ col: 1, row: 2, x: 160, y: 256, w: 120, h: 72, rx: 18, color: 'cream', opacity: 0.92 },
];

/** The Dock file's dot at the bottom right, a green disc with a cream centre (app/icons/icon.png; drawings in the
 *  app do not copy it: they draw DISPATCH_ICON_RUNNING_DOT). */
export const DISPATCH_ICON_DOT = { cx: 564, cy: 484, r: 58, inner: 26, color: 'green', center: 'cream' } as const;

/**
 * The dot every drawing of the icon in the app has (kanban preference「绿点小而呼吸」: the person found the Dock's dot
 * too big and too far off): a small green dot, 3/8 of a block across, tucked into the blocks' bottom right corner, in
 * the third row's empty place under the last column; it breathes (base/common/dispatchIcon.ts).
 */
export const DISPATCH_ICON_RUNNING_DOT = { cx: 577.5, cy: 292, r: 22.5, color: 'green' } as const;

/** The blocks, in the icon's units: every drawing in the app fits this box (the running dot is inside it). */
export const DISPATCH_ICON_SIZE = { w: 600, h: 328 } as const;

/**
 * The dark plate of the Dock's icon (design/icon.svg's squircle, 896 of its 1024 grid; app/icons/icon.png draws it 412
 * of 512): its size and corner, and where the blocks' corner is on it. The app draws it only as the outline of the
 * Agents button's glyph (dispatch-agent-icon.svg); ide/tests/palette.test.mjs measures the blocks against icon.png on it.
 */
export const DISPATCH_ICON_PLATE = { size: 896, rx: 200, x: 148, y: 186 } as const;

/** What each state is drawn in: one of the icon's colours (DESIGN.md「图标色即图例」). */
export type DispatchStateColor = 'working' | 'waiting' | 'done' | 'handoff' | 'plan' | 'stopped' | 'todo';

export const DISPATCH_STATE_ICON_COLOR: Readonly<Record<DispatchStateColor, DispatchIconColor>> = {
	working: 'green',
	waiting: 'amber',
	done: 'teal',
	handoff: 'blue',
	plan: 'purple',
	stopped: 'coral',
	todo: 'gray',
};

type Theme = 'light' | 'dark';

/**
 * The icon's colours per theme. Light and dark are the icon's own, with three exceptions, each the same hue and
 * chroma with only its lightness moved: on a light background the cream cards would vanish, so they take the
 * lightness that keeps 1.45:1 on the side bar; the amber of a waiting state darkens until it keeps 3:1 on a
 * hovered row (#f2f1f0); on a dark background teal, blue and purple lighten until they keep 3:1 on a hovered
 * row (#292524). The Assistant's mark is the icon itself and draws the icon's own colours (`--dispatch-icon-*`),
 * the states the adjusted ones (`--dispatch-state-*`).
 */
export const DISPATCH_ICON_THEME: Readonly<Record<Theme, Readonly<Record<DispatchIconColor, string>>>> = {
	light: { ...DISPATCH_ICON_COLORS, cream: '#d1d1cd' },
	dark: { ...DISPATCH_ICON_COLORS },
};

export const DISPATCH_STATE_THEME: Readonly<Record<Theme, Readonly<Record<DispatchIconColor, string>>>> = {
	light: { ...DISPATCH_ICON_THEME.light, amber: '#b88100' },
	dark: { ...DISPATCH_ICON_THEME.dark, teal: '#3a797d', blue: '#286add', purple: '#725bd4' },
};

/** A state's colour in a theme, for code that paints (a canvas, an inline style). */
export function dispatchStateColor(state: DispatchStateColor, dark: boolean): string {
	return DISPATCH_STATE_THEME[dark ? 'dark' : 'light'][DISPATCH_STATE_ICON_COLOR[state]];
}

/**
 * The agents' identity colours (kanban DESIGN.md: the avatars' `--claude --codex --opencode --pi --cursor`), by the
 * agent's id in transcripts. Three of them are the icon's own cards (Claude the coral, Codex the teal, ZCode the
 * purple); the dark theme takes the lighter ones the avatars use there. Charts that tell engines apart (the Usage
 * page) read them as `--dispatch-engine-<agent>` and soften them toward the background themselves.
 */
export const DISPATCH_ENGINE_THEME: Readonly<Record<Theme, Readonly<Record<string, string>>>> = {
	light: {
		'claude-code': DISPATCH_ICON_COLORS.coral, codex: DISPATCH_ICON_COLORS.teal, opencode: '#3b6fb6', pi: '#5b7f3a',
		zcode: DISPATCH_ICON_COLORS.purple, gemini: DISPATCH_ICON_COLORS.gray,
	},
	dark: {
		'claude-code': '#e08a62', codex: '#5fb0b3', opencode: '#7fa6e6', pi: '#9cc46a', zcode: '#a08cff', gemini: DISPATCH_ICON_COLORS.gray,
	},
};

/**
 * The variables, light on `.monaco-workbench` and dark on its dark themes: `--dispatch-icon-<colour>` (the icon's,
 * for drawings of the icon), `--dispatch-state-<state>` (for everything that says a state) and
 * `--dispatch-engine-<agent>` (charts that tell the agents apart).
 */
export function dispatchPaletteCss(): string {
	const vars = (t: Theme) => [
		...Object.entries(DISPATCH_ICON_THEME[t]).map(([k, v]) => `--dispatch-icon-${k}: ${v};`),
		...Object.entries(DISPATCH_STATE_ICON_COLOR).map(([state, c]) => `--dispatch-state-${state}: ${DISPATCH_STATE_THEME[t][c]};`),
		...Object.entries(DISPATCH_ENGINE_THEME[t]).map(([agent, v]) => `--dispatch-engine-${agent}: ${v};`),
	].join(' ');
	return [
		`.monaco-workbench { ${vars('light')} }`,
		`.monaco-workbench.vs-dark, .monaco-workbench.hc-black { ${vars('dark')} }`,
	].join('\n');
}
