/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the Agents window's bottom bar draws, without drawing it (patches/120-status-bar.patch).
 *  The bar is "Status in blocks" (kanban design/bars, direction B): an allowance is a ten-cell gauge, the build
 *  queue is a row of blocks; words show only when something needs you, and in a new person's first week.
 *--------------------------------------------------------------------------------------------*/

/** One build as `dispatch build queue --json` gives it. */
export interface IDispatchBuild {
	readonly name: string;
	readonly host: string;
	readonly label: string;
	readonly task?: string;
	/** building: 'build' (compiling) or 'checks' (its end-to-end checks run); failed: which one failed. */
	readonly stage?: 'build' | 'checks';
	readonly since?: number;
	readonly seconds?: number;
	readonly estimate?: number;
	readonly position?: number;
	readonly waited?: number;
	readonly ago?: number;
	/** 'yours': a package someone will install; 'agents': an agent's development or test build (task-7ve7v). */
	readonly kind?: 'yours' | 'agents';
	/** A failed build of yours: where it stopped, the last thing its log said, the log's path, what builds it again. */
	readonly step?: 'checkout' | 'dependencies' | 'build' | 'checks' | 'stopped' | 'start';
	readonly why?: string;
	readonly log?: string;
	readonly retry?: string;
}

export interface IDispatchBuildLists {
	readonly building: readonly IDispatchBuild[];
	readonly waiting: readonly IDispatchBuild[];
	readonly failed: readonly IDispatchBuild[];
	readonly done: readonly IDispatchBuild[];
	readonly recent?: { readonly built: number; readonly failed: number; readonly checks_failed: number };
}

/** The queue: the person's own builds at the top level; the agents' test builds apart, never alarming. */
export interface IDispatchBuildQueue extends IDispatchBuildLists {
	readonly agents: IDispatchBuildLists;
	readonly estimate?: number;
	/** When the CLI read it (epoch seconds). */
	readonly at?: number;
	readonly notes?: readonly string[];
}

/** A queue answer, or undefined when it is not one (the bridge is missing, the CLI said no). */
export function parseBuildQueue(x: unknown): IDispatchBuildQueue | undefined {
	if (!x || typeof x !== 'object') {
		return undefined;
	}
	const q = x as Partial<IDispatchBuildQueue>;
	if (!Array.isArray(q.building) || !Array.isArray(q.waiting)) {
		return undefined;
	}
	const lists = (l: Partial<IDispatchBuildLists> | undefined): IDispatchBuildLists => ({
		building: Array.isArray(l?.building) ? l.building : [], waiting: Array.isArray(l?.waiting) ? l.waiting : [],
		failed: Array.isArray(l?.failed) ? l.failed : [], done: Array.isArray(l?.done) ? l.done : [], recent: l?.recent,
	});
	const top = lists(q);
	let agents = lists(q.agents);
	if (!q.agents) {
		// a CLI from before the split: its development builds (<sha>-dev) are the agents' all the same
		const dev = (b: IDispatchBuild) => b.kind === 'agents' || b.name.endsWith('-dev');
		const part = (key: 'building' | 'waiting' | 'failed' | 'done') => [top[key].filter(b => !dev(b)), top[key].filter(dev)] as const;
		const [b, w, f, d] = [part('building'), part('waiting'), part('failed'), part('done')];
		agents = { building: b[1], waiting: w[1], failed: f[1], done: d[1] };
		return { building: b[0], waiting: w[0], failed: f[0], done: d[0], recent: undefined, agents, estimate: q.estimate, at: q.at, notes: q.notes };
	}
	return { ...top, agents, estimate: q.estimate, at: q.at, notes: q.notes };
}

/** How many of the agents' test builds run or wait: the bar shows one quiet block for them, never a count of failures. */
export function agentsBusy(q: IDispatchBuildQueue | undefined): number {
	return q ? q.agents.building.length + q.agents.waiting.length : 0;
}

/** How far one cell of a gauge is filled, 0 to 1, for `used` percent of an allowance in `cells` cells. */
export function gaugeCells(used: number, cells: number): number[] {
	const l = Math.max(0, Math.min(100, used));
	const step = 100 / cells;
	const out: number[] = [];
	for (let i = 0; i < cells; i++) {
		out.push(Math.max(0, Math.min(1, (l - i * step) / step)));
	}
	return out;
}

/** An allowance needs you once 80 % of it or more is used (Settings' meters turn the same colour at 80 %). */
export const HIGH_USED = 80;

export interface IAllowanceWords {
	/** What the block says next to its gauge: '' when nothing needs saying. */
	readonly words: string;
	readonly low: boolean;
}

/**
 * The words next to an allowance gauge, in the same terms as the account panel and Settings (how much is used):
 * "83% used · 01:00" when it runs high (only "83%" in a narrow window); else when it resets ("resets 01:00"),
 * after the engine's name in a person's first week; a narrow window only says something when it runs high.
 */
