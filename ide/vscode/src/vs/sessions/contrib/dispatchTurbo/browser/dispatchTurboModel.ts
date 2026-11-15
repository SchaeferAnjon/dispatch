/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Turbo's data and the arithmetic of the timeline (patches/420-turbo.patch).
 *  The data is `dispatch turbo timeline --json` through dispatch-bridge's `dispatch.turbo` (kanban
 *  app/cli/turbo.py, view()); everything here is pure: one time axis for the allowance band and the lanes,
 *  its ticks, and the lanes a run or the person's own sessions make.
 *--------------------------------------------------------------------------------------------*/

export type TurboState = 'planning' | 'planned' | 'running' | 'paused' | 'combining' | 'done' | 'cancelled' | 'failed';
export type PartStatus = 'waiting' | 'starting' | 'working' | 'fixing' | 'done' | 'needs' | 'paused' | 'combined' | 'skipped' | 'failed' | 'cancelled';
/** A stretch of a lane: [from, to, what] in epoch seconds; work, fix (a failed build being mended), needs (waits for you), paused. */
export type Seg = [number, number, string];

export interface ITurboPart {
	readonly n: number;
	readonly name: string;
	readonly full?: string;
	readonly files?: readonly string[];
	readonly after?: readonly number[];
	readonly est: number;
	readonly status: PartStatus;
	readonly segs?: readonly Seg[];
	readonly step?: string;
	readonly started_at?: number;
	readonly ended_at?: number;
	readonly combined_at?: number;
	readonly combined_n?: number;
	readonly session?: string;
	readonly added?: boolean;
	readonly failed?: string;
	/** The agent it runs on (or ran on last), "OpenCode · deepseek-flash". */
	readonly engine_name?: string;
}

export interface ITurboFinal {
	readonly id: string;
	readonly name: string;
	readonly est: number;
	readonly status: string;
	readonly started_at?: number;
	readonly ended_at?: number;
}

export interface ITurboNeed {
	readonly part: number | string;
	readonly name: string;
	readonly question: string;
	readonly options: readonly string[];
	readonly kind?: string;
}

export interface ITurboAllowance {
	readonly known: boolean;
	readonly engine?: string;
	readonly engine_name?: string;
	readonly used?: number;
	readonly resets_at?: number;
	readonly slow_at: number;
	readonly readings: readonly [number, number][];
	readonly projection: readonly [number, number][];
	readonly slowed: boolean;
	readonly slowed_at?: number;
	readonly paused: boolean;
	readonly paused_at?: number;
	readonly resume_at?: number;
	readonly words: string;
	/** Stretches the run stood still for the allowance before it went on with another agent: [from, to]. */
	readonly stops?: readonly [number, number][];
	/** While stopped: the other agents it could go on with (signed in, allowance left), best first. */
	readonly alternatives?: readonly ITurboAlternative[];
	/** No allowance reading (OpenCode): Turbo listens to what the agent's provider answers instead. */
	readonly watch?: boolean;
	/** "provider" while stopped because the provider said the balance or plan ran out. */
	readonly paused_kind?: string;
	/** The stopped card's sentence when the stop is the provider's, not the allowance's. */
	readonly stopped_words?: string;
}

export interface ITurboAlternative {
	readonly engine: string;
	readonly name: string;
	readonly model?: string;
	readonly left?: number;
	readonly words?: string;
}

export interface ITurboSummary {
	readonly minutes: number;
	readonly sequential_minutes: number;
	readonly parts: number;
	readonly combined: number;
	readonly files: number;
	readonly commits: number;
	readonly used_pct?: number | null;
	readonly planned_pct?: number;
	readonly peak?: number;
	readonly left: readonly string[];
	readonly branch: string;
	readonly landed?: string;
}

