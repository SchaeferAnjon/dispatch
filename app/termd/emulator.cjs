// Dispatch terminal daemon: a screen kept for every terminal, so a window that comes back sees what the
// terminal shows now, and a restart sees what it showed last.
//
// Ported from Orca (https://github.com/stablyai/orca), src/main/daemon/headless-emulator.ts.
// Copyright (c) 2026 Lovecast Inc. MIT License, full text in ORCA-LICENSE.txt next to this file.
// Kept: a headless xterm fed with everything the shell writes, Unicode 11 widths (they must match the
// window's, or Chinese and emoji rows shift on restore), the partial escape tail written last, the working
// folder from OSC 7 and the title from OSC 0/2. Dropped: query replies, Windows, mobile, link ranges.
'use strict';

const { advancePartialEscapeTail } = require('./escape-tail.cjs');

const DEFAULT_SCROLLBACK = 10000;

/** The folder an OSC 7 `file://host/path` names, or null. */
function osc7Folder(data) {
	const m = /^file:\/\/[^/]*(\/.*)$/.exec(String(data).trim());
	if (!m) {
		return null;
	}
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return m[1];
	}
}

class HeadlessEmulator {
	/**
	 * @param {{ Terminal: any, SerializeAddon: any, Unicode11Addon?: any }} xterm the headless xterm modules
	 * @param {{ cols: number, rows: number, scrollback?: number }} opts
	 */
	constructor(xterm, opts) {
		this.terminal = new xterm.Terminal({
			cols: opts.cols,
			rows: opts.rows,
			scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
			allowProposedApi: true,
			logLevel: 'off',
		});
		this.serializer = new xterm.SerializeAddon();
		this.terminal.loadAddon(this.serializer);
		if (xterm.Unicode11Addon) {
			this.terminal.loadAddon(new xterm.Unicode11Addon());
			this.terminal.unicode.activeVersion = '11';
		}
		this.cwd = null;
		this.title = null;
		this.partialEscapeTail = '';
		this.disposed = false;
		this.terminal.parser.registerOscHandler(7, data => {
			const folder = osc7Folder(data);
			if (folder) {
				this.cwd = folder;
			}
			return false;
		});
		this.terminal.onTitleChange(title => { this.title = title; });
	}

	/** Feeds the screen; resolves once xterm has parsed it. */
	write(data) {
		if (this.disposed) {
			return Promise.resolve();
		}
		if (this.writeSync(data)) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this.terminal.write(data, () => {
				this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data);
				resolve();
			});
		});
	}

	/** Parses at once (xterm's own synchronous write), so a snapshot right after a burst is not half applied. */
	writeSync(data) {
		const core = this.terminal._core;
		if (this.disposed || !core || typeof core.writeSync !== 'function') {
			return false;
		}
		core.writeSync(data);
		this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data);
		return true;
	}

	resize(cols, rows) {
		if (this.disposed || (this.terminal.cols === cols && this.terminal.rows === rows)) {
			return;
		}
		this.terminal.resize(cols, rows);
	}

	/**
	 * What the terminal shows, as text a fresh xterm turns back into the same screen (modes and the
	 * alternate screen included), the dangling escape last.
	 */
	snapshot(scrollbackRows) {
		const ansi = this.serializer.serialize(scrollbackRows === undefined ? {} : { scrollback: scrollbackRows });
		return {
			ansi: ansi + this.partialEscapeTail,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			cwd: this.cwd,
			title: this.title,
			alternateScreen: this.terminal.buffer.active.type === 'alternate',
		};
	}

	/** The last `limit` lines as plain text. */
	tailText(limit) {
		const buffer = this.terminal.buffer.active;
		const start = Math.max(0, buffer.length - Math.max(0, Math.floor(limit)));
		const lines = [];
		for (let row = start; row < buffer.length; row++) {
			const line = buffer.getLine(row);
			if (!line) {
				continue;
			}
			const text = line.translateToString(true);
			if (line.isWrapped && lines.length) {
				lines[lines.length - 1] += text;
			} else {
				lines.push(text);
			}
		}
		return lines.join('\n').replace(/\s+$/, '');
	}

	clear() {
		this.terminal.clear();
	}

	dispose() {
		this.disposed = true;
		this.terminal.dispose();
	}
}

module.exports = { HeadlessEmulator, osc7Folder, DEFAULT_SCROLLBACK };
