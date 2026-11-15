/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Usage page's data and arithmetic (no DOM, no imports: ide/tests/usage.test.mjs loads it as is).
 *  The page (dispatchUsage.ts) draws what `dispatch usage --json` answers (kanban app/cli/usage.py); the shapes
 *  below are that answer's.
 *--------------------------------------------------------------------------------------------*/

export type Point = [number, number];

export interface IUsageWindowNow {
	readonly used: number;
	readonly resets_at?: number | null;
	/** the window started over at this time since it was read (used is then 0) */
	readonly reset_at?: number;
	readonly was?: number;
}

export interface IUsageCard {
	readonly id: string;
	readonly kind: 'claude' | 'codex' | 'glm' | 'deepseek';
	readonly engine: string;
	readonly title: string;
	readonly account?: string;
	readonly plan: string;
	readonly via?: string;
	readonly in_use: boolean;
	readonly unnamed: boolean;
	readonly session: IUsageWindowNow | null;
	readonly weekly: IUsageWindowNow | null;
	readonly balance?: { readonly amount: number; readonly currency: string };
	readonly spent_30d?: number;
	readonly read_at: number | null;
	readonly weekly_reset?: number | null;
	readonly track: string | null;
	readonly note?: string;
}

export interface IUsageTrack {
	readonly id: string;
	readonly title: string;
	readonly engine: string;
	readonly weekly: readonly Point[];
	readonly session: readonly Point[];
	readonly reset: number | null;
	readonly readings: number;
	readonly first_at: number;
	readonly now: number | null;
}

export interface IUsageEngineSpend {
	readonly tokens: readonly number[];
	readonly total: number;
	readonly value: number;
	readonly billed: number;
	readonly daily_tokens: readonly number[];
	readonly daily_value: readonly number[];
}

export interface IUsageToolRow {
	readonly name: string;
	readonly count: number;
	readonly errors: number | null;
	readonly sessions: number;
	readonly projects: readonly string[];
	readonly last: string;
	readonly engines: Record<string, number>;
	readonly event?: string;
	readonly defined?: boolean;
}

export interface IUsageMcpRow {
	readonly id: string;
	readonly name: string;
	readonly calls: number;
	readonly errors: number;
	readonly tools: number;
	readonly offered: number;
	readonly sessions: number;
	readonly projects: readonly string[];
	readonly last: string;
	readonly connector: boolean;
	readonly engines: Record<string, number>;
}

export interface IUsageWindow {
	readonly days: readonly string[];
	readonly spend: {
		readonly engines: Record<string, IUsageEngineSpend>;
		readonly tokens_total: number;
		readonly cache_share: number;
		readonly api_value: number;
		readonly billed: number;
		readonly billed_by: readonly { readonly label: string; readonly provider: string; readonly engine: string; readonly usd: number }[];
		readonly projects: readonly { readonly name: string; readonly value: number; readonly billed: number; readonly tokens: number; readonly by: Record<string, number>; readonly tokens_by: Record<string, number>; readonly sessions: number }[];
		readonly models: readonly { readonly model: string; readonly label: string; readonly engine: string; readonly total: number; readonly value: number; readonly billed: number; readonly priced: boolean }[];
		readonly sessions: readonly { readonly engine: string; readonly id: string; readonly title: string; readonly project: string; readonly subagents: number; readonly tokens: number; readonly value: number; readonly billed: number; readonly last: string }[];
	};
	readonly tools: {
		readonly totals: { readonly calls: number; readonly errors: number; readonly distinct: number };
		readonly builtin: readonly IUsageToolRow[];
		readonly mcp: readonly IUsageMcpRow[];
		readonly skills: readonly IUsageToolRow[];
		readonly unused_skills: readonly string[];
		readonly agents: readonly IUsageToolRow[];
		readonly unused_agents: readonly string[];
		readonly hooks: readonly IUsageToolRow[];
		readonly commands: readonly { readonly name: string; readonly count: number; readonly sessions: number; readonly last: string }[];
	};
}

export interface IUsagePage {
	readonly v: number;
	readonly state: 'ready' | 'counting';
	readonly refreshing: boolean;
	readonly progress?: { readonly state?: string; readonly done?: number; readonly total?: number } | null;
	readonly generated_at?: number;
	readonly today?: string;
	readonly engines?: Record<string, string>;
	readonly prices_as_of?: string;
	readonly heatmap?: { readonly days: number; readonly from: string; readonly to: string; readonly counts: Record<string, Record<string, number>>; readonly by_engine: Record<string, number>; readonly max: number; readonly total: number; readonly active_days: number };
	readonly allowance?: { readonly days: number; readonly from: number; readonly to: number; readonly cards: readonly IUsageCard[]; readonly tracks: readonly IUsageTrack[] };
	readonly windows?: Record<string, IUsageWindow>;
}