export interface ITurboRun {
	readonly id: string;
	readonly state: TurboState;
	readonly title: string;
	readonly ask: string;
	readonly project: string;
	readonly repo: string;
	readonly engine: string;
	readonly engine_name?: string;
	readonly model?: string;
	readonly slots: number;
	readonly slots_now: number;
	readonly parts: readonly ITurboPart[];
	readonly finals: readonly ITurboFinal[];
	readonly shared?: readonly { file: string; parts: number[] }[];
	readonly started_at?: number;
	readonly created_at: number;
	readonly done_at?: number;
	readonly combined: number;
	readonly total: number;
	readonly needs: readonly ITurboNeed[];
	readonly allowance: ITurboAllowance;
	readonly forecast: { parts: Record<string, [number, number]>; finals: Record<string, [number, number]>; done_at: number };
	readonly plan: { done_at: number; done_words: string; minutes: number; sequential_minutes: number; planned_pct: number; allowance: string; options: Record<string, number>; rule?: string };
	readonly summary?: ITurboSummary;
	readonly page?: string;
	readonly task?: string;
	readonly error?: string;
	readonly combine_branch?: string;
	readonly folders?: readonly { path: string; name: string }[];
	readonly events?: readonly { at: number; kind: string; text: string; part?: number }[];
	/** Moved to another agent at a stop; new parts go back to this one at back_at. */
	readonly was?: { readonly engine: string; readonly engine_name: string; readonly back_at?: number };
	readonly switches?: readonly { at: number; from: string; to: string; model?: string; back?: boolean }[];
	readonly now: number;
}

/** One of the person's own sessions (or a helper it started), for the timeline without Turbo. */
export interface ISessionLane {
	readonly id: string;
	/** A few words: the name Dispatch shows for the session, its agent's title, or the start of its first message. */
	readonly name: string;
	readonly engine?: string;
	readonly engine_name?: string;
	readonly status: string;
	/** The stretches it worked. */
	readonly segs: readonly Seg[];
	readonly first?: number;
	readonly last?: number;
	readonly project?: string;
	readonly kind?: 'session' | 'helper' | string;
	readonly parent?: string;
	readonly helpers?: number;
	readonly step?: string;
}

export interface ITurboTimeline {
	readonly run: ITurboRun | null;
	readonly lanes: readonly ISessionLane[];
	readonly now: number;
}

export const ACTIVE_STATES: readonly TurboState[] = ['planning', 'planned', 'running', 'paused', 'combining'];

export function isActive(run: ITurboRun | null | undefined): run is ITurboRun {
	return !!run && ACTIVE_STATES.includes(run.state);
}

// ---------------------------------------------------------------- the time axis

export interface IAxis {
	readonly from: number;
	readonly to: number;
	/** 0..100, the share of the track this moment is at. */
	x(t: number): number;
}

export function axis(from: number, to: number): IAxis {
	const span = Math.max(60, to - from);
	return { from, to: from + span, x: (t: number) => Math.max(0, Math.min(100, ((t - from) / span) * 100)) };
}

/** The span a run is drawn over: from its start (or now, for a plan) to the forecast end, a little past now. */
export function runSpan(run: ITurboRun): [number, number] {
	const now = run.now;
	let from = run.started_at ?? now;
	for (const p of run.parts) {
		for (const s of p.segs ?? []) {
			from = Math.min(from, s[0]);
		}
	}
	const ended = (run.state === 'done' || run.state === 'cancelled') && run.done_at;
	const end = ended ? Math.max(run.done_at!, from + 5 * 60) : Math.max(run.forecast?.done_at ?? now, now + 10 * 60);
	const pad = (end - from) * 0.04;
	return [from - pad, end + pad];
}

/** The span the person's own sessions are drawn over: the earliest start shown to a little past now. */
export function lanesSpan(lanes: readonly ISessionLane[], now: number): [number, number] {
	let from = now - 60 * 60;
	for (const l of lanes) {
		for (const s of l.segs) {
			from = Math.min(from, s[0]);
		}
	}
	return [from, now + Math.max(10 * 60, (now - from) * 0.06)];
}

/** Round times on the axis, every 5, 10, 15 or 30 min, 1, 2 or 4 h so that there are 3 to 8 of them. */
export function ticks(from: number, to: number): number[] {
	const steps = [5, 10, 15, 30, 60, 120, 240].map(m => m * 60);
	const span = to - from;
	const step = steps.find(s => span / s <= 8) ?? steps[steps.length - 1];
	const out: number[] = [];
	// local time: a tick at a round minute of the day
	const offset = new Date(from * 1000).getTimezoneOffset() * 60;
	let t = Math.ceil((from - offset) / step) * step + offset;
	for (; t <= to; t += step) {
		out.push(t);
	}
	return out;
}

