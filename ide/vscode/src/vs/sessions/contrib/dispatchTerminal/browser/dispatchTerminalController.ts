/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: one terminal session's screen, joined to its terminal in the daemon.
 *
 *  The screen (dispatchXterm.ts) is made the first time the session is shown, and it then attaches: the daemon
 *  sends what the terminal shows now (with its scrollback) and then the live output. The screen stays when
 *  another session is shown, so coming back is instant. Typing goes straight to the daemon.
 *
 *  Pasting follows Orca (https://github.com/stablyai/orca, terminal-clipboard-paste.ts; MIT, notice in
 *  dispatchTerminalModel.ts): text is pasted as one block; when the clipboard holds only a picture (a screenshot),
 *  the picture is saved as a file and its path is pasted, which is how Claude Code, Codex and the other agents
 *  take pictures in their terminal (⌘V, not Ctrl+V). Files dropped on the terminal paste their paths.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, trackFocus } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { copyableSelection, ITermdSessionInfo, PaneCommand, pasteBytes, shellQuotePath, TerminalShortcut } from './dispatchTerminalModel.js';
import { registerTerminalLinks } from './dispatchTerminalLinks.js';
import { DispatchXterm } from './dispatchXterm.js';
import { ITermdSnapshot, TermdClient } from './termdClient.js';

/** How much drawn output the window collects before it tells the daemon (VS Code's terminal acks every 5 000). */
const ACK_CHARS = 16 * 1024;

export class DispatchTerminalController extends Disposable {
	readonly id: string;
	private _xterm: Promise<DispatchXterm> | undefined;
	private _attached: Promise<void> | undefined;
	private _ready = false;
	private _queued: string[] = [];
	/** The space the screen has, until it can be measured. */
	private _size: { width: number; height: number } | undefined;

	private readonly _onDidFocus = this._register(new Emitter<boolean>());
	readonly onDidFocus = this._onDidFocus.event;
	private readonly _onContextMenu = this._register(new Emitter<MouseEvent>());
	readonly onContextMenu = this._onContextMenu.event;
	private readonly _onAway = this._register(new Emitter<{ from: number; to: number }>());
	/** The terminal kept running while no window showed it (Dispatch was closed): the view says so once. */
	readonly onAway = this._onAway.event;
	away: { from: number; to: number } | undefined;
	/** Which view of this session was shown last: the terminal, or the same conversation as a chat. */
	viewMode: 'chat' | 'terminal' = 'terminal';
	private readonly _onDidRequestView = this._register(new Emitter<'chat' | 'terminal'>());
	/** "Show as Chat" from the menu: the view switches. */
	readonly onDidRequestView = this._onDidRequestView.event;

	showView(mode: 'chat' | 'terminal'): void {
		this._onDidRequestView.fire(mode);
	}

	/** Ends the program and starts it again in the same terminal, going on with its conversation where it can. */
	async restart(): Promise<void> {
		await this._client.request('respawn', { session: this.id });
	}
	private readonly _onDispose = this._register(new Emitter<void>());
	readonly onDispose = this._onDispose.event;

	constructor(
		private readonly _client: TermdClient,
		public info: ITermdSessionInfo,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this.id = info.id;
	}

	/** The folder the shell is in now, as far as it says, else where it started. */
	get cwd(): string | undefined {
		return this._current?.cwd ?? this.info.cwd;
	}

	private _current: DispatchXterm | undefined;

	get xterm(): DispatchXterm | undefined {
		return this._current;
	}

	private _ensureXterm(): Promise<DispatchXterm> {
		this._xterm ??= (async () => {
			const x = await DispatchXterm.create(this._instantiation, this._config, this.info.cols ?? 100, this.info.rows ?? 30);
			this._register(x);
			this._current = x;
			x.hasPanes = () => this.hasPanes?.() ?? false;
			this._register(x.onInput(data => this.write(data)));
			this._register(x.onResize(({ cols, rows }) => this._client.send('resize', { session: this.id, cols, rows })));
			this._register(x.onShortcut(shortcut => this._shortcut(shortcut).catch(e => this._log.warn('[dispatch terminal] shortcut', shortcut, e))));
			return x;
		})();
		return this._xterm;
	}

	/** Shows the screen in `parent`, attaching to the daemon the first time. */
	async show(parent: HTMLElement): Promise<void> {
		const x = await this._ensureXterm();
		x.refreshSettings();
		const first = !x.element.isConnected && !this._attached;
		await x.attachTo(parent);
		if (first) {
			this._wireScreen(x);
		}
		if (this._size) {
			x.layout(this._size.width, this._size.height);
		}
		this._attached ??= this._attach(x);
		await this._attached;
	}

