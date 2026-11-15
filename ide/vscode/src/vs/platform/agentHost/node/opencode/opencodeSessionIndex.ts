/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's own sessions, kept by the agent host so a listing never waits for OpenCode.
 *  The index is in memory and on disk (a restart lists at once); it is read again, whole, in the
 *  background, only when OpenCode's database file changed: the sessions updated since the last read
 *  (`time_updated`), and all of them now and then so a deleted one goes too. A session id is never
 *  looked up on its own: one that is not in the index is not in OpenCode. The database is read
 *  directly (read-only, in this process); only when that fails does one `opencode db` process read
 *  it, and never two at once.
 *  0.9.2 asked `opencode db` for the whole list, got it cut off at 64 KB (OpenCode leaves a pipe
 *  unflushed when it exits), took that for "no sessions" and then asked once per id, again on every
 *  listing, with no limit: about 45 of them at a time, the machine's load at 367 (kanban task-mpidn).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import type { IOpenCodeSessionRow } from './opencodeSessions.js';

export interface IOpenCodeSessionReader {
	/** OpenCode's database file, or undefined when it cannot be found */
	databasePath(): Promise<string | undefined>;
	/**
	 * The top-level sessions, read from the database file itself (read-only): all of them, or with `since` those
	 * updated at or after it (ms); throws when it cannot
	 */
	readDatabase(database: string, since?: number): Promise<IOpenCodeSessionRow[]>;
	/** The same through one `opencode db` process; throws when it cannot */
	readCli(since?: number): Promise<IOpenCodeSessionRow[]>;
}

export interface IOpenCodeSessionIndexOptions {
	/** Where the index is kept between starts */
	readonly cacheFile?: string;
	readonly log: (level: 'info' | 'warn', message: string) => void;
	readonly now?: () => number;
	/** The least time between two looks at the database file */
	readonly checkEveryMs?: number;
	/** The least time between two reads of the database itself, and between two `opencode db` reads */
	readonly readGapMs?: number;
	readonly cliGapMs?: number;
	/** How long reads only take the sessions updated since the last one before one reads them all again */
	readonly fullEveryMs?: number;
}

export type OpenCodeSessionSource = 'cache' | 'database' | 'cli';

interface ICacheFile {
	readonly version: 1;
	readonly signature: string;
	readonly rows: IOpenCodeSessionRow[];
}

/** The database file and its write-ahead log, as `mtime:size` each: any write OpenCode makes changes it. */
export async function openCodeDatabaseSignature(database: string | undefined): Promise<string> {
	if (!database) {
		return 'none';
	}
	const parts = await Promise.all([database, `${database}-wal`].map(file => fs.stat(file).then(s => `${s.mtimeMs}:${s.size}`, () => '-')));
	return parts.join('|');
}

export class OpenCodeSessionIndex {
	private _rows: Map<string, IOpenCodeSessionRow> | undefined;
	/** The database's signature when the rows were read (or a read failed) */
	private _signature: string | undefined;
	private _source: OpenCodeSessionSource | undefined;
	private _reading: Promise<void> | undefined;
	private _again = false;
	private _lastCheck = Number.NEGATIVE_INFINITY;
	private _lastRead = Number.NEGATIVE_INFINITY;
	private _lastReadSource: OpenCodeSessionSource | undefined;
	/** When every session was last read (not one from the index on disk) */
	private _lastFull = Number.NEGATIVE_INFINITY;
	private _later: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	private readonly _listeners = new Set<(rows: readonly IOpenCodeSessionRow[]) => void>();
	private readonly _now: () => number;
	private readonly _checkEveryMs: number;
	private readonly _readGapMs: number;
	private readonly _cliGapMs: number;
	private readonly _fullEveryMs: number;
	/** How many reads went to `opencode db` and to the database itself, and how many of those read everything (tests and the log) */
	cliReads = 0;
	databaseReads = 0;
	fullReads = 0;
	/** Settles once the index has rows from disk or a first read (or that read failed) */
	readonly loaded: Promise<void>;

	private readonly _reader: IOpenCodeSessionReader;
	private readonly _options: IOpenCodeSessionIndexOptions;

	constructor(reader: IOpenCodeSessionReader, options: IOpenCodeSessionIndexOptions) {
		this._reader = reader;
		this._options = options;
		this._now = options.now ?? Date.now;
		this._checkEveryMs = options.checkEveryMs ?? 2000;
		this._readGapMs = options.readGapMs ?? 5000;
		this._cliGapMs = options.cliGapMs ?? 30_000;
		this._fullEveryMs = options.fullEveryMs ?? 10 * 60_000;
		this.loaded = this._load();
	}

	/** The row; null when OpenCode has no such top-level session; undefined while the index has never been read. */
	get(id: string): IOpenCodeSessionRow | null | undefined {
		return this._rows ? this._rows.get(id) ?? null : undefined;
	}

	/** Every row, or undefined while the index has never been read */
	get rows(): readonly IOpenCodeSessionRow[] | undefined {
		return this._rows ? [...this._rows.values()] : undefined;
	}

	get source(): OpenCodeSessionSource | undefined {
		return this._source;
	}

