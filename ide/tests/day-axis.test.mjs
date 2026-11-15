import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchTaskGraph/browser/dispatchDayAxis.ts'));

// Sunday Sep 27 2026, 20:42 local time
const NOW = new Date(2026, 8, 27, 20, 42).getTime() / 1000;
const at = (month, day, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime() / 1000;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const month = (focus, view = 656, first = at(9, 3)) => m.dayAxis({ times: [first], now: NOW, view, focus });

test('one slot a day from the first task to today, side by side with no gap', () => {
	const a = month();
	assert.equal(a.days.length, 25);   // Sep 3 to Sep 27
	assert.equal(a.days[0].start, m.midnight(at(9, 3)));
	assert.ok(a.days[a.days.length - 1].today);
	assert.equal(a.days[a.days.length - 1].end, NOW);
	a.days.forEach((d, i) => i && near(d.x0, a.days[i - 1].x1));
	near(a.days[0].x0, 0);
	near(a.days[a.days.length - 1].x1, a.width);
});

test('at most `days` back', () => {
	const a = m.dayAxis({ times: [at(8, 1)], now: NOW, view: 656, days: 30 });
	assert.equal(a.days.length, 30);
	assert.equal(a.start, m.midnight(NOW, 29));
});

test('the page opens on today: it is the open day, the others are folded, the page is scrolled to the end', () => {
	const a = month();
	const t = a.days[a.days.length - 1];
	assert.equal(t.e, 1);
	assert.ok(a.days.slice(0, -1).every(d => d.e === 0));
	assert.equal(a.g, 1);
	near(a.pan, a.room);
	assert.ok(a.width > a.view, 'four weeks do not fit 656 px: the page scrolls');
	assert.equal(m.focusDay(a), t);
});

test('a folded day is at least 32 px; an open day 384 to the viewport; today is a quarter of a day at least', () => {
	const a = month(0);
	assert.ok(a.days.slice(1).every(d => d.foldedW >= m.MIN_DAY_W));
	near(a.days[0].x1 - a.days[0].x0, a.days[0].openW);
	assert.ok(a.days[0].openW >= m.MIN_OPEN_W && a.days[0].openW <= a.view);
	const early = m.dayAxis({ times: [at(9, 3)], now: new Date(2026, 8, 27, 0, 20).getTime() / 1000, view: 656 });
	assert.ok(early.days[early.days.length - 1].openW >= 0.25 * 384 - 1);
});

test('the focus opens one day, or two next to each other sharing it; the openness always sums to one', () => {
	for (let k = 0; k <= 200; k++) {
		const a = month(k / 200);
		const es = a.days.map(d => d.e);
		near(es.reduce((x, y) => x + y, 0), 1, 1e-9);
		assert.ok(es.filter(e => e > 0).length <= 2);
		const lit = a.days.map((d, i) => d.e > 0 ? i : -1).filter(i => i >= 0);
		if (lit.length === 2) {
			assert.equal(lit[1], lit[0] + 1);
		}
	}
});

test('each day opens whole at its own centre, the first at 0 and today at 1', () => {
	const a = month();
	assert.equal(a.centers.length, a.days.length);
	assert.equal(a.centers[0], 0);
	assert.equal(a.centers[a.centers.length - 1], 1);
	a.centers.forEach((c, i) => {
		const b = month(c);
		assert.equal(b.days[i].e, 1, `day ${i}`);
		assert.equal(m.focusDay(b), b.days[i]);
	});
});

test('between two days one closes as the other opens, smoothly: no edge ever jumps', () => {
	// an edge moves at most smoothstep's steepest slope (1.5) times the width an open day gains, per day of focus
	const probe = month(0);
	const gain = probe.days[0].openW - probe.days[1].foldedW;
	const bound = (N) => 1.6 * (probe.days.length - 1) * gain / N;
	for (const N of [500, 4000]) {
		let prev = month(0);
		let worst = 0;
		for (let k = 1; k <= N; k++) {
			const a = month(k / N);
			a.days.forEach((d, i) => { worst = Math.max(worst, Math.abs(d.x1 - prev.days[i].x1), Math.abs(d.x0 - prev.days[i].x0)); });
			prev = a;
		}
		assert.ok(worst <= bound(N), `${N} steps: an edge moved ${worst} px, bound ${bound(N)}`);
	}
});

test('the page is scrolled to g * room, so the open day is always whole inside the viewport', () => {
	for (let i = 0; i < 25; i++) {
		const probe = month(1);
		const a = month(probe.centers[i]);
		const d = a.days[i];
		assert.ok(d.x0 >= a.pan - 1e-6 && d.x1 <= a.pan + a.view + 1e-6, `day ${i}: ${d.x0}..${d.x1} in ${a.pan}..${a.pan + a.view}`);
	}
	// between days the open ones share the viewport too: the first and the last of the two stay in
	const probe = month(1);
	for (let k = 0; k <= 240; k++) {
		const a = month(k / 240);
		assert.ok(a.pan >= -1e-9 && a.pan <= a.room + 1e-9);
		const open = a.days.filter(d => d.e > 0.5)[0];
		if (open) {
			assert.ok(open.x1 > a.pan && open.x0 < a.pan + a.view, 'the day that is mostly open is in view');
		}
	}
	assert.equal(probe.pan, probe.room);
});

test('one or two days fill the viewport', () => {
	const one = m.dayAxis({ times: [NOW - 3600], now: NOW, view: 656 });
	assert.equal(one.days.length, 1);
	near(one.width, 656);
	assert.equal(one.days[0].e, 1);
	const two = m.dayAxis({ times: [at(9, 26)], now: NOW, view: 656 });
	assert.equal(two.days.length, 2);
	near(two.width, 656);
	near(two.room, 0, 1e-6);
	const wide = m.dayAxis({ times: [at(9, 26)], now: NOW, view: 656, focus: 0 });
	assert.ok(wide.width > 656, 'with the first of two days open the page is wider than it');
});

test('x of a time: the middle of a shut day, by the clock across an open one, in proportion in between', () => {
	const shut = month(0);
	const d3 = shut.days[3];
	near(m.dayX(shut, d3.start + 5 * 3600), (d3.x0 + d3.x1) / 2);
	near(m.dayX(shut, d3.start + 20 * 3600), (d3.x0 + d3.x1) / 2);
	const open = month(0);
	const d0 = open.days[0];
	near(m.dayX(open, d0.start), d0.x0);
	near(m.dayX(open, d0.start + 12 * 3600), d0.x0 + (d0.x1 - d0.x0) / 2);
	near(m.dayX(open, d0.start + 6 * 3600), d0.x0 + (d0.x1 - d0.x0) / 4);
	// opening: the hours spread from the middle, none outside the slot
	for (let k = 0; k <= 20; k++) {
		const a = month(k / 20 * (1 / 24));
		for (const d of a.days) {
			for (let h = 0; h < 24 && d.start + h * 3600 < (d.today ? NOW : d.end); h++) {
				const x = m.slotX(d, d.start + h * 3600);
				assert.ok(x >= d.x0 - 1e-9 && x <= d.x1 + 1e-9);
			}
		}
	}
});

test('a day opening turns its one mark into its hours by cross-fade, never a jump', () => {
	const tasks = [{ at: at(9, 10, 9, 5) }, { at: at(9, 10, 9, 50) }, { at: at(9, 10, 15, 0) }];
	const i10 = month(1).days.findIndex(d => d.start === m.midnight(at(9, 10)));
	const centers = month(1).centers;
	const shut = m.dayBuckets(month(centers[i10] + 0.5 / 24), tasks);
	const mid = (a, b) => (a + b) / 2;
	const day = (g) => m.dayBuckets(month(g), tasks).filter(b => b.day === i10);
	// shut: one bucket, fully visible
	const far = day(0);
	assert.equal(far.length, 1);
	assert.equal(far[0].hourly, false);
	assert.equal(far[0].fade, 1);
	assert.equal(far[0].items.length, 3);
	// open: two hourly buckets (9: two tasks, 15: one), fully visible
	const open = day(centers[i10]);
	assert.deepEqual(open.map(b => [b.hourly, b.items.length, b.fade]), [[true, 2, 1], [true, 1, 1]]);
	// between: both kinds, fades add to one for each task
	let seenBoth = false;
	for (let k = 0; k <= 100; k++) {
		const g = centers[i10 - 1] + (centers[i10] - centers[i10 - 1]) * (k / 100);
		const bs = day(g);
		const daily = bs.filter(b => !b.hourly);
		const hourlyBs = bs.filter(b => b.hourly);
		if (daily.length && hourlyBs.length) {
			seenBoth = true;
			near(daily[0].fade + hourlyBs[0].fade, 1, 1e-9);
		}
		assert.ok(bs.every(b => b.fade > 0 && b.fade <= 1));
		assert.ok(bs.length >= 1);
	}
	assert.ok(seenBoth);
	assert.equal(shut.length > 0, true);
});

test('the marks of an open day pull together as it closes, to where its one mark is', () => {
	const tasks = [{ at: at(9, 10, 9, 5) }, { at: at(9, 10, 19, 0) }];
	const probe = month(1);
	const i = probe.days.findIndex(d => d.start === m.midnight(at(9, 10)));
	let lastSpread = Infinity;
	for (let k = 0; k <= 50; k++) {
		const g = probe.centers[i] + (probe.centers[i + 1] - probe.centers[i]) * (k / 50);
		const a = month(g);
		const hs = m.dayBuckets(a, tasks).filter(b => b.hourly);
		if (hs.length === 2) {
			const spreadPx = hs[1].x - hs[0].x;
			assert.ok(spreadPx <= lastSpread + 1e-9);
			lastSpread = spreadPx;
		}
	}
	assert.ok(lastSpread < 20);
});

test('labels: day numbers fade out as the day opens, its hours and title fade in, Now at the end', () => {
	const shut = m.dayAxisLabels(month(0.5));
	assert.ok(shut.ticks.some(t => t.kind === 'now' && t.label === 'Now'));
	const open = month(0).days[0];
	const l0 = m.dayAxisLabels(month(0));
	assert.ok(l0.titles.some(t => t.text === `${m.monthDay(open.start)} · by hour` && t.alpha === 1));
	assert.ok(l0.ticks.filter(t => t.kind === 'hour').length >= 20);
	assert.ok(!l0.ticks.some(t => t.kind === 'day' && t.day === open.start), 'the open day shows its hours, not its number');
	const half = m.dayAxisLabels(month(0.5 / 24));
	const num = half.ticks.find(t => t.kind === 'day' && t.day === open.start);
	assert.ok(num && num.alpha > 0 && num.alpha < 1);
	assert.ok(half.ticks.filter(t => t.kind === 'hour').every(t => t.alpha > 0 && t.alpha < 1));
	// the keys are unique, so a page can move elements instead of drawing again
	for (const l of [l0, half, shut]) {
		const keys = [...l.ticks.map(t => t.key), ...l.titles.map(t => t.key)];
		assert.equal(new Set(keys).size, keys.length);
	}
	// every labelled hour is whole
	assert.ok(l0.ticks.filter(t => t.kind === 'hour' && t.label).every(t => /^\d+:00$/.test(t.label)));
});

test('easeStd runs 0 to 1 and slows towards the end', () => {
	assert.equal(m.easeStd(0), 0);
	assert.equal(m.easeStd(1), 1);
	assert.ok(m.easeStd(0.25) > 0.5, 'fast at the start');
	let prev = 0;
	for (let k = 1; k <= 100; k++) {
		const e = m.easeStd(k / 100);
		assert.ok(e >= prev);
		prev = e;
	}
});

test('following a target closes the gap in the same time at any frame rate', () => {
	let a = 0;
	for (let k = 0; k < 10; k++) { a = m.follow(a, 1, 10, 45); }
	let b = 0;
	for (let k = 0; k < 5; k++) { b = m.follow(b, 1, 20, 45); }
	near(a, b, 1e-9);
	assert.equal(m.follow(0.99999, 1, 16, 45), 1);
});

function fakeClock() {
	let now = 0, id = 0;
	const frames = new Map(), timers = new Map();
	return {
		get now() { return now; },
		clock: {
			frame: cb => { frames.set(++id, cb); return id; },
			cancelFrame: i => frames.delete(i),
			later: (cb, ms) => { timers.set(++id, { cb, at: now + ms }); return id; },
			cancelLater: i => timers.delete(i),
		},
		// advance time by 16 ms steps up to `ms`, running what is due
		run(ms) {
			const end = now + ms;
			while (now < end) {
				now = Math.min(end, now + 16);
				for (const [i, t] of [...timers]) { if (t.at <= now) { timers.delete(i); t.cb(); } }
				for (const [i, cb] of [...frames]) { frames.delete(i); cb(now); }
			}
		},
		idle: () => frames.size === 0 && timers.size === 0,
	};
}

test('a wheel moves the focus at once, then settles on the nearest day by a glide', () => {
	const ax = month(1);
	const clk = fakeClock();
	const seen = [];
	const f = new m.DayFocus(1, () => ax, g => seen.push(g), clk.clock, () => false);
	assert.equal(f.g, 1);
	// scroll back 30 % of the page
	f.scrollBy(-0.3 * ax.room);
	clk.run(100);
	assert.ok(f.g < 1 && f.g > 0.65, `${f.g}`);
	clk.run(2000);
	assert.ok(clk.idle());
	assert.ok(ax.centers.some(c => Math.abs(c - f.g) < 1e-9), `rests on a day, g = ${f.g}`);
	assert.ok(Math.abs(f.g - 0.7) <= 0.5 / 24 + 1e-9);
	// never a step: how far one frame moves while settling is small
	let worst = 0;
	for (let k = 1; k < seen.length; k++) { worst = Math.max(worst, Math.abs(seen[k] - seen[k - 1])); }
	assert.ok(worst < 0.12, `${worst}`);
});

test('a drag follows the pointer and carries on a little when let go', () => {
	const ax = month(1);
	const clk = fakeClock();
	const f = new m.DayFocus(1, () => ax, () => { }, clk.clock, () => false);
	f.dragTo(0.5);
	clk.run(300);
	near(f.g, 0.5, 0.001);
	f.release(-0.0005);
	clk.run(2000);
	assert.ok(f.g < 0.5 && ax.centers.some(c => Math.abs(c - f.g) < 1e-9));
	assert.ok(clk.idle());
});

test('a click on a day glides there; with reduced motion every move is a jump', () => {
	const ax = month(1);
	const clk = fakeClock();
	const f = new m.DayFocus(1, () => ax, () => { }, clk.clock, () => false);
	f.goTo(ax.centers[10]);
	clk.run(60);
	assert.ok(f.g > ax.centers[10] && f.g < 1, 'on its way');
	clk.run(1000);
	assert.equal(f.g, ax.centers[10]);
	const still = fakeClock();
	const j = new m.DayFocus(1, () => ax, () => { }, still.clock, () => true);
	j.goTo(ax.centers[3]);
	still.run(32);
	assert.equal(j.g, ax.centers[3]);
	j.scrollBy(ax.room * 0.2);
	still.run(32);
	assert.ok(j.g > ax.centers[3]);
	still.run(500);
	assert.ok(ax.centers.some(c => c === j.g));
});

test('a glide takes 220 ms for the next day, longer for farther, 520 at most', () => {
	assert.equal(m.glideMs(1 / 24, 25), 220 + Math.round(300 / 8));
	assert.equal(m.glideMs(1, 25), 520);
	assert.equal(m.glideMs(0, 25), 220);
});

test('300 days of tasks are one smooth axis too, and compute fast', () => {
	const t0 = Date.now();
	for (let k = 0; k < 200; k++) {
		const a = m.dayAxis({ times: [at(1, 1)], now: NOW, view: 536, days: 365, focus: k / 200 });
		m.dayAxisLabels(a);
	}
	assert.ok(Date.now() - t0 < 1500);
});