export const USAGE_ENGINE_ORDER = ['claude-code', 'codex', 'opencode', 'pi', 'zcode', 'gemini'];

// ---- numbers as people read them

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function usd(v: number | null | undefined): string {
	if (v === null || v === undefined) {
		return '–';
	}
	if (v >= 1000) {
		return '$' + Math.round(v).toLocaleString('en-US');
	}
	if (v >= 100) {
		return '$' + Math.round(v);
	}
	if (v > 0 && v < 0.01) {
		return '<$0.01';
	}
	return v > 0 ? '$' + v.toFixed(2) : '$0';
}

/** 41_979_292_055 → "42B", 5_618_919 → "5.6M". */
export function tokens(v: number): string {
	if (v >= 1e9) {
		return (v / 1e9).toFixed(v >= 1e11 ? 0 : 1).replace(/\.0$/, '') + 'B';
	}
	if (v >= 1e6) {
		return (v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
	}
	if (v >= 1e3) {
		return Math.round(v / 1e3) + 'K';
	}
	return String(Math.round(v));
}

export function int(v: number): string {
	return Math.round(v).toLocaleString('en-US');
}

/** A failure rate: "0%", "0.4%", "17%". */
export function rate(errors: number, calls: number): string {
	if (!calls) {
		return '–';
	}
	const r = 100 * errors / calls;
	return errors === 0 ? '0%' : r < 1 ? r.toFixed(1) + '%' : Math.round(r) + '%';
}

/** How bad a failure rate is: '' | 'warn' (5% and up) | 'err' (10% and up). */
export function rateLevel(errors: number, calls: number): '' | 'warn' | 'err' {
	if (!calls) {
		return '';
	}
	const r = 100 * errors / calls;
	return r >= 10 ? 'err' : r >= 5 ? 'warn' : '';
}

export function parseDay(s: string): Date {
	const [y, m, d] = s.split('-').map(Number);
	return new Date(y, m - 1, d);
}

export function dayKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayLabel(day: string): string {
	const d = parseDay(day);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "today", "yesterday", "5 days ago", "Sep 2" (a day, against the answer's today). */
export function agoDay(day: string, today: string): string {
	if (!day) {
		return 'never';
	}
	const n = Math.round((parseDay(today).getTime() - parseDay(day.slice(0, 10)).getTime()) / 864e5);
	return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n < 30 ? `${n} days ago` : dayLabel(day.slice(0, 10));
}

export function hhmm(epoch: number): string {
	const d = new Date(epoch * 1000);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shortTime(epoch: number): string {
	const d = new Date(epoch * 1000);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hhmm(epoch)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A reset time as the cards say it: "16:19" today, "Thu 05:59" within a week, "Oct 21" after. */
export function resetWhen(epoch: number, now: number): string {
	const d = new Date(epoch * 1000);
	const n = new Date(now * 1000);
	if (d.toDateString() === n.toDateString()) {
		return hhmm(epoch);
	}
	if (epoch - now < 6.5 * 86400) {
		return `${WEEKDAYS[d.getDay()]} ${hhmm(epoch)}`;
	}
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function shorten(text: string, n: number): string {
	return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

// ---- the allowance's ten blocks

/** Ten blocks for a percentage, like the app icon: each full, half or empty. */
export function meterCells(used: number): ('on' | 'half' | '')[] {
	const out: ('on' | 'half' | '')[] = [];
	for (let i = 0; i < 10; i++) {
		const f = used / 10 - i;
		out.push(f >= 0.75 ? 'on' : f >= 0.25 ? 'half' : '');
	}
	return out;
}

/** '' | 'warn' (over 80%) | 'hit' (the limit). */
export function meterLevel(used: number): '' | 'warn' | 'hit' {
	return used >= 99 ? 'hit' : used >= 80 ? 'warn' : '';
}

// ---- the allowance charts

export interface IFiveHourWindow { readonly start: number; readonly peak: number }

/** The 5-hour windows in a series of readings: a new one where the value drops or five hours have passed. */
export function windows5h(series: readonly Point[]): IFiveHourWindow[] {
	const out: { start: number; peak: number; last: number; lastT: number }[] = [];
	let cur: { start: number; peak: number; last: number; lastT: number } | undefined;
	for (const [t, v] of series) {
		if (!cur || v < cur.last - 5 || t - cur.start > 5 * 3600) {
			cur = { start: t, peak: v, last: v, lastT: t };
			out.push(cur);
		} else {
			cur.peak = Math.max(cur.peak, v);
			cur.last = v;
			cur.lastT = t;
		}
	}
	return out.map(w => ({ start: w.start, peak: w.peak }));
}

/** The weekly resets between two times, from one known reset of the account (every seven days from it). */
export function resetsBetween(anchor: number | null | undefined, a: number, b: number): number[] {
	if (!anchor) {
		return [];
	}
	const week = 7 * 86400;
	let r = anchor;
	while (r > a) {
		r -= week;
	}
	while (r <= a) {
		r += week;
	}
	const out: number[] = [];
	for (; r < b; r += week) {
		out.push(r);
	}
	return out;
}

const GAP = 2 * 3600;

/**
 * The weekly line, as SVG path data: solid where readings follow each other (within two hours, not dropping), dashed
 * where nothing was read. A week only grows until its reset, so a gap holds the last value, drops to 0 at each reset
 * in it (when the reset time is known) and climbs to the next reading. After the last reading the line holds (or
 * drops at the reset) to `to`, dashed, unless `live` (the reading is now).
 */
export function weeklyPaths(points: readonly Point[], to: number, anchor: number | null | undefined, live: boolean, x: (t: number) => number, y: (v: number) => number): { solid: string; dashed: string } {
	const f = (n: number) => n.toFixed(1);
	let solid = '', dashed = '';
	const pts = [...points].sort((a, b) => a[0] - b[0]);
	pts.forEach((p, i) => {
		const prev = pts[i - 1];
		if (!prev) {
			solid += `M${f(x(p[0]))},${f(y(p[1]))}`;
			return;
		}
		const resets = resetsBetween(anchor, prev[0], p[0]);
		if (p[0] - prev[0] <= GAP && p[1] >= prev[1] - 1 && !resets.length) {
			solid += `H${f(x(p[0]))}V${f(y(p[1]))}`;
			return;
		}
		dashed += `M${f(x(prev[0]))},${f(y(prev[1]))}`;
		for (const r of resets) {
			dashed += `H${f(x(r))}V${f(y(0))}`;
		}
		dashed += `H${f(x(p[0]))}V${f(y(p[1]))}`;
		solid += `M${f(x(p[0]))},${f(y(p[1]))}`;
	});
	const last = pts[pts.length - 1];
	if (last && !live && last[0] < to) {
		dashed += `M${f(x(last[0]))},${f(y(last[1]))}`;
		for (const r of resetsBetween(anchor, last[0], to)) {
			dashed += `H${f(x(r))}V${f(y(0))}`;
		}
		dashed += `H${f(x(to))}`;
	}
	return { solid, dashed };
}

/** What the chart says at time `t`: the reading then, or why there is none. */
export function readingAt(points: readonly Point[], session: readonly Point[], anchor: number | null | undefined, t: number): { kind: 'read'; weekly: number; session?: number } | { kind: 'reset'; at: number } | { kind: 'held'; at: number; weekly: number } | { kind: 'none' } {
	let best: Point | undefined;
	for (const p of points) {
		if (p[0] <= t) {
			best = p;
		}
	}
	if (!best) {
		return { kind: 'none' };
	}
	if (t - best[0] <= GAP) {
		let s: Point | undefined;
		for (const p of session) {
			if (p[0] <= t && t - p[0] < GAP) {
				s = p;
			}
		}
		return { kind: 'read', weekly: best[1], session: s?.[1] };
	}
	const rs = resetsBetween(anchor, best[0], t);
	return rs.length ? { kind: 'reset', at: rs[rs.length - 1] } : { kind: 'held', at: best[0], weekly: best[1] };
}

// ---- the year

/** How deep a day's square is (percent of the engine's colour) by its number of sessions. */
export function heatStrength(sessions: number): number {
	return sessions >= 40 ? 100 : sessions >= 15 ? 80 : sessions >= 5 ? 60 : sessions >= 2 ? 42 : 28;
}

/** The engine that ran most sessions that day (ties: the order of USAGE_ENGINE_ORDER). */
export function topEngine(day: Record<string, number>): string {
	let best = '', n = -1;
	const order = (e: string) => { const i = USAGE_ENGINE_ORDER.indexOf(e); return i < 0 ? 99 : i; };
	for (const [e, c] of Object.entries(day)) {
		if (c > n || (c === n && order(e) < order(best))) {
			best = e;
			n = c;
		}
	}
	return best;
}