	/** After each read of the database that found rows (not the index from disk) */
	onDidRead(listener: (rows: readonly IOpenCodeSessionRow[]) => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	/**
	 * A look at the database file, at most every `checkEveryMs`: when it changed since the last read, the index
	 * is read again in the background (no sooner than the read gap). Never waits for anything.
	 */
	check(): void {
		const now = this._now();
		if (this._disposed || now - this._lastCheck < this._checkEveryMs) {
			return;
		}
		this._lastCheck = now;
		void this._reader.databasePath().then(openCodeDatabaseSignature).then(signature => {
			if (signature !== this._signature) {
				this._readSoon();
			}
		}, error => this._options.log('warn', `[OpenCode] could not look at OpenCode's database: ${String(error)}`));
	}

	/**
	 * Reads the database again now, whatever the gap (History's Continue asked for an id the index does not
	 * have). One read at a time: a call during a read gets one more read after it, and both callers wait for that.
	 */
	refresh(): Promise<void> {
		if (this._reading) {
			this._again = true;
			return this._reading;
		}
		this._reading = (async () => {
			try {
				do {
					this._again = false;
					await this._readOnce();
				} while (this._again && !this._disposed);
			} finally {
				this._reading = undefined;
			}
		})();
		return this._reading;
	}

	dispose(): void {
		this._disposed = true;
		if (this._later) {
			clearTimeout(this._later);
		}
		this._listeners.clear();
	}

	private _readSoon(): void {
		if (this._reading || this._later) {
			return;
		}
		const gap = this._lastReadSource === 'cli' ? this._cliGapMs : this._readGapMs;
		const wait = this._lastRead + gap - this._now();
		if (wait <= 0) {
			void this.refresh();
			return;
		}
		this._later = setTimeout(() => {
			this._later = undefined;
			if (!this._disposed) {
				void this.refresh();
			}
		}, wait);
	}

	private async _load(): Promise<void> {
		const cached = await this._readCache();
		if (cached) {
			this._rows = new Map(cached.rows.map(row => [row.id, row]));
			this._signature = cached.signature;
			this._source = 'cache';
			this._options.log('info', `[OpenCode] ${cached.rows.length} sessions of OpenCode's from the index on disk`);
			this.check();
			return;
		}
		await this.refresh();
	}

	private async _readOnce(): Promise<void> {
		const started = this._now();
		const database = await this._reader.databasePath().catch(() => undefined);
		// the signature before the read: a write during it makes the next look read again
		const signature = await openCodeDatabaseSignature(database);
		// what changed since the last read (a second of slack for a write in the same moment), or everything
		const since = this._rows && started - this._lastFull < this._fullEveryMs ? Math.max(0, this._latest() - 1000) : undefined;
		let rows: IOpenCodeSessionRow[] | undefined;
		let source: OpenCodeSessionSource = 'database';
		if (database) {
			try {
				this.databaseReads++;
				rows = await this._reader.readDatabase(database, since);
			} catch (error) {
				this._options.log('warn', `[OpenCode] could not read OpenCode's database directly, asking \`opencode db\`: ${String(error).split('\n')[0]}`);
			}
		}
		if (!rows) {
			source = 'cli';
			try {
				this.cliReads++;
				rows = await this._reader.readCli(since);
			} catch (error) {
				this._options.log('warn', `[OpenCode] could not read OpenCode's sessions: ${String(error).split('\n')[0]}`);
			}
		}
		this._lastRead = this._now();
		this._lastReadSource = source;
		// a failed read is not tried again until the database changes
		this._signature = signature;
		if (!rows || this._disposed) {
			return;
		}
		if (since === undefined || !this._rows) {
			this._rows = new Map(rows.map(row => [row.id, row]));
			this._lastFull = started;
			this.fullReads++;
		} else {
			for (const row of rows) {
				this._rows.set(row.id, row);
			}
		}
		this._source = source;
		const all = [...this._rows.values()];
		this._options.log('info', `[OpenCode] ${since === undefined ? `${rows.length} sessions of OpenCode's` : `${rows.length} changed sessions of OpenCode's (${all.length} in all)`} read from ${source === 'cli' ? '`opencode db`' : 'its database'} in ${this._lastRead - started} ms`);
		for (const listener of [...this._listeners]) {
			listener(all);
		}
		await this._writeCache({ version: 1, signature, rows: all });
	}

	/** The newest `updated` in the index */
	private _latest(): number {
		let latest = 0;
		for (const row of this._rows?.values() ?? []) {
			latest = Math.max(latest, row.updated);
		}
		return latest;
	}

	private async _readCache(): Promise<ICacheFile | undefined> {
		const file = this._options.cacheFile;
		if (!file) {
			return undefined;
		}
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch {
			return undefined; // no index yet
		}
		try {
			const parsed = JSON.parse(raw) as Partial<ICacheFile>;
			if (parsed.version === 1 && typeof parsed.signature === 'string' && Array.isArray(parsed.rows)
				&& parsed.rows.every(row => typeof row?.id === 'string' && typeof row.directory === 'string' && typeof row.updated === 'number')) {
				return parsed as ICacheFile;
			}
		} catch {
			// a torn or foreign file: read the database instead
		}
		this._options.log('warn', `[OpenCode] the session index at ${file} is not one this version reads: reading OpenCode's database`);
		return undefined;
	}

	private async _writeCache(cache: ICacheFile): Promise<void> {
		const file = this._options.cacheFile;
		if (!file) {
			return;
		}
		const temp = `${file}.${process.pid}.tmp`;
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(temp, JSON.stringify(cache));
			await fs.rename(temp, file);
		} catch (error) {
			this._options.log('warn', `[OpenCode] could not keep the session index at ${file}: ${String(error)}`);
			await fs.rm(temp, { force: true });
		}
	}
}