	private _wired = false;

	private _wireScreen(x: DispatchXterm): void {
		if (this._wired) {
			return;
		}
		this._wired = true;
		const el = x.element;
		const focus = this._register(trackFocus(el));
		this._register(focus.onDidFocus(() => this._onDidFocus.fire(true)));
		this._register(focus.onDidBlur(() => this._onDidFocus.fire(false)));
		this._register(addDisposableListener(el, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this._onContextMenu.fire(e);
		}));
		// a picture on the clipboard (from the Edit menu's Paste, which does not go through ⌘V's command)
		this._register(addDisposableListener(el, 'paste', (e: ClipboardEvent) => {
			const data = e.clipboardData;
			if (!data || data.getData('text/plain')) {
				return;
			}
			const image = [...data.files].find(f => f.type.startsWith('image/'));
			if (image) {
				e.preventDefault();
				e.stopImmediatePropagation();
				void image.arrayBuffer().then(buf => this.pasteImage(new Uint8Array(buf), image.type));
			}
		}, true));
		this._register(addDisposableListener(el, EventType.DRAG_OVER, (e: DragEvent) => {
			if (e.dataTransfer?.types.includes('Files')) {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'copy';
			}
		}));
		this._register(addDisposableListener(el, EventType.DROP, (e: DragEvent) => {
			const files = [...(e.dataTransfer?.files ?? [])];
			const paths = files.map(f => getPathForFile(f)).filter((p): p is string => !!p);
			if (paths.length) {
				e.preventDefault();
				e.stopPropagation();
				this.paste(paths.map(shellQuotePath).join(' ') + ' ');
				x.raw.focus();
			}
		}));
		this._register(registerTerminalLinks(this._instantiation, x, () => this.cwd, this.info.cwd));
	}

	private async _attach(x: DispatchXterm): Promise<void> {
		try {
			const { info, snapshot, away } = await this._client.request<{ info: ITermdSessionInfo; snapshot: ITermdSnapshot; away?: { from: number; to: number } }>('attach', { session: this.id, cols: x.raw.cols, rows: x.raw.rows, flow: true });
			this.info = info;
			this._paint(x, snapshot);
			if (away) {
				this.away = away;
				this._onAway.fire(away);
			}
		} catch (e) {
			this._attached = undefined;
			this._log.warn('[dispatch terminal] attach', e);
			x.raw.write(`\r\n\x1b[2m${String((e as Error)?.message ?? e)}\x1b[0m\r\n`);
		}
	}

	private _paint(x: DispatchXterm, snapshot: ITermdSnapshot): void {
		x.raw.reset();
		if (snapshot.cols && snapshot.rows && (snapshot.cols !== x.raw.cols || snapshot.rows !== x.raw.rows)) {
			x.raw.resize(snapshot.cols, snapshot.rows);
		}
		x.raw.write(snapshot.ansi);
		this._ready = true;
		for (const chunk of this._queued.splice(0)) {
			x.raw.write(chunk, () => this._ack(chunk.length));
		}
		x.fit();
	}

	/** After the connection to the daemon came back: the screen is drawn again from what the daemon has. */
	async reattach(): Promise<void> {
		if (!this._attached || !this._current) {
			return;
		}
		this._ready = false;
		this._attached = this._attach(this._current);
		await this._attached;
	}

	private _drawn = 0;

	/**
	 * Output from the daemon. Once the screen has drawn it, the daemon is told (flow control, kanban app/termd
	 * session.cjs): a program flooding output waits for the screen instead of piling up in the window.
	 */
	output(data: string): void {
		if (this._ready && this._current) {
			this._current.raw.write(data, () => this._ack(data.length));
		} else {
			this._queued.push(data);
		}
	}

	private _ack(chars: number): void {
		this._drawn += chars;
		if (this._drawn >= ACK_CHARS) {
			this._client.send('ack', { session: this.id, chars: this._drawn });
			this._drawn = 0;
		}
	}

	hide(): void {
		this._current?.element.remove();
	}

	layout(width: number, height: number): void {
		this._size = { width, height };
		this._current?.layout(width, height);
	}

	focus(): void {
		this._current?.raw.focus();
	}

	private readonly _onPaneCommand = this._register(new Emitter<PaneCommand>());
	/** ⌘D, ⌘⇧D, ⌘W, ⌘], ⌘[, ⌘⇧Enter: the provider splits, closes and moves between the session's panes. */
	readonly onPaneCommand = this._onPaneCommand.event;

	/** Set by the provider: the session this screen belongs to has more than one pane. */
	hasPanes: (() => boolean) | undefined;

	paneCommand(cmd: PaneCommand): void {
		this._onPaneCommand.fire(cmd);
	}

	private readonly _onFind = this._register(new Emitter<void>());
	/** ⌘F: dispatchTerminalActions.ts shows the find box. */
	readonly onFind = this._onFind.event;

	/** A shortcut run from the command palette or a key binding (the text size). */
	shortcut(shortcut: TerminalShortcut): Promise<void> {
		return this._shortcut(shortcut);
	}

	private async _shortcut(shortcut: TerminalShortcut): Promise<void> {
		this._log.trace('[dispatch terminal] shortcut', shortcut);
		switch (shortcut) {
			case 'paste': return this.pasteClipboard();
			case 'copy': {
				const text = this.copyText;
				if (text) {
					await this._clipboard.writeText(text);
				}
				return;
			}
			case 'selectAll': return this.selectAll();
			case 'clear': return this.clear();
			case 'find': return this._onFind.fire();
			case 'zoomIn': return this._current?.setZoom(1);
			case 'zoomOut': return this._current?.setZoom(-1);
			case 'zoomReset': return this._current?.setZoom('reset');
			// after the key's own handling: closing a pane disposes the screen whose key handler this runs in
			default: mainWindow.setTimeout(() => this._onPaneCommand.fire(shortcut), 0); return;
		}
	}

	/** Keystrokes and pastes for the program. */
	write(data: string): void {
		this._client.send('write', { session: this.id, data });
	}

	/** Text pasted as one block (a bracketed paste when the program asked for one). */
	paste(text: string): void {
		const x = this._current;
		this.write(pasteBytes(text, !!x?.raw.modes.bracketedPasteMode));
	}

	/** ⌘V: the text on the clipboard, or, when there is only a picture, the picture as a file. */
	async pasteClipboard(): Promise<void> {
		const text = await this._clipboard.readText();
		if (text) {
			this.paste(text);
			return;
		}
		// the daemon copies the picture off the Mac's clipboard itself (osascript): it reads every kind macOS puts there
		try {
			const { path } = await this._client.request<{ path: string }>('clipboardImage');
			if (path) {
				this.paste(shellQuotePath(path) + ' ');
				return;
			}
		} catch (e) {
			this._log.warn('[dispatch terminal] the picture on the clipboard', e);
		}
		let image: Uint8Array | undefined;
		try {
			image = await this._clipboard.readImage();
		} catch (e) {
			this._log.warn('[dispatch terminal] reading a picture from the clipboard', e);
		}
		if (image?.byteLength) {
			await this.pasteImage(image, 'image/png');
		}
	}

	async pasteImage(bytes: Uint8Array, mime: string): Promise<void> {
		try {
			const { path } = await this._client.request<{ path: string }>('saveImage', { data: encodeBase64(VSBuffer.wrap(bytes)), mime });
			this.paste(shellQuotePath(path) + ' ');
		} catch (e) {
			this._notifications.warn(`Dispatch could not paste the picture: ${(e as Error)?.message ?? e}`);
		}
	}

	get selection(): string {
		return this._current?.raw.getSelection() ?? '';
	}

	/** The selection as a copy puts it on the clipboard (without an agent's left margin). */
	get copyText(): string {
		return copyableSelection(this.selection);
	}

	selectAll(): void {
		this._current?.raw.selectAll();
	}

	/** Clears the screen and what scrolled away, here and in the daemon's copy; the program is told to redraw. */
	async clear(): Promise<void> {
		this._current?.raw.clear();
		await this._client.request('clear', { session: this.id }).catch(() => undefined);
		// Ctrl+L: the shell or the agent draws its prompt again on the empty screen
		this.write('\x0c');
	}

	/** Back to a fresh terminal state (colors, modes); the program is asked to redraw. */
	reset(): void {
		this._current?.raw.reset();
		this.write('\x0c');
	}

	override dispose(): void {
		this._onDispose.fire();
		super.dispose();
	}

	/** The last lines of what the terminal showed, as plain text. */
	async text(lines = 800): Promise<string> {
		try {
			const { text } = await this._client.request<{ text: string }>('text', { session: this.id, lines });
			return text;
		} catch {
			return '';
		}
	}
}
