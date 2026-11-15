/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: file paths and web links in a terminal session can be clicked.
 *
 *  As in Orca (https://github.com/stablyai/orca, terminal-file-link-actions.ts; MIT, notice in
 *  dispatchTerminalModel.ts): a click on a path opens a small menu (Open in Dispatch, Open with Default App, Reveal in
 *  Finder, Copy Path); ⌘-click opens the file straight away and ⇧⌘-click opens it with the Mac's default app. A
 *  web link offers Open Link and Copy Link; ⌘-click opens it. Paths are found the way chat replies find them
 *  (dispatchPathDetector.ts) and only paths that exist become links: absolute ones as they are, ~/ from home, the
 *  rest from the folder the shell is in (when it says) and the folder the terminal started in. A path wrapped
 *  over two lines is one link.
 *--------------------------------------------------------------------------------------------*/

import type { IBufferCellPosition, ILink, Terminal as RawXterm } from '@xterm/xterm';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { findPathCandidates } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchPathDetector.js';
import { DispatchXterm } from './dispatchXterm.js';

const URL_RE = /\b(?:https?|file):\/\/[^\s<>"'`]+/g;
const CACHE_MS = 10_000;
const MAX_LINE = 4000;

interface ILogicalLine {
	readonly text: string;
	/** For every UTF-16 unit of `text`: its cell (1-based x, 1-based y) and how wide the cell is. */
	readonly cells: readonly { x: number; y: number; w: number }[];
}

/** The line `row` (0-based) belongs to, with the rows it wraps onto, and where each character sits. */
export function logicalLine(raw: RawXterm, row: number): ILogicalLine {
	const buffer = raw.buffer.active;
	let first = row;
	while (first > 0 && buffer.getLine(first)?.isWrapped) {
		first--;
	}
	let text = '';
	const cells: { x: number; y: number; w: number }[] = [];
	for (let y = first; y < buffer.length && text.length < MAX_LINE; y++) {
		const line = buffer.getLine(y);
		if (!line || (y > first && !line.isWrapped)) {
			break;
		}
		for (let x = 0; x < line.length; x++) {
			const cell = line.getCell(x);
			if (!cell) {
				continue;
			}
			const w = cell.getWidth();
			if (w === 0) {
				continue;
			}
			const chars = cell.getChars() || ' ';
			for (let i = 0; i < chars.length; i++) {
				cells.push({ x: x + 1, y: y + 1, w });
			}
			text += chars;
		}
	}
	const trimmed = text.replace(/\s+$/, '');
	return { text: trimmed, cells: cells.slice(0, trimmed.length) };
}

function range(line: ILogicalLine, start: number, end: number): { start: IBufferCellPosition; end: IBufferCellPosition } {
	const a = line.cells[start];
	const b = line.cells[end - 1];
	return { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } };
}