export function hm(epoch: number | undefined): string {
	if (!epoch) {
		return '';
	}
	const d = new Date(epoch * 1000);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function duration(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	const h = Math.floor(m / 60);
	const r = m % 60;
	return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
}

// ---------------------------------------------------------------- what a lane says

/** The block a part's state is shown with (the shared state blocks). */
export function partBlock(status: PartStatus): 'working' | 'waiting' | 'done' | 'stopped' | 'todo' | 'handoff' {
	switch (status) {
		case 'working': case 'starting': return 'working';
		case 'fixing': return 'stopped';
		case 'needs': return 'waiting';
		case 'done': return 'handoff';
		case 'combined': return 'done';
		case 'failed': return 'stopped';
		case 'paused': return 'todo';
		default: return 'todo';
	}
}

/** The planned (dashed) box of a part: the rest of its forecast after what it already did. */
export function plannedBox(run: ITurboRun, p: ITurboPart): [number, number] | undefined {
	if (p.status === 'combined' || p.status === 'skipped' || p.status === 'cancelled' || p.status === 'failed') {
		return undefined;
	}
	const f = run.forecast?.parts?.[String(p.n)];
	if (!f) {
		return undefined;
	}
	const start = Math.max(f[0], run.now);
	return f[1] > start + 30 ? [start, f[1]] : undefined;
}

/** Parts in the order the timeline lists them: combined first (in the order they went in), then running, then the rest by when they start. */
export function laneOrder(run: ITurboRun): ITurboPart[] {
	const rank = (p: ITurboPart) => p.status === 'combined' ? 0 : ['working', 'starting', 'fixing', 'needs', 'done', 'paused'].includes(p.status) ? 1 : 2;
	const start = (p: ITurboPart) => p.started_at ?? run.forecast?.parts?.[String(p.n)]?.[0] ?? Number.MAX_SAFE_INTEGER;
	return [...run.parts].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (a.combined_n ?? 0) - (b.combined_n ?? 0) : start(a) - start(b)) || a.n - b.n);
}

/** A run with more parts than this folds the combined ones into one row and the ones not started yet into another. */
export const FOLD_OVER = 10;

/** One row of the lanes: a part, or a fold of parts (combined, or not started yet) that opens on a click. */
export type LaneItem =
	| { readonly kind: 'part'; readonly part: ITurboPart }
	| { readonly kind: 'fold'; readonly key: 'combined' | 'later'; readonly parts: readonly ITurboPart[]; readonly open: boolean };

/**
 * The rows the lanes are drawn as. Up to FOLD_OVER parts, for a plan, or before any part started, one row a part.
 * Above it, once the run goes: the combined parts are one row and the parts that have not started yet another (each when it holds two or
 * more), so 28 parts are still a page of what is going on now. An opened fold keeps its row, its parts follow it.
 */
export function laneItems(run: ITurboRun, opened: ReadonlySet<string> = new Set()): LaneItem[] {
	const order = laneOrder(run);
	// not before a part has started: right after Start every part is still waiting, and one row of all of them says nothing
	const fold = run.parts.length > FOLD_OVER && run.state !== 'planned' && run.state !== 'planning' && run.parts.some(p => p.started_at);
	const folds: { key: 'combined' | 'later'; parts: ITurboPart[] }[] = fold ? [
		{ key: 'combined' as const, parts: order.filter(p => p.status === 'combined') },
		{ key: 'later' as const, parts: order.filter(p => p.status === 'waiting' && !p.started_at) },
	].filter(f => f.parts.length >= 2) : [];
	const out: LaneItem[] = [];
	for (const p of order) {
		const f = folds.find(x => x.parts.includes(p));
		const open = !!f && opened.has(`fold-${f.key}`);
		if (f && f.parts[0] === p) {
			out.push({ kind: 'fold', key: f.key, parts: f.parts, open });
		}
		if (!f || open) {
			out.push({ kind: 'part', part: p });
		}
	}
	return out;
}