export function allowanceWords(used: number, resets: string, name: string, opts: { narrow: boolean; newUser: boolean; usedWord: string; resetsWord: (when: string) => string }): IAllowanceWords {
	const p = Math.max(0, Math.min(100, Math.round(used)));
	if (p >= HIGH_USED) {
		if (opts.narrow) {
			return { words: `${p}%`, low: true };
		}
		return { words: resets ? `${p}% ${opts.usedWord} · ${resets}` : `${p}% ${opts.usedWord}`, low: true };
	}
	if (opts.narrow) {
		return { words: '', low: false };
	}
	const when = resets ? opts.resetsWord(resets) : '';
	return { words: [opts.newUser ? name : '', when].filter(Boolean).join(' · '), low: false };
}

export interface IQueueBlocks {
	/** The block that grows: how far along (0 to 1), or 'checks' while its checks run, or 'done' just after. */
	readonly head: { readonly build: IDispatchBuild; readonly progress: number; readonly state: 'build' | 'checks' | 'done' } | undefined;
	/** Empty blocks after it, one per build waiting, at most `max`. */
	readonly waiting: number;
	/** "+N" for the ones that did not fit. */
	readonly more: number;
}

/**
 * The queue as a row of blocks: the build that runs first (or the one that just finished), then one empty block
 * per build waiting (and the other builds running elsewhere), at most `max` of them, "+N" for the rest.
 */
export function queueBlocks(q: (IDispatchBuildLists & { readonly estimate?: number }) | undefined, max: number, now: number): IQueueBlocks {
	if (!q) {
		return { head: undefined, waiting: 0, more: 0 };
	}
	const running = q.building.filter(b => b.stage !== 'checks');
	const checking = q.building.filter(b => b.stage === 'checks');
	let head: IQueueBlocks['head'];
	const first = running[0] ?? checking[0];
	if (first) {
		if (first.stage === 'checks') {
			head = { build: first, progress: 1, state: 'checks' };
		} else {
			const since = first.since ?? now;
			const est = Math.max(60, first.estimate ?? q.estimate ?? 480);
			head = { build: first, progress: Math.max(0.06, Math.min(0.94, (now - since) / est)), state: 'build' };
		}
	} else if (q.done.length) {
		head = { build: q.done[0], progress: 1, state: 'done' };
	}
	const behind = q.waiting.length + Math.max(0, q.building.length - (first ? 1 : 0));
	const shown = Math.min(behind, max);
	return { head, waiting: shown, more: behind - shown };
}

/** Whole minutes, at least 1, for "5 min". */
export function minutes(seconds: number | undefined): number {
	return Math.max(1, Math.round((seconds ?? 0) / 60));
}

/** "5 min", "1 h 20 min": how long, the way people say it. */
export function duration(seconds: number | undefined): string {
	const m = minutes(seconds);
	if (m < 60) {
		return `${m} min`;
	}
	const h = Math.floor(m / 60);
	const r = m % 60;
	return r ? `${h} h ${r} min` : `${h} h`;
}

/** A new person's first week: blocks say what they are in a word. */
export const NEW_USER_DAYS = 7;

export function isNewUser(firstSeen: number, now: number): boolean {
	return firstSeen > 0 && now - firstSeen < NEW_USER_DAYS * 24 * 3600 * 1000;
}

/** The window is narrow: gauges get five cells, the queue three blocks, low allowances only their number. */
export const NARROW_WIDTH = 900;

/** `dispatch busy --json`: whether this Mac is too busy, why, and how many agents and builds run on it. */
export interface IDispatchBusy {
	readonly busy: boolean;
	readonly why: 'memory' | 'processors' | undefined;
	readonly agents: number;
	readonly builds: number;
}

export function parseBusy(x: unknown): IDispatchBusy | undefined {
	if (!x || typeof x !== 'object') {
		return undefined;
	}
	const r = x as Record<string, unknown>;
	if (typeof r.busy !== 'boolean') {
		return undefined;
	}
	const n = (v: unknown) => typeof v === 'number' && v >= 0 ? Math.round(v) : 0;
	return { busy: r.busy, why: r.why === 'memory' || r.why === 'processors' ? r.why : undefined, agents: n(r.agents), builds: n(r.builds) };
}

export interface IBusyWords {
	readonly memory: string;
	readonly processors: string;
	readonly agents: (n: number) => string;
	readonly builds: (n: number) => string;
	readonly and: (a: string, b: string) => string;
	readonly using: (who: string, what: string) => string;
	readonly usingOne: (who: string, what: string) => string;
	readonly others: (what: string) => string;
}

/** "3 agents and a build are using most of its memory, so things feel slow." (no numbers about memory itself). */
export function busyWords(b: IDispatchBusy | undefined, w: IBusyWords): string {
	const what = b?.why === 'memory' ? w.memory : w.processors;
	const who = [b?.agents ? w.agents(b.agents) : '', b?.builds ? w.builds(b.builds) : ''].filter(Boolean);
	if (!who.length) {
		return w.others(what);
	}
	const one = who.length === 1 && (b?.agents === 1 || (!b?.agents && b?.builds === 1));
	return (one ? w.usingOne : w.using)(who.length === 2 ? w.and(who[0], who[1]) : who[0], what);
}
