/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: idle agents go to sleep, and wake when the person comes back (kanban app/cli/sleep.py,
 *  task-xq6g). The Agent Host already keeps at most a few sessions in memory and releases the least
 *  recently used ones (agentSessionResidency.ts); this adds time: a session whose last turn ended and
 *  that nobody touched for the setting's minutes (30 by default) is released too, however few are open.
 *
 *  Released means the agent's process ends and the session's state leaves memory; the conversation stays
 *  on disk. Opening the session restores it, and the next message starts the agent again on the same
 *  conversation (resume-on-send), the same path the least-recently-used release always took.
 *
 *  Never asleep: a session with a turn running or waiting for the person (the residency's own checks:
 *  an active turn, a client showing it, a restore in flight, Agent Merge holding it; plus InputNeeded here).
 *
 *  The setting comes from the CLI's mirror <DISPATCH_DIR>/agent-sleep.json ({"minutes": N}; missing:
 *  30), read at most once a minute. `dispatch sleep now` (the bottom bar's "Let idle agents sleep" when the Mac is
 *  busy) writes <DISPATCH_DIR>/agent-sleep-now.json ({"at": seconds}): a session quiet since before then is due at
 *  once, whatever the minutes; the host watches that file, so it happens within seconds. Who is asleep goes to <DISPATCH_DIR>/agent-sleep-ide.json, which
 *  `dispatch sleep` and the bell read.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** How often the residency looks for sessions that have been quiet long enough. */
export const DISPATCH_SLEEP_CHECK_MS = 60_000;
const DEFAULT_MINUTES = 30;
const SETTING_TTL_MS = 60_000;

export interface IDispatchAsleep {
	readonly at: number;
	readonly agent?: string;
	readonly title?: string;
	readonly cwd?: string;
}

export function dispatchStateDir(): string {
	return process.env['DISPATCH_DIR'] || path.join(os.homedir(), 'tasks', '.dispatch');
}

/** The setting in whole minutes (0 = never), from the CLI's mirror; a missing or broken mirror is the default. */
export function readDispatchSleepMinutes(dir: string = dispatchStateDir()): number {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(dir, 'agent-sleep.json'), 'utf8'))?.minutes;
		return typeof m === 'number' && Number.isInteger(m) && m >= 0 ? m : DEFAULT_MINUTES;
	} catch {
		return DEFAULT_MINUTES;
	}
}

/** When `dispatch sleep now` last asked, in ms since the epoch; 0 when it never did. */
export function readDispatchSleepAsked(dir: string = dispatchStateDir()): number {
	try {
		const at = JSON.parse(fs.readFileSync(path.join(dir, 'agent-sleep-now.json'), 'utf8'))?.at;
		return typeof at === 'number' && at > 0 ? at * 1000 : 0;
	} catch {
		return 0;
	}
}

const ASKED_TTL_MS = 5_000;

export class DispatchAgentSleep {

	private readonly _quietSince = new Map<string, number>();
	private readonly _asleep = new Map<string, IDispatchAsleep>();
	private _setting: { readonly at: number; readonly minutes: number } | undefined;
	private _asked: { readonly at: number; readonly value: number } | undefined;

	private readonly _now: () => number;
	private readonly _readMinutes: () => number;
	private readonly _write: (asleep: ReadonlyMap<string, IDispatchAsleep>) => void;
	private readonly _readAsked: () => number;

	constructor(
		now: () => number = Date.now,
		readMinutes: () => number = readDispatchSleepMinutes,
		write: (asleep: ReadonlyMap<string, IDispatchAsleep>) => void = writeAsleep,
		readAsked: () => number = readDispatchSleepAsked,
	) {
		this._now = now;
		this._readMinutes = readMinutes;
		this._write = write;
		this._readAsked = readAsked;
		// a new host has nothing in memory: the last one's list is over
		this._write(this._asleep);
	}

	/** Something happened in the session (opened, a message, a turn starting or ending): the clock starts over, and a sleeping one is awake. */
	note(session: string): void {
		this._quietSince.set(session, this._now());
		if (this._asleep.delete(session)) {
			this._write(this._asleep);
		}
	}

	/** The session is gone for good (deleted): nothing to remember. */
	forget(session: string): void {
		this._quietSince.delete(session);
		if (this._asleep.delete(session)) {
			this._write(this._asleep);
		}
	}

	minutes(): number {
		const now = this._now();
		if (!this._setting || now - this._setting.at >= SETTING_TTL_MS) {
			this._setting = { at: now, minutes: this._readMinutes() };
		}
		return this._setting.minutes;
	}

	/** When `dispatch sleep now` last asked (ms), read at most every few seconds. */
	asked(): number {
		const now = this._now();
		if (!this._asked || now - this._asked.at >= ASKED_TTL_MS) {
			this._asked = { at: now, value: this._readAsked() };
		}
		return this._asked.value;
	}

	/** Quiet for the setting's minutes, or since before `dispatch sleep now` asked, and not waiting for the person. The residency checks the rest. */
	isDue(session: string, inputNeeded: boolean): boolean {
		const since = this._quietSince.get(session);
		if (inputNeeded || since === undefined) {
			return false;
		}
		const m = this.minutes();
		if (m > 0 && this._now() - since >= m * 60_000) {
			return true;
		}
		const asked = this.asked();
		return asked > 0 && since < asked;
	}

	/** `dispatch sleep now` asked: call `onAsked` (the residency looks again), from a watch on the state folder. */
	watchAsked(onAsked: () => void, dir: string = dispatchStateDir()): { dispose(): void } {
		let watcher: fs.FSWatcher | undefined;
		try {
			fs.mkdirSync(dir, { recursive: true });
			watcher = fs.watch(dir, (_event, name) => {
				if (name === 'agent-sleep-now.json') {
					this._asked = undefined;
					onAsked();
				}
			});
			watcher.on('error', () => watcher?.close());
		} catch {
			// no watch: the minute's check still sees it
		}
		return { dispose: () => watcher?.close() };
	}

	/** It was released because it sat quiet: remember it as asleep until it is touched again. */
	fellAsleep(session: string, info: Omit<IDispatchAsleep, 'at'>): void {
		this._quietSince.delete(session);
		this._asleep.set(session, { at: Math.round(this._now() / 1000), ...info });
		this._write(this._asleep);
	}

	isAsleep(session: string): boolean {
		return this._asleep.has(session);
	}
}

function writeAsleep(asleep: ReadonlyMap<string, IDispatchAsleep>): void {
	const dir = dispatchStateDir();
	const file = path.join(dir, 'agent-sleep-ide.json');
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify({ asleep: Object.fromEntries(asleep), at: Math.round(Date.now() / 1000) }));
		fs.renameSync(tmp, file);
	} catch {
		// who is asleep is only shown; sleeping itself does not depend on it
	}
}
