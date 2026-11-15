// Dispatch terminal daemon: what is kept on disk for every terminal, so it can come back after the Mac
// (or the daemon) restarts: `sessions/<id>/meta.json` (folder, title, what runs in it, how to start it
// again) and `sessions/<id>/screen.ans` (the screen and scrollback, as text a terminal replays).
// Files are written whole to a temporary name and renamed, and only this user can read them.
'use strict';

const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

class SessionStore {
	constructor(dir) {
		this.dir = path.join(dir, 'sessions');
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
	}

	_dir(id) {
		if (!ID_RE.test(id)) {
			throw new Error(`bad session id ${id}`);
		}
		return path.join(this.dir, id);
	}

	_writeAtomic(file, text) {
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, text, { mode: 0o600 });
		fs.renameSync(tmp, file);
	}

	saveMeta(id, meta) {
		const dir = this._dir(id);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		this._writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
	}

	saveScreen(id, ansi) {
		const dir = this._dir(id);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		this._writeAtomic(path.join(dir, 'screen.ans'), ansi);
	}

	remove(id) {
		fs.rmSync(this._dir(id), { recursive: true, force: true });
	}

	/** Every kept terminal: { id, meta, screen }. A folder that cannot be read is skipped. */
	load() {
		let names = [];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const out = [];
		for (const id of names) {
			if (!ID_RE.test(id)) {
				continue;
			}
			try {
				const meta = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'meta.json'), 'utf8'));
				let screen = '';
				try {
					screen = fs.readFileSync(path.join(this.dir, id, 'screen.ans'), 'utf8');
				} catch { /* never written: an empty screen */ }
				out.push({ id, meta, screen });
			} catch {
				// a half-written or foreign folder: leave it alone
			}
		}
		return out.sort((a, b) => (a.meta.createdAt || 0) - (b.meta.createdAt || 0));
	}
}

module.exports = { SessionStore, ID_RE };
