/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the Settings pages show, kept in the window (kanban design/settings-fast, task-90441).
 *
 *  Every page used to ask the dispatch CLI when it was opened and drew a placeholder until the answer came: half a
 *  second for each Python started, seconds on a busy Mac, even for a switch kept in a file on this Mac. Now:
 *  - what is kept on this Mac (notifications, Keep awake, Soul, the keys' names, phone access, how much agents may
 *    do, …) is read in one CLI run (`dispatch settings-page`, the bridge's `dispatch.settings snapshot`) when the
 *    window has settled and each time Settings opens; the pages draw what was read last, at once;
 *  - what asks a server or another program (the allowances, the agents on this Mac, the network check) is read on its
 *    own in the background when its page shows; the page shows the last answer with when it was read;
 *  - the last answers are kept in the window's storage, so a new window draws Settings at once too.
 *  A page that changed something puts the answer here (`set`), and every page that shows it follows.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { detectAgents } from '../../dispatchAgents/browser/dispatchAgents.js';

/** Read together in one CLI run: kept on this Mac. */
export type LocalKey = 'notify' | 'awake' | 'mobile' | 'soul' | 'keys' | 'autonomy' | 'attribution' | 'nextup' | 'neat' | 'gitIdentity' | 'computer' | 'builtins' | 'mcp' | 'mcpFull' | 'inventory' | 'plugins';
/** Read one by one, in the background: they ask a server or another program. */
export type ExternalKey = 'watch' | 'accounts' | 'agents' | 'net';
export type SettingsDataKey = LocalKey | ExternalKey;

const LOCAL: readonly LocalKey[] = ['notify', 'awake', 'mobile', 'soul', 'keys', 'autonomy', 'attribution', 'nextup', 'neat', 'gitIdentity', 'computer', 'builtins', 'mcp', 'mcpFull', 'inventory', 'plugins'];
/** Kept in this window only, never written to its storage: a tool server's settings can carry a key. */
const MEMORY_ONLY: ReadonlySet<SettingsDataKey> = new Set(['mcpFull']);
const STORAGE_KEY = 'dispatch.settings.data';
const ASK_MS = 60_000;
/** A snapshot asked for again within this long shares the last one (Settings opened, closed, opened). */
const SNAPSHOT_FRESH_MS = 3_000;

interface IEntry {
	readonly value: unknown;
	/** When Dispatch read it (ms). */
	readonly at: number;
}

type Fetch = (commands: ICommandService, arg?: string) => Promise<unknown>;

async function ask<T>(commands: ICommandService, id: string, ...args: unknown[]): Promise<T | undefined> {
	try {
		return await raceTimeout(commands.executeCommand<T>(id, ...args), ASK_MS);
	} catch {
		return undefined;
	}
}

interface IAnswer<T> { readonly ok?: boolean; readonly result?: T }
const result = <T>(a: IAnswer<T> | undefined): T | undefined => a?.ok ? a.result : undefined;
const notFailed = <T extends { ok?: boolean }>(a: T | undefined): T | undefined => a && a.ok !== false ? a : undefined;

/** One part read on its own: after a change, or the ones that ask a server. Undefined: no answer (the last one stays). */
const FETCH: Record<SettingsDataKey, Fetch> = {
	notify: async c => result(await ask<IAnswer<unknown>>(c, 'dispatch.settings', 'get')),
	awake: c => ask(c, 'dispatch.awake'),
	mobile: c => ask(c, 'dispatch.mobile', 'state'),
	soul: async c => { const s = await ask<{ path?: string }>(c, 'dispatch.soul', 'show'); return s?.path ? s : undefined; },
	keys: async c => {
		const rows = result(await ask<IAnswer<{ name: string; note?: string; project?: string; length?: number }[]>>(c, 'dispatch.env', 'list'));
		return Array.isArray(rows) ? rows.map(r => ({ name: r.name, note: r.note || '', project: r.project || '', length: r.length || 0 })) : undefined;
	},
	autonomy: async c => notFailed(await ask<{ ok?: boolean }>(c, 'dispatch.firstRun', 'autonomy')),
	attribution: async c => { const a = await ask<{ ok?: boolean }>(c, 'dispatch.attributionConfig'); return a?.ok ? a : undefined; },
	nextup: async c => notFailed(await ask<{ ok?: boolean }>(c, 'dispatch.capture', 'settings')),
	neat: async c => result(await ask<IAnswer<unknown>>(c, 'dispatch.customizations', 'neat')),
	gitIdentity: async c => notFailed(await ask<{ ok?: boolean }>(c, 'dispatch.firstRun', 'git-identity')),
	computer: async c => { const a = await ask<{ ok?: boolean }>(c, 'dispatch.computerAllowAll'); return a?.ok ? a : undefined; },
	builtins: async c => { const r = result(await ask<IAnswer<{ rules?: unknown }>>(c, 'dispatch.customizations', 'builtins')); return r?.rules ? r : undefined; },
	mcp: async c => {
		const r = result(await ask<IAnswer<{ servers?: { name: string; scope: string; builtin?: boolean }[] }>>(c, 'dispatch.customizations', 'mcp'));
		return Array.isArray(r?.servers) ? { servers: r.servers.map(s => ({ name: s.name, scope: s.scope, builtin: !!s.builtin })) } : undefined;
	},
	mcpFull: async c => result(await ask<IAnswer<unknown>>(c, 'dispatch.customizations', 'mcp')),
	inventory: async c => result(await ask<IAnswer<unknown>>(c, 'dispatch.customizations', 'list')),
	plugins: async c => result(await ask<IAnswer<unknown>>(c, 'dispatch.customizations', 'plugins')),
	watch: async c => { const w = await ask<{ engines?: unknown[] }>(c, 'dispatch.accounts', 'watch'); return Array.isArray(w?.engines) ? w.engines : undefined; },
	accounts: async c => { const l = await ask<unknown>(c, 'dispatch.accounts', 'list'); return Array.isArray(l) ? l : undefined; },
	agents: async c => { try { return await detectAgents(c); } catch { return undefined; } },
	net: (c, arg) => ask(c, 'dispatch.net', arg === 'refresh' ? 'refresh' : 'status'),
};

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

class SettingsData {

	private readonly entries = new Map<SettingsDataKey, IEntry>();
	private readonly version = observableValue<number>('dispatchSettingsData', 0);
	private readonly busyNow = observableValue<ReadonlySet<SettingsDataKey>>('dispatchSettingsDataBusy', new Set());
	private readonly running = new Map<SettingsDataKey | 'snapshot', Promise<void>>();
	private snapshotAt = 0;
	private commands: ICommandService | undefined;
	private storage: IStorageService | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Keys read while a page drew: what it shows, so it is drawn again when one of them changes. */
	private tracking: Set<SettingsDataKey> | undefined;

	private readonly _onDidChange = new Emitter<ReadonlySet<SettingsDataKey>>();
	/** Parts whose value changed (a new answer that differs, or a page's change). */
	readonly onDidChange: Event<ReadonlySet<SettingsDataKey>> = this._onDidChange.event;

	/** The window's command and storage services; what the last window kept is there at once. */
	init(commands: ICommandService, storage: IStorageService): void {
		this.commands = commands;
		this.storage = storage;
		try {
			const kept = JSON.parse(storage.get(STORAGE_KEY, StorageScope.APPLICATION) || '{}') as Record<string, IEntry>;
			for (const [k, e] of Object.entries(kept)) {
				if (k in FETCH && !MEMORY_ONLY.has(k as SettingsDataKey) && e && typeof e.at === 'number' && !this.entries.has(k as SettingsDataKey)) {
					this.entries.set(k as SettingsDataKey, e);
				}
			}
		} catch {
			// a kept copy that does not parse is read again from the CLI
		}
	}

	get<T>(key: SettingsDataKey): T | undefined {
		this.tracking?.add(key);
		return this.entries.get(key)?.value as T | undefined;
	}

	/** When it was read (ms), or undefined when it never was. */
	at(key: SettingsDataKey): number | undefined {
		return this.entries.get(key)?.at;
	}

	/** In an autorun: changes with any part. */
	read<T>(reader: IReader, key: SettingsDataKey): T | undefined {
		this.version.read(reader);
		return this.get<T>(key);
	}

	readonly busy: IObservable<ReadonlySet<SettingsDataKey>> = this.busyNow;

	/** The keys `draw` read. */
	track(draw: () => void): ReadonlySet<SettingsDataKey> {
		const before = this.tracking;
		const used = this.tracking = new Set<SettingsDataKey>();
		try {
			draw();
		} finally {
			this.tracking = before;
		}
		return used;
	}

	/** A page changed it (or its answer says what it is now). */
	set(key: SettingsDataKey, value: unknown): void {
		this.put(new Map([[key, value]]));
	}

	private put(values: ReadonlyMap<SettingsDataKey, unknown>): void {
		const now = Date.now();
		const changed = new Set<SettingsDataKey>();
		for (const [k, v] of values) {
			if (v === undefined) {
				continue;
			}
			const old = this.entries.get(k);
			if (!old || !same(old.value, v)) {
				changed.add(k);
			}
			this.entries.set(k, { value: v, at: now });
		}
		this.keep();
		if (changed.size) {
			this.version.set(this.version.get() + 1, undefined);
			this._onDidChange.fire(changed);
		}
	}

	private keep(): void {
		if (this.saveTimer || !this.storage) {
			return;
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.storage?.store(STORAGE_KEY, JSON.stringify(Object.fromEntries([...this.entries].filter(([k]) => !MEMORY_ONLY.has(k)))), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}, 1000);
	}

	private setBusy(key: SettingsDataKey, on: boolean): void {
		const next = new Set(this.busyNow.get());
		if (on) {
			next.add(key);
		} else {
			next.delete(key);
		}
		this.busyNow.set(next, undefined);
	}

	/** Everything kept on this Mac, in one CLI run; a second ask while one runs (or right after) shares it. */
	refreshLocal(): Promise<void> {
		const run = this.running.get('snapshot');
		if (run) {
			return run;
		}
		if (Date.now() - this.snapshotAt < SNAPSHOT_FRESH_MS || !this.commands) {
			return Promise.resolve();
		}
		const commands = this.commands;
		const p = (async () => {
			try {
				const parts = result(await ask<IAnswer<Record<string, unknown>>>(commands, 'dispatch.settings', 'snapshot'));
				if (parts) {
					this.snapshotAt = Date.now();
					this.put(new Map(LOCAL.map(k => [k, parts[k]] as [SettingsDataKey, unknown])));
				}
			} finally {
				this.running.delete('snapshot');
			}
		})();
		this.running.set('snapshot', p);
		return p;
	}

	/** One part read again on its own, unless it was read within `maxAgeMs` (0: now). `arg`: the net check's refresh. */
	refresh(key: SettingsDataKey, maxAgeMs = 0, arg?: string): Promise<void> {
		const run = this.running.get(key);
		if (run) {
			return run;
		}
		const at = this.at(key);
		if (!this.commands || (maxAgeMs > 0 && at !== undefined && Date.now() - at < maxAgeMs)) {
			return Promise.resolve();
		}
		const commands = this.commands;
		this.setBusy(key, true);
		const p = (async () => {
			try {
				const v = await FETCH[key](commands, arg);
				if (v !== undefined) {
					this.put(new Map([[key, v]]));
				}
			} finally {
				this.running.delete(key);
				this.setBusy(key, false);
			}
		})();
		this.running.set(key, p);
		return p;
	}

	/** Never read in this window nor kept from an earlier one: read now, one after another, in the background (a new
	 *  Mac's first window; later windows have them kept). */
	async fillMissing(keys: readonly ExternalKey[]): Promise<void> {
		if (LOCAL.some(k => !this.entries.has(k) && !MEMORY_ONLY.has(k))) {
			await this.refreshLocal();
		}
		for (const k of keys) {
			if (!this.entries.has(k)) {
				await this.refresh(k);
			}
		}
	}
}

/** The window's one copy (Settings' contribution gives it its services). */
export const settingsData = new SettingsData();
