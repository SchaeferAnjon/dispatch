/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Claude Code's session list, kept while its folders stay the same (kanban task-mpidn).
 *  The SDK's `listSessions` reads every transcript under `<config>/projects` (about 1.3 s for 765 on the
 *  author's Mac, far more on a busy one), and History's Continue asked for it on every click. A new
 *  session is a new file, which changes its project folder's time (or adds a folder): the list is read
 *  again then, and at the latest after `maxAgeMs` (a title changes inside a file).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';

/** The projects folder and each project folder in it, as `name:mtime`: a session added or removed changes it. */
export async function claudeProjectsSignature(projects: string): Promise<string> {
	let entries: string[];
	try {
		entries = await fs.readdir(projects);
	} catch {
		return 'none';
	}
	const times = await Promise.all(entries.sort().map(name => fs.stat(path.join(projects, name)).then(s => `${name}:${s.mtimeMs}`, () => `${name}:-`)));
	return times.join('|');
}

export class ClaudeSessionListCache<T> {
	private _kept: { readonly signature: string; readonly at: number; readonly value: T } | undefined;
	private _reading: Promise<T> | undefined;
	private readonly _projects: () => string;
	private readonly _read: () => Promise<T>;
	private readonly _maxAgeMs: number;
	private readonly _now: () => number;

	constructor(projects: () => string, read: () => Promise<T>, maxAgeMs = 60_000, now: () => number = Date.now) {
		this._projects = projects;
		this._read = read;
		this._maxAgeMs = maxAgeMs;
		this._now = now;
	}

	/** The list: the kept one while the folders are unchanged and it is young enough, else one read (shared by every caller meanwhile). */
	async get(): Promise<T> {
		const signature = await claudeProjectsSignature(this._projects());
		const kept = this._kept;
		if (kept && kept.signature === signature && this._now() - kept.at < this._maxAgeMs) {
			return kept.value;
		}
		this._reading ??= (async () => {
			try {
				const at = this._now();
				const value = await this._read();
				this._kept = { signature, at, value };
				return value;
			} finally {
				this._reading = undefined;
			}
		})();
		return this._reading;
	}

	/** Forget the kept list (a session the app created or deleted itself). */
	clear(): void {
		this._kept = undefined;
	}
}
