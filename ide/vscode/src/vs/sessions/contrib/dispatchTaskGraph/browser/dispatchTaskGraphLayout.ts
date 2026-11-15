/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where everything on the Task graph goes (patches/430-tasks.patch; kanban
 *  design/task-graph/redesign/, direction A「泳道脉络」, chosen 2026-09-27).
 *
 *  Input: `dispatch task graph --json` (kanban app/cli/things.py): the project's recent tasks, each in
 *  a thing, the things in drawing order, the links where a session went from one thing to another.
 *  Output: one 32 px row per thing, on the day axis (dispatchDayAxis.ts: every day side by side, the one under
 *  the focus open by the hour, the rest folded, the page scrolling sideways), all of it a function of the focus:
 *
 *   - the tasks asked in the same hour (an open day) or day (a folded one) are one mark, bigger the more there
 *     are (radius 3 / 4 / 5); filled grey when all are done, an open ring when one is not; a day opening
 *     cross-fades its one mark into its hours;
 *   - the row's line runs from its first mark to its last; a thing not done carries on to now as a
 *     dashed line (nobody has touched it since);
 *   - the end of a thing not done is the only colour: green in progress (a ping while an agent is at
 *     it), amber waiting for you, a grey ring to do;
 *   - a new thing's line comes down from the task it branched off (a right angle with a 6 px corner);
 *     going back to an old thing (a merge) is drawn only while its row is hovered; a line the agent
 *     did not write down (worked out from the order of the session's tasks) is drawn dashed;
 *   - things with nothing asked in 7 days fold under "No activity in 7 days".
 *
 *  This session keeps the project's rows and time axis for the things the session asked something in
 *  (the rest fold under "Not in this session", dimmed), draws the session's own tasks one by one and
 *  joins them in the order they were asked with one dark line; the project's other tasks stay as
 *  faint marks behind.
 *
 *  Pure (the view draws it; test/browser/dispatchTaskGraphLayout.test.ts checks it).
 *--------------------------------------------------------------------------------------------*/

import { dayAxis, dayAxisLabels, dayBuckets, dayIndexOf, hourOf, type IDayAxis, type IDayAxisLabels, type IDayBucket, type IDaySlot, lerp, primaryBucketOf, slotX, spread } from './dispatchDayAxis.js';

export type GraphStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export type GraphScope = 'project' | 'session';
/** explicit: an agent wrote it down (`dispatch begin`, `dispatch task follow`); inferred: the order of the session's tasks. */
export type GraphLinkSource = 'explicit' | 'inferred';

export interface IGraphThingRef {
	readonly id: string;
	readonly name: string;
}

export interface IGraphNode {
	readonly id: string;
	readonly title: string;
	readonly status: GraphStatus;
	readonly thing: IGraphThingRef;
	/** The task its session was on when it was asked: written down by the agent, or inferred from the session's order. */
	readonly from?: { readonly id: string; readonly source: GraphLinkSource; readonly thing?: string; readonly title?: string } | null;
	/** When it was asked (epoch seconds). */
	readonly at: number;
	readonly done_at?: number | null;
	/** The session it was asked in. */
	readonly session?: string;
	/** Session scope: asked in that session. */
	readonly mine?: boolean;
}

export interface IGraphThing {
	readonly id: string;
	readonly name: string;
	readonly first_at: number;
	readonly last_at: number;
	readonly parent?: string | null;
	/** Nothing asked in 7 days. */
	readonly quiet?: boolean;
}

export interface IGraphLink {
	readonly from: string;
	readonly to: string;
	readonly kind: 'branch' | 'merge' | 'hop';
	readonly gap_days?: number;
	readonly source?: GraphLinkSource;
}

export interface IGraphData<N extends IGraphNode = IGraphNode> {
	readonly project?: string;
	readonly session?: string | null;
	readonly days?: number;
	readonly things?: readonly IGraphThing[];
	readonly nodes?: readonly N[];
	readonly links?: readonly IGraphLink[];
}

export interface IGraphLayoutOptions<N extends IGraphNode> {
	readonly data: IGraphData<N>;
	readonly scope: GraphScope;
	/** The chart column's width (px): the viewport the axis scrolls in. */
	readonly width: number;
	/** The axis's focus, 0 (the first day open) to 1 (today open, the default). */
	readonly focus?: number;
	/** Epoch seconds. */
	readonly now: number;
	/** The fold at the bottom is open. */
	readonly foldOpen: boolean;
	/** The status the window shows for a task (the Waiting for you poll knows more than the board). */
	readonly statusOf?: (n: N) => GraphStatus;
	/** Sessions with an agent at work right now (their ids). */
	readonly live?: ReadonlySet<string>;
}

export interface IGraphRow<N extends IGraphNode> {
	readonly index: number;
	readonly thing: IGraphThing;
	/** The thing's tasks, oldest first. */
	readonly tasks: readonly N[];
	/** Session scope: the session's own tasks in it (project scope: all). */
	readonly mine: readonly N[];
	readonly y: number;
	/** The line's y. */
	readonly cy: number;
	/** Session scope: a thing the session asked nothing in (shown only when the fold is open). */
	readonly dim: boolean;
	/** Below the fold head. */
	readonly folded: boolean;
	readonly count: number;
	/** Where it stands (session scope: by the session's own tasks). */
	readonly state: GraphStatus;
	/** The task the row names on the right: the newest in that state (the last one when all are done). */
	readonly nowTask: N;
	readonly buckets: readonly IDayBucket<N>[];
}

export interface IGraphMark<N extends IGraphNode> {
	/** The same mark in every frame of a sliding axis (so the page moves its element, not draws a new one). */
	readonly key: string;
	readonly row: number;
	readonly x: number;
	readonly y: number;
	readonly r: number;
	/** Something in it is not done: an open ring. */
	readonly open: boolean;
	/** bucket: the project's tasks of one hour / half day / day; context: those behind the session's (faint,
	 *  no hover); mine: one of the session's own tasks. */
	readonly kind: 'bucket' | 'context' | 'mine';
	readonly items: readonly N[];
	readonly bucket: IDayBucket<N>;
	/** How visible (0 to 1): a day opening cross-fades its one mark into its hours. */
	readonly fade: number;
	/** The hover target's radius: at most half the way to the next mark. */
	readonly hitR: number;
	readonly dim: boolean;
}

export interface IGraphLine {
	readonly key: string;
	readonly row: number;
	readonly x1: number;
	readonly x2: number;
	readonly y: number;
	/** Not done and not touched since the last task: dashed, up to now. */
	readonly idle: boolean;
	readonly dim: boolean;
}

export interface IGraphPath {
	readonly key: string;
	readonly d: string;
	/** branch: drawn; merge: only while one of its rows is hovered; route: the session's line. */
	readonly kind: 'branch' | 'merge' | 'route';
	readonly rows: readonly number[];
	/** Worked out from the session's order, not written down by the agent: drawn dashed. */
	readonly inferred?: boolean;
}

export interface IGraphEnd {
	readonly row: number;
	readonly x: number;
	readonly y: number;
	readonly state: 'in_progress' | 'waiting' | 'todo';
	readonly live: boolean;
}

export interface IGraphFold {
	readonly y: number;
	readonly count: number;
	readonly open: boolean;
	/** quiet: "No activity in 7 days"; session: "Not in this session". */
	readonly kind: 'quiet' | 'session';
}

export interface IGraphOrigin<N extends IGraphNode> {
	readonly kind: 'branch' | 'merge';
	readonly from: N;
	readonly gapDays: number;
	readonly inferred: boolean;
}

export interface IGraphLayout<N extends IGraphNode> {
	readonly axis: IDayAxis;
	readonly labels: IDayAxisLabels;
	readonly rows: readonly IGraphRow<N>[];
	readonly fold?: IGraphFold;
	readonly height: number;
	readonly lines: readonly IGraphLine[];
	readonly marks: readonly IGraphMark<N>[];
	readonly paths: readonly IGraphPath[];
	readonly ends: readonly IGraphEnd[];
	/** Why a task's row is where it is: the thing it branched off, or came back from. */
	readonly origin: ReadonlyMap<string, IGraphOrigin<N>>;
	/** What the page's one line of data counts (session scope: the session's own). */
	readonly counts: { readonly tasks: number; readonly things: number; readonly waiting: number };
	/** Nothing to draw: the session asked nothing yet, or the project has nothing in the window. */
	readonly empty?: 'session' | 'project';
}

export const ROW_H = 32;
export const FOLD_H = 28;
export const FOLD_GAP = 8;
/** The end marks sit this far in from the axis's right end (the Now line). */
export const END_INSET = 9;
/** Session marks side by side: this far apart (as far as the day or hour has room for). */
const SPREAD = 8;
const RANK: Record<GraphStatus, number> = { done: 0, todo: 1, in_progress: 2, waiting: 3 };

export function stateOf(statuses: readonly GraphStatus[]): GraphStatus {
	let s: GraphStatus = 'done';
	for (const x of statuses) {
		if (RANK[x] > RANK[s]) {
			s = x;
		}
	}
	return s;
}

/** A mark's radius by how many tasks it holds: 3, 4 (two or more), 5 (five or more). */
export function markRadius(n: number): number {
	return n >= 5 ? 5 : n >= 2 ? 4 : 3;
}

/** From a to b: down (or up) to b's row, a 6 px corner, across to b. */
export function elbow(a: { x: number; y: number }, b: { x: number; y: number }, r = 6): string {
	const f = (n: number) => Math.round(n * 10) / 10;
	if (Math.abs(b.y - a.y) < 0.5) {
		return `M${f(a.x)} ${f(a.y)}H${f(b.x)}`;
	}
	if (Math.abs(b.x - a.x) < r + 1) {
		return `M${f(a.x)} ${f(a.y)}V${f(b.y)}` + (Math.abs(b.x - a.x) > 0.5 ? `H${f(b.x)}` : '');
	}
	const dy = b.y > a.y ? 1 : -1;
	const dx = b.x > a.x ? 1 : -1;
	return `M${f(a.x)} ${f(a.y)}V${f(b.y - dy * r)}Q${f(a.x)} ${f(b.y)} ${f(a.x + dx * r)} ${f(b.y)}H${f(b.x)}`;
}

/** A row (or the fold head) as far as a switch of scope or fold goes: where it is, the space over it that is
 *  its own (the fold head's gap), its height. */
export interface IGraphSlot {
	readonly id: string;
	readonly y: number;
	readonly lead: number;
	readonly h: number;
}

export interface IGraphMove {
	readonly id: string;
	/** stay: in both drawings, in the same order; come: only in the new one (or one that would jump past
	 *  others: it goes where it was and comes where it will be); go: only in the old one. */
	readonly kind: 'stay' | 'come' | 'go';
	/** Its y in its own drawing (the old one for go). */
	readonly y: number;
	readonly h: number;
	/** Per sample: how far from that y, how open (0 to 1), how much is cut off top and bottom (px). */
	readonly frames: readonly { readonly offset: number; readonly dy: number; readonly open: number; readonly cut: number }[];
}

/**
 * From one drawing of the same answer to another (This session and the project, the fold opened or closed):
 * a row that comes opens from nothing to its height, one that goes closes to nothing, and every row's place
 * is the sum of the slots before it, so rows only ever push each other and no two overlap in any frame.
 * Sampled `samples` + 1 times along `ease`; the heights are the drawing's height at each sample.
 */
export function planSwitch(was: readonly IGraphSlot[], will: readonly IGraphSlot[], samples = 12, ease: (p: number) => number = p => 1 - Math.pow(1 - p, 3)): { moves: IGraphMove[]; heights: number[] } {
	const a = [...was].sort((x, y) => x.y - y.y);
	const b = [...will].sort((x, y) => x.y - y.y);
	const at = new Map(a.map((s, i) => [s.id, i]));
	// the rows that stay: those that keep their order
	const kept = new Set<string>();
	let last = -1;
	for (const s of b) {
		const i = at.get(s.id);
		if (i !== undefined && i > last) {
			kept.add(s.id);
			last = i;
		}
	}
	// both lists merged: what goes keeps its old place in the order, what comes takes its new one
	const order: { slot: IGraphSlot; kind: 'stay' | 'come' | 'go' }[] = [];
	let i = 0;
	let j = 0;
	const flush = (id: string | undefined) => {
		for (; i < a.length && a[i].id !== id; i++) {
			if (!kept.has(a[i].id)) {
				order.push({ slot: a[i], kind: 'go' });
			}
		}
		for (; j < b.length && b[j].id !== id; j++) {
			if (!kept.has(b[j].id)) {
				order.push({ slot: b[j], kind: 'come' });
			}
		}
	};
	for (const s of b) {
		if (kept.has(s.id)) {
			flush(s.id);
			order.push({ slot: s, kind: 'stay' });
			i++;
			j++;
		}
	}
	flush(undefined);
	const moves = order.map(o => ({ id: o.slot.id, kind: o.kind, y: o.slot.y, h: o.slot.h, frames: [] as { offset: number; dy: number; open: number; cut: number }[] }));
	const heights: number[] = [];
	const r = (n: number) => Math.round(n * 10) / 10;
	for (let k = 0; k <= samples; k++) {
		const offset = k / samples;
		const f = ease(offset);
		let y = 0;
		order.forEach((o, n) => {
			const open = o.kind === 'stay' ? 1 : o.kind === 'come' ? f : 1 - f;
			const lead = o.slot.lead * open;
			const room = o.slot.h * open;
			// the row sits in the middle of the room it has so far, cut to it
			moves[n].frames.push({ offset, dy: r(y + lead + (room - o.slot.h) / 2 - o.slot.y), open, cut: r(Math.max(0, (o.slot.h - room) / 2)) });
			y += lead + room;
		});
		heights.push(r(y));
	}
	return { moves, heights };
}

/**
 * What the page's line of data counts (session scope: the session's own tasks), and whether there is
 * nothing to draw: the session asked nothing yet, or the project has nothing in the window.
 */
export function graphCounts<N extends IGraphNode>(data: IGraphData<N>, scope: GraphScope, statusOf: (n: N) => GraphStatus = n => n.status): { tasks: number; things: number; waiting: number; empty?: 'session' | 'project' } {
	const nodes = data.nodes ?? [];
	const mine = scope === 'session' ? nodes.filter(n => n.mine) : nodes;
	const empty = scope === 'session' && !mine.length ? 'session' : !nodes.length ? 'project' : undefined;
	return {
		tasks: mine.length,
		things: new Set(mine.map(n => n.thing.id)).size,
		waiting: mine.filter(n => statusOf(n) === 'waiting').length,
		...(empty ? { empty } : {}),
	};
}

export function layoutTaskGraph<N extends IGraphNode>(o: IGraphLayoutOptions<N>): IGraphLayout<N> {
	const statusOf = o.statusOf ?? ((n: N) => n.status);
	const nodes = [...(o.data.nodes ?? [])].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
	const session = o.scope === 'session';
	const W = Math.max(0, o.width);
	const axis = dayAxis({ times: nodes.map(n => n.at), now: o.now, view: W, days: o.data.days || 30, focus: o.focus });
	const labels = dayAxisLabels(axis);
	const byId = new Map(nodes.map(n => [n.id, n]));
	const byThing = new Map<string, N[]>();
	for (const n of nodes) {
		const list = byThing.get(n.thing.id);
		if (list) {
			list.push(n);
		} else {
			byThing.set(n.thing.id, [n]);
		}
	}
	// the things in the CLI's drawing order; one the CLI did not list (an older CLI) goes last
	const things: IGraphThing[] = (o.data.things ?? []).filter(t => byThing.has(t.id));
	for (const [id, ts] of byThing) {
		if (!things.some(t => t.id === id)) {
			things.push({ id, name: ts[0].thing.name, first_at: ts[0].at, last_at: ts[ts.length - 1].at, parent: null, quiet: ts[ts.length - 1].at < o.now - 7 * 86400 });
		}
	}
	const isMine = (n: N) => !!n.mine;
	const { empty, ...counts } = graphCounts(o.data, o.scope, statusOf);
	if (empty) {
		return { axis, labels, rows: [], height: 0, lines: [], marks: [], paths: [], ends: [], origin: new Map(), counts, empty };
	}

	// which rows are up and which fold away
	const up: IGraphThing[] = [];
	const down: IGraphThing[] = [];
	for (const t of things) {
		const keep = session ? byThing.get(t.id)!.some(isMine) : !t.quiet;
		(keep ? up : down).push(t);
	}
	const rows: IGraphRow<N>[] = [];
	let y = 0;
	const addRow = (t: IGraphThing, folded: boolean) => {
		const tasks = byThing.get(t.id)!;
		const mine = session ? tasks.filter(isMine) : tasks;
		const dim = session && !mine.length;
		const basis = mine.length ? mine : tasks;
		const state = stateOf(basis.map(statusOf));
		const nowTask = state === 'done' ? basis[basis.length - 1] : [...basis].reverse().find(n => statusOf(n) === state)!;
		rows.push({
			index: rows.length, thing: t, tasks, mine, y, cy: y + ROW_H / 2, dim, folded,
			count: dim ? tasks.length : mine.length, state, nowTask, buckets: dayBuckets(axis, tasks),
		});
		y += ROW_H;
	};
	for (const t of up) {
		addRow(t, false);
	}
	let fold: IGraphFold | undefined;
	if (down.length) {
		y += FOLD_GAP;
		fold = { y, count: down.length, open: o.foldOpen, kind: session ? 'session' : 'quiet' };
		y += FOLD_H;
		if (o.foldOpen) {
			for (const t of down) {
				addRow(t, true);
			}
		}
	}
	const height = y;

	const lines: IGraphLine[] = [];
	const marks: IGraphMark<N>[] = [];
	const ends: IGraphEnd[] = [];
	const paths: IGraphPath[] = [];
	const pos = new Map<string, { x: number; y: number; row: number }>();
	const endX = axis.width - END_INSET;
	// a thing with an agent at work on it now: the newest task in progress of each live session
	const liveThings = new Set<string>();
	if (!session && o.live?.size) {
		const newest = new Map<string, N>();
		for (const n of nodes) {
			if (n.session && o.live.has(n.session) && statusOf(n) === 'in_progress') {
				newest.set(n.session, n);
			}
		}
		for (const n of newest.values()) {
			liveThings.add(n.thing.id);
		}
	}
	for (const row of rows) {
		const bs = row.buckets;
		for (const b of bs) {
			// a task in two buckets of a day opening is where the one that shows more has it
			if (b.fade >= 0.5) {
				for (const n of b.items) {
					pos.set(n.id, { x: b.x, y: row.cy, row: row.index });
				}
			}
		}
		let x1 = Infinity;
		let x2 = -Infinity;
		for (const b of bs) {
			x1 = Math.min(x1, b.x);
			x2 = Math.max(x2, b.x);
		}
		const open = row.tasks.some(n => statusOf(n) !== 'done');
		if (x2 - x1 > 0.5) {
			lines.push({ key: `${row.index}:s`, row: row.index, x1, x2, y: row.cy, idle: false, dim: row.dim });
		}
		if (open && endX - x2 > 2) {
			lines.push({ key: `${row.index}:i`, row: row.index, x1: x2, x2: endX, y: row.cy, idle: true, dim: row.dim });
		}
		const xs = bs.map(b => b.x).sort((a, b) => a - b);
		bs.forEach(b => {
			const at = xs.indexOf(b.x);
			const gapL = at > 0 ? b.x - xs[at - 1] : 99;
			const gapR = at < xs.length - 1 ? xs[at + 1] - b.x : 99;
			const hitR = Math.max(4, Math.min(9, gapL / 2, gapR / 2));
			const others = session ? b.items.filter(n => !isMine(n)) : b.items;
			if (session && !others.length) {
				return;   // only the session's own tasks here: they are drawn one by one below
			}
			marks.push({
				key: `${row.index}|${b.key}`, row: row.index, x: b.x, y: row.cy, r: markRadius(b.items.length), open: b.items.some(n => statusOf(n) !== 'done'),
				kind: session ? 'context' : 'bucket', items: b.items, bucket: b, fade: b.fade, hitR, dim: row.dim,
			});
		});
		if (!row.dim && row.state !== 'done' && (!session || row.mine.length)) {
			ends.push({ row: row.index, x: endX, y: row.cy, state: row.state, live: liveThings.has(row.thing.id) && row.state === 'in_progress' });
		}
	}

	const origin = new Map<string, IGraphOrigin<N>>();
	for (const l of o.data.links ?? []) {
		const from = byId.get(l.from);
		if (from && byId.has(l.to) && l.kind !== 'hop') {
			origin.set(l.to, { kind: l.kind, from, gapDays: l.gap_days ?? 0, inferred: l.source !== 'explicit' });
		}
	}
	if (!session) {
		for (const l of o.data.links ?? []) {
			if (l.kind === 'hop') {
				continue;
			}
			const a = pos.get(l.from);
			const b = pos.get(l.to);
			if (a && b && a.row !== b.row) {
				paths.push({ key: `${l.kind}|${l.from}>${l.to}`, d: elbow(a, b), kind: l.kind, rows: [a.row, b.row], inferred: l.source !== 'explicit' });
			}
		}
	} else {
		// the session's tasks one by one, in whichever of its rows: the ones asked in the same day (folded) or hour
		// (open) side by side in the order they were asked (so each move to another thing has its own way down),
		// joined in that order by one dark line. A task's place is its hour's middle, which a shut day pulls to its
		// own middle, plus its offset in the day's row of marks, lerped to its offset in the hour's as the day opens.
		type Mine = { n: N; row: IGraphRow<N>; slot: IDaySlot; hour: { start: number; end: number } };
		const mine: Mine[] = [];
		for (const row of rows) {
			if (!row.dim) {
				for (const n of row.mine) {
					const slot = axis.days[dayIndexOf(axis, n.at)];
					mine.push({ n, row, slot, hour: hourOf(axis, slot, n.at) });
				}
			}
		}
		mine.sort((a, b) => a.n.at - b.n.at || (a.n.id < b.n.id ? -1 : 1));
		const cell = (key: (m: Mine) => number) => {
			const by = new Map<number, Mine[]>();
			for (const m of mine) {
				const k = key(m);
				by.set(k, [...(by.get(k) ?? []), m]);
			}
			return by;
		};
		const dayCell = cell(m => m.slot.start);
		const hourCell = cell(m => m.hour.start);
		const placed = mine.map(m => {
			const inDay = dayCell.get(m.slot.start)!;
			const inHour = hourCell.get(m.hour.start)!;
			const stepD = inDay.length > 1 ? Math.min(SPREAD, Math.max(2.5, (m.slot.foldedW - 8) / (inDay.length - 1))) : 0;
			const stepH = inHour.length > 1 ? Math.min(SPREAD, Math.max(2.5, (m.slot.openW / 24) / inHour.length)) : 0;
			const off = lerp(spread(inDay.indexOf(m), inDay.length, stepD), spread(inHour.indexOf(m), inHour.length, stepH), m.slot.e);
			const x = Math.min(axis.width - 6, Math.max(3, slotX(m.slot, (m.hour.start + Math.min(m.hour.end, axis.now)) / 2) + off));
			return { ...m, x, y: m.row.cy };
		});
		for (let i = 0; i < placed.length; i++) {
			const p = placed[i];
			const prev = i > 0 && placed[i - 1].row === p.row ? placed[i - 1] : undefined;
			const next = i < placed.length - 1 && placed[i + 1].row === p.row ? placed[i + 1] : undefined;
			const gapL = prev ? Math.abs(p.x - prev.x) : 99;
			const gapR = next ? Math.abs(next.x - p.x) : 99;
			const b = primaryBucketOf(axis, p.n.at);
			marks.push({
				key: `m|${p.n.id}`, row: p.row.index, x: p.x, y: p.y, r: 3.5, open: statusOf(p.n) !== 'done', kind: 'mine', items: [p.n], bucket: { ...b, items: [p.n] }, fade: 1,
				hitR: Math.max(4, Math.min(8, gapL / 2, gapR / 2)), dim: false,
			});
			if (i > 0) {
				const a = placed[i - 1];
				paths.push({ key: `r|${i}`, d: a.row === p.row ? `M${Math.round(a.x * 10) / 10} ${a.y}H${Math.round(p.x * 10) / 10}` : elbow(a, p), kind: 'route', rows: [a.row.index, p.row.index] });
			}
		}
	}
	return { axis, labels, rows, fold, height, lines, marks, paths, ends, origin, counts };
}