/** Where a fold sits on the time axis: the combined ones from the first start to the last one in, the others over their forecast. */
export function foldSpan(run: ITurboRun, parts: readonly ITurboPart[], key: 'combined' | 'later'): [number, number] | undefined {
	let from = Number.MAX_SAFE_INTEGER, to = 0;
	for (const p of parts) {
		if (key === 'combined') {
			from = Math.min(from, p.started_at ?? p.segs?.[0]?.[0] ?? Number.MAX_SAFE_INTEGER);
			to = Math.max(to, p.combined_at ?? p.ended_at ?? 0);
		} else {
			const f = run.forecast?.parts?.[String(p.n)];
			if (f) {
				from = Math.min(from, Math.max(f[0], run.now));
				to = Math.max(to, f[1]);
			}
		}
	}
	return to > from && from < Number.MAX_SAFE_INTEGER ? [from, to] : undefined;
}

/**
 * The dependency hooks of a plan or a run: part `to` starts after part `from` is combined, drawn from where `from`
 * ends to where `to` starts. Only for parts that have not started; the end of `from` is when it went in, or its forecast.
 */
export function dependencies(run: ITurboRun): { from: number; to: number; fromAt: number; toAt: number }[] {
	const out: { from: number; to: number; fromAt: number; toAt: number }[] = [];
	const byN = new Map(run.parts.map(p => [p.n, p]));
	for (const p of run.parts) {
		if (p.started_at || !p.after?.length || p.status === 'skipped' || p.status === 'cancelled') {
			continue;
		}
		const toAt = run.forecast?.parts?.[String(p.n)]?.[0];
		for (const n of p.after) {
			const dep = byN.get(n);
			const fromAt = dep?.combined_at ?? run.forecast?.parts?.[String(n)]?.[1];
			if (dep && fromAt && toAt) {
				out.push({ from: n, to: p.n, fromAt, toAt: Math.max(toAt, run.now) });
			}
		}
	}
	return out;
}

/** The cells of the ten-block mark:`filled` of them solid, in the order the app icon drops its blocks. */
export function markCells(combined: number, total: number): boolean[] {
	const cells = Array<boolean>(10).fill(false);
	if (total <= 0) {
		return cells;
	}
	const k = Math.round(Math.min(1, combined / total) * 10);
	const order = [8, 9, 4, 5, 6, 7, 0, 1, 2, 3];
	for (let i = 0; i < k; i++) {
		cells[order[i]] = true;
	}
	return cells;
}

/** "1 part", "3 parts" (it said "Done · 1 parts", task-lj06.29). */
export function partsWords(n: number): string {
	return `${n} ${n === 1 ? 'part' : 'parts'}`;
}

/** The sentence the tab says it all in, for a run. */
export function runSentence(run: ITurboRun): string {
	switch (run.state) {
		case 'planning': return 'Splitting the job into parts…';
		// never more at a time than there are parts (task-npkp3: "2 parts · 4 at a time")
		case 'planned': return `${partsWords(run.total)} · ${run.total === 1 ? '' : `${Math.min(run.slots, run.total || run.slots)} at a time · `}${run.plan.done_words}`;
		case 'running':
		case 'combining': {
			const work = run.parts.filter(p => ['working', 'starting', 'fixing'].includes(p.status)).length;
			const head = run.state === 'combining' ? 'Combining' : `${work} working`;
			return `${run.combined} of ${run.total} combined · ${head} · ${run.plan.done_words.replace('Done around', 'done around')}`;
		}
		case 'paused': return run.allowance.paused ? `Stopped for the allowance · carries on at ${hm(run.allowance.resume_at)}` : `Paused · ${run.combined} of ${run.total} combined`;
		case 'done': return `Done · ${partsWords(run.total)} in ${duration(run.summary?.minutes ?? 0)}`;
		case 'cancelled': return `Stopped · ${run.combined} of ${run.total} combined`;
		case 'failed': return run.error || 'The job could not be split.';
	}
}

/** A session that worked within this long ago (or works now) is a lane of its own; the earlier ones of a project fold into one row. */
export const RECENT_S = 2 * 60 * 60;

