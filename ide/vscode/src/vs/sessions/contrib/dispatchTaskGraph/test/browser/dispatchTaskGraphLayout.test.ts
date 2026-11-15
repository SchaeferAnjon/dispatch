/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Task graph's layout (patches/430-tasks.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DAY, HOUR, midnight } from '../../browser/dispatchDayAxis.js';
import { elbow, END_INSET, FOLD_GAP, FOLD_H, graphCounts, type IGraphNode, layoutTaskGraph, markRadius, planSwitch, ROW_H } from '../../browser/dispatchTaskGraphLayout.js';

// Sunday Sep 27 2026, 20:42 local time
const NOW = new Date(2026, 8, 27, 20, 42).getTime() / 1000;
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime() / 1000;

function node(id: string, thing: string, t: number, status: IGraphNode['status'] = 'done', extra: Partial<IGraphNode> = {}): IGraphNode {
	return { id, title: `${thing} ${id}`, status, thing: { id: `th-${thing}`, name: thing }, at: t, session: 's1', ...extra };
}

suite('Dispatch task graph layout', () => {

	const data = {
		days: 30,
		things: [
			{ id: 'th-A', name: 'A', first_at: at(9, 3), last_at: NOW - HOUR, parent: null, quiet: false },
			{ id: 'th-B', name: 'B', first_at: at(9, 4), last_at: at(9, 26), parent: 'th-A', quiet: false },
			{ id: 'th-Q', name: 'Q', first_at: at(9, 5), last_at: at(9, 6), parent: null, quiet: true },
		],
		nodes: [
			node('task-a1', 'A', at(9, 3)),
			node('task-a2', 'A', at(9, 3, 15)),
			node('task-b1', 'B', at(9, 4), 'done', { from: { id: 'task-a2', source: 'explicit' } }),
			node('task-q1', 'Q', at(9, 5), 'todo', { session: 's2' }),
			node('task-q2', 'Q', at(9, 6), 'done', { session: 's2' }),
			node('task-b2', 'B', at(9, 26), 'waiting'),
			node('task-a3', 'A', NOW - HOUR, 'in_progress', { from: { id: 'task-b2', source: 'inferred' } }),
		],
		links: [
			{ from: 'task-a2', to: 'task-b1', kind: 'branch' as const, gap_days: 0, source: 'explicit' as const },
			{ from: 'task-b2', to: 'task-a3', kind: 'merge' as const, gap_days: 24, source: 'inferred' as const },
		],
	};

	test('a row per thing, quiet ones folded', () => {
		const l = layoutTaskGraph({ data, scope: 'project', width: 656, now: NOW, foldOpen: false });
		assert.deepStrictEqual(l.rows.map(r => r.thing.name), ['A', 'B']);
		assert.deepStrictEqual(l.fold, { y: 2 * ROW_H + 8, count: 1, open: false, kind: 'quiet' });
		assert.strictEqual(l.height, 2 * ROW_H + 8 + 28);
		const open = layoutTaskGraph({ data, scope: 'project', width: 656, now: NOW, foldOpen: true });
		assert.deepStrictEqual(open.rows.map(r => [r.thing.name, r.folded]), [['A', false], ['B', false], ['Q', true]]);
		assert.deepStrictEqual(l.counts, { tasks: 7, things: 3, waiting: 1 });
	});

	test('marks per bucket, the line to the last one, dashed to now when not done, colour only at the end', () => {
		const l = layoutTaskGraph({ data, scope: 'project', width: 656, now: NOW, foldOpen: true, live: new Set(['s1']) });
		const a = l.marks.filter(m => m.row === 0);
		assert.deepStrictEqual(a.map(m => m.items.length), [2, 1]);   // Sep 3 (a folded day: two), today (open, by hour: one)
		assert.deepStrictEqual(a.map(m => m.bucket.hourly), [false, true]);
		assert.strictEqual(a[0].r, markRadius(2));
		assert.ok(!a[0].open && a[1].open);
		const lines = l.lines.filter(x => x.row === 0);
		const solid = lines.find(x => !x.idle)!, idle = lines.find(x => x.idle)!;
		assert.strictEqual(solid.x1, a[0].x);
		assert.strictEqual(solid.x2, a[1].x);
		assert.deepStrictEqual([idle.x1, idle.x2], [a[1].x, l.axis.width - END_INSET], 'A is in progress: dashed from its last task to the end of the axis (Now)');
		assert.deepStrictEqual(l.ends.map(e => [e.row, e.state, e.live]), [[0, 'in_progress', true], [1, 'waiting', false], [2, 'todo', false]]);
		assert.ok(l.lines.some(x => x.row === 1 && x.idle), 'B is waiting and untouched since Sep 26: dashed to now');
		assert.deepStrictEqual(l.paths.map(p => [p.kind, p.rows, p.inferred]), [['branch', [0, 1], false], ['merge', [1, 0], true]]);
		assert.strictEqual(l.origin.get('task-b1')?.kind, 'branch');
		assert.strictEqual(l.origin.get('task-b1')?.inferred, false);
		assert.strictEqual(l.origin.get('task-a3')?.gapDays, 24);
		assert.strictEqual(l.origin.get('task-a3')?.inferred, true);
		assert.deepStrictEqual(l.rows.map(r => r.nowTask.id), ['task-a3', 'task-b2', 'task-q1']);
	});

	test('the window can know more: a Waiting for you session makes an in-progress task wait', () => {
		const l = layoutTaskGraph({ data, scope: 'project', width: 656, now: NOW, foldOpen: false, statusOf: n => n.id === 'task-a3' ? 'waiting' : n.status });
		assert.strictEqual(l.ends[0].state, 'waiting');
		assert.strictEqual(l.counts.waiting, 2);
	});

	test('This session: its things, its tasks one by one on one line, the rest faint and folded', () => {
		const mine = { ...data, nodes: data.nodes.map(n => ({ ...n, mine: n.session === 's1' })) };
		const l = layoutTaskGraph({ data: mine, scope: 'session', width: 656, now: NOW, foldOpen: false });
		assert.deepStrictEqual(l.rows.map(r => r.thing.name), ['A', 'B']);
		assert.strictEqual(l.fold?.kind, 'session');
		const me = l.marks.filter(m => m.kind === 'mine');
		assert.strictEqual(me.length, 5);
		const a1 = me.find(m => m.items[0].id === 'task-a1')!, a2 = me.find(m => m.items[0].id === 'task-a2')!;
		assert.strictEqual(Math.abs(a2.x - a1.x), 8, 'two in one bucket sit 8 px apart');
		assert.strictEqual(l.paths.filter(p => p.kind === 'route').length, 4);
		assert.ok(!l.paths.some(p => p.kind === 'branch'));
		const open = layoutTaskGraph({ data: mine, scope: 'session', width: 656, now: NOW, foldOpen: true });
		assert.deepStrictEqual(open.rows.map(r => r.dim), [false, false, true]);
		assert.ok(!open.ends.some(e => e.row === 2));
	});

	test('This session: moves between things in one half day each get their own way down', () => {
		const things = ['X', 'Y', 'Z'].map((name, i) => ({ id: `th-${name}`, name, first_at: at(9, 25, 9 + i), last_at: at(9, 25, 11), parent: null, quiet: false }));
		const nodes = [
			node('task-x1', 'X', at(9, 25, 9), 'done', { mine: true }),
			node('task-y1', 'Y', at(9, 25, 9, 30), 'done', { mine: true }),
			node('task-z1', 'Z', at(9, 25, 10), 'done', { mine: true }),
			node('task-x2', 'X', at(9, 25, 11), 'todo', { mine: true }),
		];
		const l = layoutTaskGraph({ data: { days: 30, things, nodes, links: [] }, scope: 'session', width: 656, now: NOW, foldOpen: false });
		const x = (id: string) => l.marks.find(m => m.kind === 'mine' && m.items[0].id === id)!.x;
		assert.deepStrictEqual([x('task-y1') - x('task-x1'), x('task-z1') - x('task-y1'), x('task-x2') - x('task-z1')], [8, 8, 8], 'one cell, 8 px apart in the order asked');
		const route = l.paths.filter(p => p.kind === 'route');
		assert.strictEqual(route.length, 3);
		const downs = route.map(p => p.d.split('V')[0]);
		assert.strictEqual(new Set(downs).size, 3, 'no two moves share a vertical');
	});

	test('switching scope or fold: rows open, close and push, never overlapping in any frame', () => {
		const slots = (l: ReturnType<typeof layoutTaskGraph>) => [
			...l.rows.map(r => ({ id: r.thing.id, y: r.y, lead: 0, h: ROW_H })),
			...(l.fold ? [{ id: 'fold', y: l.fold.y, lead: FOLD_GAP, h: FOLD_H }] : []),
		];
		const noOverlap = (plan: ReturnType<typeof planSwitch>, what: string) => {
			const k = plan.heights.length;
			for (let f = 0; f < k; f++) {
				const shown = plan.moves.map(m => ({ id: m.id, top: m.y + m.frames[f].dy + m.frames[f].cut, bottom: m.y + m.frames[f].dy + m.h - m.frames[f].cut }))
					.filter(s => s.bottom - s.top > 0.5).sort((a, b) => a.top - b.top);
				for (let i = 1; i < shown.length; i++) {
					assert.ok(shown[i].top >= shown[i - 1].bottom - 0.15, `${what}, frame ${f}: ${shown[i - 1].id} over ${shown[i].id}`);
				}
			}
		};
		const mine = { ...data, nodes: data.nodes.map(n => ({ ...n, mine: n.session === 's1' && n.id !== 'task-b2' })) };
		const views = [
			layoutTaskGraph({ data: mine, scope: 'session', width: 656, now: NOW, foldOpen: false }),
			layoutTaskGraph({ data: mine, scope: 'session', width: 656, now: NOW, foldOpen: true }),
			layoutTaskGraph({ data: mine, scope: 'project', width: 656, now: NOW, foldOpen: false }),
			layoutTaskGraph({ data: mine, scope: 'project', width: 656, now: NOW, foldOpen: true }),
		];
		for (const a of views) {
			for (const b of views) {
				if (a !== b) {
					const plan = planSwitch(slots(a), slots(b));
					noOverlap(plan, 'layouts');
					// where everything starts and lands: its old place, its new one
					for (const m of plan.moves) {
						const first = m.frames[0], end = m.frames[m.frames.length - 1];
						if (m.kind === 'go') {
							assert.deepStrictEqual([first.dy, first.open, end.open], [0, 1, 0]);
						} else {
							assert.deepStrictEqual([end.dy, end.open], [0, 1]);
						}
						if (m.kind === 'stay') {
							assert.strictEqual(first.dy, slots(a).find(s => s.id === m.id)!.y - m.y);
						}
					}
					assert.strictEqual(plan.heights[plan.heights.length - 1], b.height);
				}
			}
		}
		// a row that would jump past others goes where it was and comes where it will be
		const row = (id: string, y: number) => ({ id, y, lead: 0, h: ROW_H });
		const jump = planSwitch([row('a', 0), row('b', 32), row('c', 64)], [row('c', 0), row('a', 32), row('b', 64)]);
		assert.deepStrictEqual(jump.moves.map(m => `${m.kind} ${m.id}`), ['go a', 'go b', 'stay c', 'come a', 'come b']);
		noOverlap(jump, 'jump');
	});

	test('the axis slides: the same rows and marks at any focus, only where they are changes', () => {
		const keys = (focus: number) => {
			const l = layoutTaskGraph({ data, scope: 'project', width: 536, now: NOW, foldOpen: true, focus });
			return { l, marks: l.marks.map(m => m.key) };
		};
		const today = keys(1);
		const first = keys(0);
		assert.deepStrictEqual(first.l.rows.map(r => r.thing.id), today.l.rows.map(r => r.thing.id));
		assert.strictEqual(first.l.height, today.l.height);
		assert.deepStrictEqual(first.l.lines.map(x => x.key), today.l.lines.map(x => x.key));
		assert.deepStrictEqual(first.l.paths.map(x => x.key), today.l.paths.map(x => x.key));
		assert.deepStrictEqual(first.l.ends.map(e => [e.row, e.state]), today.l.ends.map(e => [e.row, e.state]));
		// every mark lies inside the axis, at every focus, and a row's line runs between its marks
		for (let k = 0; k <= 48; k++) {
			const l = layoutTaskGraph({ data, scope: 'project', width: 536, now: NOW, foldOpen: true, focus: k / 48 });
			assert.ok(l.marks.every(m => m.x >= 0 && m.x <= l.axis.width), `focus ${k}/48`);
			assert.ok(l.marks.every(m => m.fade > 0 && m.fade <= 1));
			assert.ok(l.axis.width > 536, 'a month of days does not fit the column: it slides');
			assert.deepStrictEqual(l.ends.map(e => e.x), l.ends.map(() => l.axis.width - END_INSET));
		}
	});

	test('the day the focus is on is open by the hour, the others one mark each', () => {
		const sep3 = data.nodes.filter(n => n.at < at(9, 4));
		const probe = layoutTaskGraph({ data, scope: 'project', width: 536, now: NOW, foldOpen: false });
		const i = probe.axis.days.findIndex(d => d.start === midnight(at(9, 3)));
		const open = layoutTaskGraph({ data, scope: 'project', width: 536, now: NOW, foldOpen: false, focus: probe.axis.centers[i] });
		const a = open.marks.filter(m => m.row === 0 && m.bucket.day === i);
		assert.deepStrictEqual(a.map(m => [m.bucket.hourly, m.items.length, m.fade]), [[true, 1, 1], [true, 1, 1]], 'a1 at noon and a2 at 15:00, an hour each');
		assert.strictEqual(sep3.length, 2);
		// today is shut now: one mark for its task
		const today = open.marks.filter(m => m.row === 0 && m.bucket.day === open.axis.days.length - 1);
		assert.deepStrictEqual(today.map(m => [m.bucket.hourly, m.items.length]), [[false, 1]]);
		assert.ok(a[0].x < a[1].x);
		assert.ok(a[0].x >= open.axis.days[i].x0 && a[1].x <= open.axis.days[i].x1);
	});

	test('a day opening cross-fades its mark into its hours: no mark pops, the two fades add to one', () => {
		const probe = layoutTaskGraph({ data, scope: 'project', width: 536, now: NOW, foldOpen: false });
		const i = probe.axis.days.findIndex(d => d.start === midnight(at(9, 26)));
		const [c0, c1] = [probe.axis.centers[i - 1], probe.axis.centers[i]];
		let mixed = 0;
		for (let k = 0; k <= 60; k++) {
			const l = layoutTaskGraph({ data, scope: 'project', width: 536, now: NOW, foldOpen: false, focus: c0 + (c1 - c0) * k / 60 });
			const day = l.marks.filter(m => m.row === 1 && m.bucket.day === i);
			const daily = day.filter(m => !m.bucket.hourly);
			const hourly = day.filter(m => m.bucket.hourly);
			if (daily.length && hourly.length) {
				mixed++;
				assert.ok(Math.abs(daily[0].fade + hourly[0].fade - 1) < 1e-9);
			}
			assert.ok(day.length > 0);
		}
		assert.ok(mixed > 5);
	});

	test('This session: a task keeps its mark (and key) while the day opens, and slides from its day to its hour', () => {
		const mine = { ...data, nodes: data.nodes.map(n => ({ ...n, mine: n.session === 's1' })) };
		const probe = layoutTaskGraph({ data: mine, scope: 'session', width: 536, now: NOW, foldOpen: false });
		const i = probe.axis.days.findIndex(d => d.start === midnight(at(9, 26)));
		const xs: number[] = [];
		for (let k = 0; k <= 20; k++) {
			const l = layoutTaskGraph({ data: mine, scope: 'session', width: 536, now: NOW, foldOpen: false, focus: probe.axis.centers[i - 1] + (probe.axis.centers[i] - probe.axis.centers[i - 1]) * k / 20 });
			const b2 = l.marks.find(m => m.key === 'm|task-b2')!;
			assert.strictEqual(b2.fade, 1);
			xs.push(b2.x - l.axis.days[i].x0);
		}
		// it is somewhere in the slot all the way, and ends where noon is in the open day
		assert.ok(xs.every(x => x > 0));
		const open = layoutTaskGraph({ data: mine, scope: 'session', width: 536, now: NOW, foldOpen: false, focus: probe.axis.centers[i] });
		const d = open.axis.days[i];
		const b2 = open.marks.find(m => m.key === 'm|task-b2')!;
		assert.ok(Math.abs(b2.x - (d.x0 + (d.x1 - d.x0) * 12.5 / 24)) < 1, 'asked at noon: the middle of the hour 12 to 13');
	});

	test('empty: a session that asked nothing, a project with nothing', () => {
		assert.strictEqual(graphCounts({ nodes: data.nodes }, 'session').empty, 'session');
		assert.strictEqual(layoutTaskGraph({ data: { nodes: [] }, scope: 'project', width: 656, now: NOW, foldOpen: false }).empty, 'project');
		assert.strictEqual(layoutTaskGraph({ data: { nodes: [] }, scope: 'session', width: 656, now: NOW, foldOpen: false }).empty, 'session');
	});

	test('elbow: down to the row, a 6 px corner, across', () => {
		assert.strictEqual(elbow({ x: 10, y: 16 }, { x: 60, y: 48 }), 'M10 16V42Q10 48 16 48H60');
		assert.strictEqual(elbow({ x: 10, y: 48 }, { x: 13, y: 16 }), 'M10 48V16H13');
		assert.strictEqual(elbow({ x: 10, y: 16 }, { x: 60, y: 16 }), 'M10 16H60');
	});

	test('364 tasks in 21 things lay out fast', () => {
		const things = Array.from({ length: 21 }, (_, i) => ({ id: `th-${i}`, name: `T${i}`, first_at: at(9, 2), last_at: NOW, parent: null, quiet: false }));
		const nodes: IGraphNode[] = Array.from({ length: 364 }, (_, i) => node(`task-${i}`, `${i % 21}`, NOW - (i * 7919 % (29 * DAY)), i % 5 ? 'done' : 'in_progress'))
			.map(n => ({ ...n, thing: { id: `th-${n.thing.name}`, name: `T${n.thing.name}` } }));
		const t0 = Date.now();
		const l = layoutTaskGraph({ data: { things, nodes, links: [] }, scope: 'project', width: 656, now: NOW, foldOpen: false });
		assert.strictEqual(l.rows.length, 21);
		assert.ok(Date.now() - t0 < 200);
	});
});