/** A web link without the punctuation that ends the sentence around it. */
function trimUrl(url: string): string {
	let u = url.replace(/[.,;:!?'"]+$/, '');
	while (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) {
		u = u.slice(0, -1);
	}
	return u;
}

interface IResolved {
	readonly uri: URI;
	readonly isDirectory: boolean;
}

class TerminalLinks extends Disposable {
	private readonly _cache = new Map<string, { at: number; value: Promise<IResolved | undefined> }>();

	constructor(
		private readonly _xterm: DispatchXterm,
		private readonly _cwd: () => string | undefined,
		private readonly _startFolder: string | undefined,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
		@ICommandService private readonly _commands: ICommandService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IContextMenuService private readonly _menus: IContextMenuService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@INativeHostService private readonly _native: INativeHostService,
	) {
		super();
		this._register(_xterm.raw.registerLinkProvider({
			provideLinks: (row, callback) => {
				this._links(row - 1).then(callback, () => callback(undefined));
			},
		}));
		// links a program marks itself (OSC 8: Claude Code, ls --hyperlink, gh): the same small menu, ⌘-click opens
		_xterm.raw.options.linkHandler = {
			allowNonHttpProtocols: true,
			activate: (e, uri) => void this._activateMarked(e, uri),
		};
		this._register(toDisposable(() => { _xterm.raw.options.linkHandler = null; }));
	}

	private async _activateMarked(e: MouseEvent, text: string): Promise<void> {
		let uri: URI;
		try {
			uri = URI.parse(text);
		} catch {
			return;
		}
		const none = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } };
		if (uri.scheme === 'file') {
			const target = await this._resolve(uri.fsPath);
			if (target) {
				this._fileLink(uri.fsPath, target, undefined, undefined, none).activate(e, uri.fsPath);
			}
			return;
		}
		if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
			this._webLink(text, none).activate(e, text);
		}
	}

	private async _links(row: number): Promise<ILink[] | undefined> {
		const line = logicalLine(this._xterm.raw, row);
		if (!line.text) {
			return undefined;
		}
		const onRow = (start: number, end: number) => line.cells.slice(start, end).some(c => c.y === row + 1);
		const links: ILink[] = [];
		for (const m of line.text.matchAll(URL_RE)) {
			const url = trimUrl(m[0]);
			const start = m.index!;
			if (url.length > 'https://'.length && onRow(start, start + url.length)) {
				links.push(this._webLink(url, range(line, start, start + url.length)));
			}
		}
		const candidates = findPathCandidates(line.text).filter(c => onRow(c.start, c.end));
		const found = await Promise.all(candidates.map(c => this._resolve(c.path)));
		candidates.forEach((c, i) => {
			const target = found[i];
			if (target && !links.some(l => overlaps(l, range(line, c.start, c.end)))) {
				links.push(this._fileLink(line.text.slice(c.start, c.end), target, c.line, c.column, range(line, c.start, c.end)));
			}
		});
		return links.length ? links : undefined;
	}

	private _resolve(path: string): Promise<IResolved | undefined> {
		const cwd = this._cwd();
		const key = `${cwd ?? ''}\n${path}`;
		const hit = this._cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS) {
			return hit.value;
		}
		const value = (async () => {
			const home = this._paths.userHome({ preferLocal: true });
			const tries: URI[] = [];
			if (path.startsWith('/')) {
				tries.push(URI.file(path));
			} else if (path.startsWith('~/')) {
				tries.push(URI.joinPath(home, path.slice(2)));
			} else {
				for (const base of [cwd, this._startFolder]) {
					if (base && !tries.some(t => t.fsPath === URI.joinPath(URI.file(base), path).fsPath)) {
						tries.push(URI.joinPath(URI.file(base), path));
					}
				}
			}
			for (const uri of tries) {
				try {
					const stat = await this._files.stat(uri);
					return { uri, isDirectory: stat.isDirectory };
				} catch {
					// not there: the next folder
				}
			}
			return undefined;
		})();
		this._cache.set(key, { at: Date.now(), value });
		return value;
	}

	private _menu(e: MouseEvent, actions: IAction[]): void {
		this._menus.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
			onHide: () => this._xterm.raw.focus(),
		});
	}

	private _webLink(url: string, r: { start: IBufferCellPosition; end: IBufferCellPosition }): ILink {
		const open = () => void this._opener.open(URI.parse(url), { openExternal: false, allowContributedOpeners: true });
		return {
			range: r,
			text: url,
			decorations: { underline: true, pointerCursor: true },
			activate: (e: MouseEvent) => {
				if (e.metaKey) {
					open();
					return;
				}
				this._menu(e, [
					new Action('dispatch.terminal.link.open', 'Open Link', undefined, true, async () => open()),
					new Action('dispatch.terminal.link.copy', 'Copy Link', undefined, true, async () => this._clipboard.writeText(url)),
				]);
			},
		};
	}

	private _fileLink(text: string, target: IResolved, line: number | undefined, column: number | undefined, r: { start: IBufferCellPosition; end: IBufferCellPosition }): ILink {
		const open = () => void this._commands.executeCommand('_dispatch.openPath', target.uri.toString(), { line, column });
		const openDefault = () => void this._opener.open(target.uri, { openExternal: true });
		const reveal = () => void this._native.showItemInFolder(target.uri.fsPath);
		return {
			range: r,
			text,
			decorations: { underline: true, pointerCursor: true },
			activate: (e: MouseEvent) => {
				if (e.metaKey && e.shiftKey) {
					openDefault();
					return;
				}
				if (e.metaKey) {
					open();
					return;
				}
				const actions: IAction[] = [
					new Action('dispatch.terminal.path.open', target.isDirectory ? 'Open Folder' : line ? `Open in Dispatch at Line ${line}` : 'Open in Dispatch', undefined, true, async () => open()),
				];
				if (!target.isDirectory) {
					actions.push(new Action('dispatch.terminal.path.default', 'Open with Default App', undefined, true, async () => openDefault()));
				}
				actions.push(
					new Action('dispatch.terminal.path.reveal', 'Reveal in Finder', undefined, true, async () => reveal()),
					new Separator(),
					new Action('dispatch.terminal.path.copy', 'Copy Path', undefined, true, async () => this._clipboard.writeText(target.uri.fsPath)),
				);
				this._menu(e, actions);
			},
		};
	}
}

function overlaps(link: ILink, r: { start: IBufferCellPosition; end: IBufferCellPosition }): boolean {
	const key = (p: IBufferCellPosition) => p.y * 100000 + p.x;
	return key(link.range.start) <= key(r.end) && key(r.start) <= key(link.range.end);
}

/** Makes the paths and web links in `xterm` clickable. */
export function registerTerminalLinks(instantiation: IInstantiationService, xterm: DispatchXterm, cwd: () => string | undefined, startFolder: string | undefined): IDisposable {
	const links = instantiation.createInstance(TerminalLinks, xterm, cwd, startFolder);
	return toDisposable(() => links.dispose());
}