/** One row of the sessions: a project's heading, a session, a helper under its session (opened), or a project's earlier sessions folded. */
export type SessionItem =
	| { readonly kind: 'group'; readonly project: string; readonly count: number }
	| { readonly kind: 'session'; readonly lane: ISessionLane; readonly helpers: readonly ISessionLane[]; readonly inFold: boolean }
	| { readonly kind: 'helper'; readonly lane: ISessionLane; readonly parent: ISessionLane }
	| { readonly kind: 'fold'; readonly key: string; readonly project: string; readonly lanes: readonly ISessionLane[]; readonly open: boolean };

export function laneEnd(l: ISessionLane): number {
	return l.segs.length ? l.segs[l.segs.length - 1][1] : (l.last ?? 0);
}

export function laneStart(l: ISessionLane): number {
	return l.segs.length ? l.segs[0][0] : (l.first ?? 0);
}

/**
 * The rows the person's sessions are drawn as (kanban preferences「会话按文件夹组织」「首页简洁用符号」): one group a project,
 * the project that worked last first; in it the sessions in the order they started, their helpers folded into them
 * (`h-<id>` opened shows them as rows under it). Two or more sessions of a project that last worked before RECENT_S fold
 * into one row (`fold-<project>` opens it) in front of the recent ones, so a busy day is still one page.
 */
export function sessionItems(lanes: readonly ISessionLane[], now: number, opened: ReadonlySet<string> = new Set()): SessionItem[] {
	const sessions = lanes.filter(l => l.kind !== 'helper');
	const helpersOf = new Map<string, ISessionLane[]>();
	for (const h of lanes) {
		if (h.kind === 'helper' && h.parent) {
			helpersOf.set(h.parent, [...(helpersOf.get(h.parent) ?? []), h]);
		}
	}
	const groups = new Map<string, ISessionLane[]>();
	for (const l of sessions) {
		const p = l.project || '';
		groups.set(p, [...(groups.get(p) ?? []), l]);
	}
	const latest = (ls: readonly ISessionLane[]) => Math.max(...ls.map(l => l.status === 'working' ? now : laneEnd(l)));
	const order = [...groups.entries()].sort((a, b) => latest(b[1]) - latest(a[1]) || a[0].localeCompare(b[0]));
	const out: SessionItem[] = [];
	const push = (l: ISessionLane, inFold: boolean) => {
		const hs = helpersOf.get(l.id) ?? [];
		out.push({ kind: 'session', lane: l, helpers: hs, inFold });
		if (hs.length && opened.has(`h-${l.id}`)) {
			hs.forEach(h => out.push({ kind: 'helper', lane: h, parent: l }));
		}
	};
	for (const [project, ls] of order) {
		const sorted = [...ls].sort((a, b) => laneStart(a) - laneStart(b));
		out.push({ kind: 'group', project, count: sorted.length });
		const earlier = sorted.filter(l => l.status !== 'working' && laneEnd(l) < now - RECENT_S);
		const fold = earlier.length >= 2;
		if (fold) {
			const key = `fold-${project}`;
			const open = opened.has(key);
			out.push({ kind: 'fold', key, project, lanes: earlier, open });
			if (open) {
				earlier.forEach(l => push(l, true));
			}
		}
		sorted.filter(l => !fold || !earlier.includes(l)).forEach(l => push(l, false));
	}
	return out;
}

/** What the sessions page says at the top: a sentence, and a line of counts. */
export function sessionsHead(lanes: readonly ISessionLane[]): { title: string; line: string } {
	const sessions = lanes.filter(l => l.kind !== 'helper');
	const helpers = lanes.length - sessions.length;
	const working = sessions.filter(l => l.status === 'working').length;
	if (!sessions.length) {
		return { title: 'No sessions in the last 8 hours', line: '' };
	}
	const projects = new Set(sessions.map(l => l.project || '')).size;
	const title = sessions.length === 1 ? '1 session in the last 8 hours' : `${sessions.length} sessions in the last 8 hours`;
	const bits = [working ? `${working} working now` : 'none working now'];
	if (helpers) {
		bits.push(helpers === 1 ? '1 helper' : `${helpers} helpers`);
	}
	if (projects > 1) {
		bits.push(`${projects} projects`);
	}
	return { title, line: bits.join(' · ') };
}
