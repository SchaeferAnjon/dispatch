/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the screen of a terminal session, an xterm.js set up the way Orca sets up its terminals.
 *
 *  From Orca (https://github.com/stablyai/orca; src/renderer/src/lib/pane-manager/pane-terminal-options.ts,
 *  pane-dom-creation.ts, pane-webgl-renderer.ts; Copyright (c) 2026 Lovecast Inc., MIT License, notice in
 *  dispatchTerminalModel.ts): the options (blinking block cursor that turns into an outline when the terminal is
 *  not focused, bold in bright colors, Option left for composing characters, a slim scrollbar, the kitty
 *  keyboard protocol, 10 000 lines kept), the addons (GPU drawing through WebGL with a fallback when the GPU
 *  context is lost, Unicode 11 widths so Chinese and emoji take the right number of cells, ligatures, inline
 *  images, search) and fitting the grid to the space. The fit follows xterm.js's FitAddon (Copyright (c) 2017 The
 *  xterm.js authors, MIT).
 *
 *  Dispatch's own: the colors and font come from the theme and the terminal settings (so the Dispatch theme and
 *  the Ghostty import apply), and the same xterm is reused when the session is shown again.
 *--------------------------------------------------------------------------------------------*/

import type { ITheme, Terminal as RawXterm } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { $, getWindow } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { importAMDNodeModule } from '../../../../amdX.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Extensions as ColorExtensions, editorBackground, editorForeground, editorSelectionBackground, IColorRegistry, scrollbarSliderActiveBackground, scrollbarSliderBackground, scrollbarSliderHoverBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { XtermAddonImporter } from '../../../../workbench/contrib/terminal/browser/xterm/xtermAddonImporter.js';
import { ansiColorIdentifiers, TERMINAL_BACKGROUND_COLOR, TERMINAL_CURSOR_BACKGROUND_COLOR, TERMINAL_CURSOR_FOREGROUND_COLOR, TERMINAL_FOREGROUND_COLOR, TERMINAL_INACTIVE_SELECTION_BACKGROUND_COLOR, TERMINAL_SELECTION_BACKGROUND_COLOR, TERMINAL_SELECTION_FOREGROUND_COLOR } from '../../../../workbench/contrib/terminal/common/terminalColorRegistry.js';
import { REBINDABLE_SHORTCUTS, resolveTerminalKey, shortcutOfCommand, TerminalShortcut, terminalShortcut } from './dispatchTerminalModel.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';

/** Orca's font chain: the Mac's own monospace first, then the Nerd Fonts agents' status lines use for symbols. */
const FALLBACK_FONTS = '"SF Mono", Menlo, Monaco, "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace';
const SCROLLBACK = 10_000;

/**
 * Lines kept to scroll back: 10 000 unless the person set "terminal.integrated.scrollback" themselves (VS Code's
 * own default of 1 000 is too short for an agent's output; Orca keeps 5 000 and lets it go to 50 000).
 */
function scrollbackOf(configuration: IConfigurationService): number {
	const set = configuration.inspect<number>('terminal.integrated.scrollback').userValue;
	return clampNumber(set, 1000, 100_000, SCROLLBACK);
}
const SCROLLBAR_WIDTH = 7;
const MIN_COLS = 12;
const MIN_ROWS = 3;

let xtermCtor: Promise<typeof RawXterm> | undefined;
function loadXterm(): Promise<typeof RawXterm> {
	xtermCtor ??= importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js').then(m => m.Terminal);
	return xtermCtor;
}

const addons = new XtermAddonImporter();

export class DispatchXterm extends Disposable {
	readonly element: HTMLElement;
	private _search: SearchAddon | undefined;
	private readonly _webgl = this._register(new MutableDisposable());
	private _opened = false;
	/** The folder the shell says it is in (OSC 7), when it says. */
	cwd: string | undefined;
	/** Set by the controller: the session has more than one pane (⌘W then closes this one). */
	hasPanes: (() => boolean) | undefined;

	private readonly _onInput = this._register(new Emitter<string>());
	/** What the person typed or pasted, to go to the program. */
	readonly onInput = this._onInput.event;
	private readonly _onShortcut = this._register(new Emitter<TerminalShortcut>());
	/** ⌘V, ⌘C, ⌘A, ⌘K, ⌘F while the terminal has the keyboard. */
	readonly onShortcut = this._onShortcut.event;
	private readonly _onResize = this._register(new Emitter<{ cols: number; rows: number }>());
	readonly onResize = this._onResize.event;

	constructor(
		readonly raw: RawXterm,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IThemeService private readonly _themes: IThemeService,
		@ILogService private readonly _log: ILogService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
	) {
		super();
		this.element = $('.dispatch-xterm');
		// the end-to-end scenarios read the screen through it (kanban app/scripts/ide-e2e/scenarios/terminal*.mjs)
		(this.element as HTMLElement & { xterm?: RawXterm }).xterm = raw;
		this._register(toDisposable(() => raw.dispose()));
		this._register(raw.onData(data => this._onInput.fire(data)));
		this._register(raw.onBinary(data => this._onInput.fire(data)));
		this._register(raw.onResize(size => this._onResize.fire(size)));
		raw.parser.registerOscHandler(7, data => {
			const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
			if (m) {
				try {
					this.cwd = decodeURIComponent(m[1]);
				} catch {
					this.cwd = m[1];
				}
			}
			return false;
		});
		raw.attachCustomKeyEventHandler(e => this._key(e));
		this._register(this._themes.onDidColorThemeChange(theme => { raw.options.theme = this._theme(theme); }));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fontFamily')) {
				this._applySettings();
			}
			if (e.affectsConfiguration('workbench.colorCustomizations')) {
				raw.options.theme = this._theme(this._themes.getColorTheme());
			}
		}));
	}

	/** A new screen; `cols` × `rows` until it is fitted to its space. */
	static async create(instantiation: IInstantiationService, configuration: IConfigurationService, cols: number, rows: number): Promise<DispatchXterm> {
		const Terminal = await loadXterm();
		const cursorStyle = cursorStyleOf(configuration.getValue<string>('terminal.integrated.cursorStyle'));
		const raw = new Terminal({
			cols,
			rows,
			allowProposedApi: true,
			cursorBlink: configuration.getValue<boolean>('terminal.integrated.cursorBlinking') ?? true,
			cursorStyle,
			// a bar or underline stays itself when the terminal is not focused; only a block becomes an outline
			cursorInactiveStyle: cursorStyle === 'block' ? 'outline' : cursorStyle,
			scrollback: scrollbackOf(configuration),
			allowTransparency: false,
			minimumContrastRatio: 1,
			// Option composes characters (@, € on many keyboards) instead of acting as Meta
			macOptionIsMeta: configuration.getValue<boolean>('terminal.integrated.macOptionIsMeta') ?? false,
			macOptionClickForcesSelection: true,
			rightClickSelectsWord: isMacintosh,
			drawBoldTextInBrightColors: true,
			scrollOnEraseInDisplay: true,
			scrollbar: { width: SCROLLBAR_WIDTH },
			vtExtensions: { kittyKeyboard: true },
		});
		const x = instantiation.createInstance(DispatchXterm, raw);
		x._applySettings();
		raw.options.theme = x._theme(x._themes.getColorTheme());
		return x;
	}

	/** The size and the rest of the terminal settings again (another terminal may have been zoomed meanwhile). */
	refreshSettings(): void {
		this._applySettings();
	}

	private _applySettings(): void {
		const c = this._config;
		const family = c.getValue<string>('terminal.integrated.fontFamily')?.trim() || '';
		const raw = this.raw;
		raw.options.fontFamily = family ? `${family}, ${FALLBACK_FONTS}` : FALLBACK_FONTS;
		raw.options.fontSize = clampNumber(c.getValue<number>('terminal.integrated.fontSize'), 6, 100, isMacintosh ? 12 : 14) + DispatchXterm.zoom;
		raw.options.lineHeight = clampNumber(c.getValue<number>('terminal.integrated.lineHeight'), 1, 3, 1);
		raw.options.scrollback = scrollbackOf(c);
		raw.options.letterSpacing = clampNumber(c.getValue<number>('terminal.integrated.letterSpacing'), -5, 20, 0);
		raw.options.fontWeight = (c.getValue<string>('terminal.integrated.fontWeight') || 'normal') as never;
		raw.options.fontWeightBold = (c.getValue<string>('terminal.integrated.fontWeightBold') || 'bold') as never;
		raw.options.cursorBlink = c.getValue<boolean>('terminal.integrated.cursorBlinking') ?? true;
		const cursorStyle = cursorStyleOf(c.getValue<string>('terminal.integrated.cursorStyle'));
		raw.options.cursorStyle = cursorStyle;
		raw.options.cursorInactiveStyle = cursorStyle === 'block' ? 'outline' : cursorStyle;
		raw.options.macOptionIsMeta = c.getValue<boolean>('terminal.integrated.macOptionIsMeta') ?? false;
		if (this._opened) {
			this.fit();
		}
	}

	/** ⌘= / ⌘- in a terminal: points added to the terminal font size, for every terminal of the window. */
	static zoom = 0;

	/** Sizes the text of this terminal (the others follow when they are shown or the settings change). */
	setZoom(delta: number | 'reset'): void {
		DispatchXterm.zoom = delta === 'reset' ? 0 : Math.max(-6, Math.min(24, DispatchXterm.zoom + delta));
		this._applySettings();
	}

	private _theme(theme: IColorTheme): ITheme {
		const color = (id: string) => theme.getColor(id)?.toString();
		// the window's warm stone, not the theme's black terminal: a terminal colour only when the person set one
		// (their own colour customisations, or the Ghostty look they took)
		const custom = this._config.getValue<Record<string, unknown>>('workbench.colorCustomizations') ?? {};
		const own = Object.entries(custom).some(([k, v]) => k === TERMINAL_BACKGROUND_COLOR || (k.startsWith('[') && !!v && typeof v === 'object' && TERMINAL_BACKGROUND_COLOR in (v as object)));
		const background = (own ? color(TERMINAL_BACKGROUND_COLOR) : undefined) ?? color(editorBackground);
		// on the window's own background the text is the window's own (the theme's terminal colours are made for its
		// black terminal: white text that would vanish on a light window); in a light window the sixteen colours are
		// VS Code's own for light backgrounds
		const onWindow = !own;
		const light = !isDark(theme.type);
		const foreground = onWindow ? color(editorForeground) : color(TERMINAL_FOREGROUND_COLOR);
		const registry = Registry.as<IColorRegistry>(ColorExtensions.ColorContribution);
		const ansi = ansiColorIdentifiers.map(id => onWindow && light ? registry.resolveDefaultColor(id, theme)?.toString() : color(id));
		return {
			background,
			foreground,
			cursor: onWindow ? foreground : color(TERMINAL_CURSOR_FOREGROUND_COLOR) ?? foreground,
			cursorAccent: onWindow ? background : color(TERMINAL_CURSOR_BACKGROUND_COLOR) ?? background,
			selectionBackground: onWindow ? color(editorSelectionBackground) : color(TERMINAL_SELECTION_BACKGROUND_COLOR),
			selectionInactiveBackground: color(TERMINAL_INACTIVE_SELECTION_BACKGROUND_COLOR),
			selectionForeground: color(TERMINAL_SELECTION_FOREGROUND_COLOR),
			overviewRulerBorder: '#00000000',
			scrollbarSliderBackground: color(scrollbarSliderBackground),
			scrollbarSliderHoverBackground: color(scrollbarSliderHoverBackground),
			scrollbarSliderActiveBackground: color(scrollbarSliderActiveBackground),
			black: ansi[0], red: ansi[1], green: ansi[2], yellow: ansi[3], blue: ansi[4], magenta: ansi[5], cyan: ansi[6], white: ansi[7],
			brightBlack: ansi[8], brightRed: ansi[9], brightGreen: ansi[10], brightYellow: ansi[11], brightBlue: ansi[12], brightMagenta: ansi[13], brightCyan: ansi[14], brightWhite: ansi[15],
		};
	}

	/**
	 * A pane, session or text-size shortcut as the person has it: the window's key bindings say which command the
	 * key is (Keyboard Shortcuts can change or remove each one); a key bound to something else is left to the window.
	 */
	private _rebindable(e: KeyboardEvent): TerminalShortcut | undefined {
		if (!this._keybindings) {
			const fallback = terminalShortcut(e);
			return fallback && REBINDABLE_SHORTCUTS.includes(fallback) ? fallback : undefined;
		}
		const event = new StandardKeyboardEvent(e);
		const r = this._keybindings.softDispatch(event, this.element);
		if (r.kind === ResultKind.KbFound) {
			return shortcutOfCommand(r.commandId);
		}
		// nothing matched (the window's idea of where the keyboard is can lag a pane switch): the default key still
		// counts when it is still bound to its command
		const fallback = terminalShortcut(e);
		if (!fallback || !REBINDABLE_SHORTCUTS.includes(fallback) || (fallback === 'closePane' && !this.hasPanes?.())) {
			return undefined;
		}
		const pressed = this._keybindings.resolveKeyboardEvent(event).getUserSettingsLabel();
		return this._keybindings.lookupKeybindings(`dispatch.terminal.${fallback}`).some(k => k.getUserSettingsLabel() === pressed) ? fallback : undefined;
	}

	private _key(e: KeyboardEvent): boolean {
		if (e.type !== 'keydown' || e.isComposing) {
			return true;
		}
		const own = e.metaKey ? this._rebindable(e) : undefined;
		if (own) {
			// answered here, before the window's own handling; closePane's binding holds only in a pane that is not the
			// session's first (its `when`), so ⌘W elsewhere is never ours
			e.preventDefault();
			e.stopPropagation();
			this._onShortcut.fire(own);
			return false;
		}
		const action = resolveTerminalKey(e);
		if (!action) {
			return true;
		}
		if (action.type === 'app') {
			const basic = terminalShortcut(e);
			const shortcut = basic && !REBINDABLE_SHORTCUTS.includes(basic) ? basic : undefined;
			if (shortcut) {
				// answered here, not through the window's key bindings, so nothing else in the window takes them
				e.preventDefault();
				e.stopPropagation();
				this._onShortcut.fire(shortcut);
			}
			// other ⌘ shortcuts are Dispatch's (close, new session ...): xterm leaves the event to the window
			return false;
		}
		e.preventDefault();
		e.stopPropagation();
		if (action.type === 'send') {
			this._onInput.fire(action.data);
		} else if (action.to === 'top') {
			this.raw.scrollToTop();
		} else {
			this.raw.scrollToBottom();
		}
		return false;
	}

	/** Puts the screen into `parent` (opening xterm the first time) and loads the addons that need a page. */
	async attachTo(parent: HTMLElement): Promise<void> {
		if (this.element.parentElement !== parent) {
			parent.appendChild(this.element);
		}
		if (this._opened) {
			return;
		}
		this._opened = true;
		this.raw.open(this.element);
		await this._loadAddons();
	}

	private async _loadAddons(): Promise<void> {
		const raw = this.raw;
		try {
			const Unicode11 = await addons.importAddon('unicode11');
			raw.loadAddon(new Unicode11());
			raw.unicode.activeVersion = '11';
		} catch (e) {
			this._log.warn('[dispatch terminal] unicode11', e);
		}
		try {
			const Search = await addons.importAddon('search');
			this._search = new Search();
			raw.loadAddon(this._search);
		} catch (e) {
			this._log.warn('[dispatch terminal] search', e);
		}
		const gpu = this._config.getValue<string>('terminal.integrated.gpuAcceleration');
		if (gpu !== 'off') {
			await this._loadWebgl();
		}
		if (this._config.getValue<{ enabled?: boolean } | boolean>('terminal.integrated.fontLigatures') !== undefined) {
			const lig = this._config.getValue<{ enabled?: boolean } | boolean>('terminal.integrated.fontLigatures');
			if (lig === true || (typeof lig === 'object' && lig?.enabled)) {
				try {
					const Ligatures = await addons.importAddon('ligatures');
					raw.loadAddon(new Ligatures());
				} catch (e) {
					this._log.warn('[dispatch terminal] ligatures', e);
				}
			}
		}
		try {
			// a program in the terminal copies with OSC 52 (tmux, Neovim, a program over ssh): it reaches the Mac's
			// clipboard, as in Orca; reading the clipboard that way is refused, so nothing in a terminal reads it unseen
			const Clipboard = await addons.importAddon('clipboard');
			const clipboard = this._clipboard;
			raw.loadAddon(new Clipboard(undefined, {
				async readText(): Promise<string> { return ''; },
				async writeText(type: string, text: string): Promise<void> {
					if (type !== 'p') {
						await clipboard.writeText(text);
					}
				},
			}));
		} catch (e) {
			this._log.warn('[dispatch terminal] clipboard', e);
		}
		try {
			const Image = await addons.importAddon('image');
			raw.loadAddon(new Image({ sixelSupport: true, iipSupport: true }));
		} catch (e) {
			this._log.warn('[dispatch terminal] images', e);
		}
		this.fit();
	}

	/** GPU drawing; when the GPU drops the context (sleep, driver reset) the terminal goes on with the DOM renderer. */
	private async _loadWebgl(): Promise<void> {
		try {
			const Webgl = await addons.importAddon('webgl');
			const webgl = new Webgl();
			this.raw.loadAddon(webgl);
			const lost = webgl.onContextLoss(() => {
				this._log.info('[dispatch terminal] the GPU context was lost; drawing without it');
				this._webgl.clear();
			});
			this._webgl.value = toDisposable(() => {
				lost.dispose();
				webgl.dispose();
			});
		} catch (e) {
			this._log.info('[dispatch terminal] drawing without the GPU', e);
			this._webgl.clear();
		}
	}

	get usesGpu(): boolean {
		return !!this._webgl.value;
	}

	/** Grid size for the space the screen has (xterm.js FitAddon's measure). */
	proposeSize(width: number, height: number): { cols: number; rows: number } | undefined {
		const core = (this.raw as unknown as { _core?: { _renderService?: { dimensions?: { css: { cell: { width: number; height: number } } } } } })._core;
		const cell = core?._renderService?.dimensions?.css.cell;
		if (!cell || !cell.width || !cell.height) {
			return undefined;
		}
		const style = getWindow(this.element).getComputedStyle(this.element);
		const padX = (parseInt(style.paddingLeft) || 0) + (parseInt(style.paddingRight) || 0);
		const padY = (parseInt(style.paddingTop) || 0) + (parseInt(style.paddingBottom) || 0);
		return {
			cols: Math.max(2, Math.floor((width - padX - SCROLLBAR_WIDTH) / cell.width)),
			rows: Math.max(1, Math.floor((height - padY) / cell.height)),
		};
	}

	private _size: { width: number; height: number } | undefined;

	layout(width: number, height: number): void {
		this._size = { width, height };
		this.fit();
	}

	fit(): void {
		if (!this._opened || !this._size) {
			return;
		}
		const size = this.proposeSize(this._size.width, this._size.height);
		// a pane being laid out passes through tiny sizes; a shell redrawing its prompt for 2 columns wipes lines above
		if (!size || size.cols < MIN_COLS || size.rows < MIN_ROWS) {
			return;
		}
		if (size.cols !== this.raw.cols || size.rows !== this.raw.rows) {
			this.raw.resize(size.cols, size.rows);
		}
	}

	findNext(term: string, previous: boolean, options: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }): boolean {
		if (!this._search || !term) {
			return false;
		}
		const decorations = this._findDecorations();
		return previous
			? this._search.findPrevious(term, { ...options, decorations })
			: this._search.findNext(term, { ...options, decorations });
	}

	clearFind(): void {
		this._search?.clearDecorations();
		this.raw.clearSelection();
	}

	get onFindResults() {
		return this._search?.onDidChangeResults;
	}

	private _findDecorations() {
		const theme = this._themes.getColorTheme();
		const c = (id: string) => theme.getColor(id)?.toString();
		return {
			matchBackground: c('terminal.findMatchHighlightBackground'),
			matchBorder: c('terminal.findMatchHighlightBorder'),
			matchOverviewRuler: c('terminalOverviewRuler.findMatchForeground') ?? '#d186167e',
			activeMatchBackground: c('terminal.findMatchBackground'),
			activeMatchBorder: c('terminal.findMatchBorder'),
			activeMatchColorOverviewRuler: c('terminalOverviewRuler.findMatchForeground') ?? '#A0A0A0CC',
		};
	}
}

function cursorStyleOf(v: string | undefined): 'block' | 'bar' | 'underline' {
	return v === 'line' ? 'bar' : v === 'underline' ? 'underline' : 'block';
}

function clampNumber(v: number | undefined, min: number, max: number, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
