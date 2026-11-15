/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Task graph's time axis, one day after another (task-e1qsa, preference
 *  「任务图左右滑动」). It replaced the three fixed zones (by day / by half day / today by hour) on this
 *  page, which squeezed four weeks into a strip at one end.
 *
 *  Every day from the first one with a task (at most `days` back) to today is a slot, side by side with
 *  no gap. A day is folded (`dayW` wide, its tasks one mark) or open (`openW`, by hour). What is open is
 *  one number, the focus `g`, 0 (the first day) to 1 (today): the day under it is open, and between two
 *  days one closes while the next opens, `e` and `1 - e` along a smoothstep, so the page is a continuous
 *  function of `g` and sliding it shows no step anywhere. Every slot is lerp(dayW, openW, e) wide and
 *  everything in it lerps between its place in the folded day and its place in the open one. The page is
 *  scrolled to `g * room`, so the open day is always whole inside the viewport, the first at the left
 *  edge, today at the right. Today ends at now; open, it is at least a quarter of a day wide. With
 *  today open the slots fill the viewport when they can; with another day open they are wider than it.
 *
 *  Pure, no imports (ide/tests/day-axis.test.mjs loads it straight into Node).
 *--------------------------------------------------------------------------------------------*/

export const HOUR = 3600;
export const DAY = 86400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A folded day is never narrower than this. */
export const MIN_DAY_W = 32;
/** An open day is at least this wide (16 px an hour) and at most the viewport. */
export const MIN_OPEN_W = 384;
/** A day's one mark has given way to its hours once the day is this open (0 to 1); on the way the two cross-fade. */
export const FADE_E = 0.4;

export interface IDaySlot {
	/** Local midnight. */
	readonly start: number;
	/** The next local midnight; now for today. */
	readonly end: number;
	readonly x0: number;
	readonly x1: number;
	/** How open, 0 (one mark) to 1 (by hour). */
	readonly e: number;
	readonly foldedW: number;
	readonly openW: number;
	readonly today: boolean;
}

export interface IDayAxis {
	/** The whole axis, every slot (px). */
	readonly width: number;
	/** The viewport it scrolls in (px). */
	readonly view: number;
	readonly now: number;
	readonly today: number;
	readonly start: number;
	readonly days: readonly IDaySlot[];
	/** The focus, 0 to 1. */
	readonly g: number;
	/** How far the page is scrolled for it (px), 0 to `room`. */
	readonly pan: number;
	/** How far it can scroll at this focus: width less the viewport. */
	readonly room: number;
	/** The focus that opens each day whole (the days' centres), 0 to 1. */
	readonly centers: readonly number[];
}

export interface IDayAxisOptions {
	/** When the things drawn happened (epoch seconds): the axis starts on the first one's day. */
	readonly times: readonly number[];
	readonly now: number;
	/** The viewport's width (px). */
	readonly view: number;
	/** At most this many days back (default 30). */
	readonly days?: number;
	/** The focus, 0 (the first day open) to 1 (today open, the default). */
	readonly focus?: number;
}

/** Local midnight of the day of `t`, `back` days earlier. */
export function midnight(t: number, back = 0): number {
	const d = new Date(t * 1000);
	d.setHours(0, 0, 0, 0);
	if (back) {
		d.setDate(d.getDate() - back);
	}
	return d.getTime() / 1000;
}

/** The local midnight after `t`'s day (also over a daylight saving change). */
export function nextMidnight(t: number): number {
	return midnight(midnight(t) + DAY + 2 * HOUR);
}

export const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
export const clamp01 = (e: number) => e < 0 ? 0 : e > 1 ? 1 : e;
/** 0 to 1 and back to rest at both ends; smooth(t) + smooth(1 - t) = 1, so two days trading places keep their sum. */
export const smooth = (t: number) => {
	const x = clamp01(t);
	return x * x * (3 - 2 * x);
};

/** How open each day is for the focus `g`: the one it is on, or two next to each other sharing it. */
export function openness(centers: readonly number[], g: number): number[] {
	const n = centers.length;
	const es = new Array<number>(n).fill(0);
	if (n <= 1 || g >= centers[n - 1]) {
		es[n - 1] = 1;
	} else if (g <= centers[0]) {
		es[0] = 1;
	} else {
		let j = 0;
		while (j < n - 2 && g >= centers[j + 1]) {
			j++;
		}
		const s = smooth((g - centers[j]) / (centers[j + 1] - centers[j]));
		es[j] = 1 - s;
		es[j + 1] = s;
	}
	return es;
}

export function dayAxis(o: IDayAxisOptions): IDayAxis {
	const now = o.now;
	const today = midnight(now);
	const view = Math.max(0, o.view);
	const back = Math.max(1, o.days ?? 30);
	let first = now;
	for (const t of o.times) {
		first = Math.min(first, t);
	}
	const start = Math.max(midnight(first), midnight(now, back - 1));
	const starts: number[] = [];
	for (let d = start; d <= today; d = nextMidnight(d)) {
		starts.push(d);
	}
	const n = starts.length;
	// an open day: 60 % of the viewport, at least 384, at most all of it; today up to now, at least a quarter
	const openW = Math.min(view, Math.max(MIN_OPEN_W, Math.round(view * 0.6)));
	const frac = Math.max(0.25, Math.min(1, (now - today) / DAY));
	let todayOpen = openW * frac;
	// folded days share what today open leaves of the viewport, between 32 and a third of an open day
	let dayW = n > 1 ? Math.min(openW / 3, Math.max(MIN_DAY_W, (view - todayOpen) / (n - 1))) : view;
	let fullW = openW;
	todayOpen = Math.max(todayOpen, Math.min(openW, 1.5 * dayW));
	// fewer days than the viewport holds: everything wider by the same factor, so they fill it
	const rest = (n - 1) * dayW + todayOpen;
	if (n > 1 && rest < view) {
		const k = view / rest;
		dayW *= k;
		fullW *= k;
		todayOpen *= k;
	}
	const g = clamp01(o.focus ?? 1);
	const centers = starts.map((_, i) => n > 1 ? i / (n - 1) : 1);
	const es = openness(centers, g);
	const days: IDaySlot[] = [];
	let x = 0;
	starts.forEach((s, i) => {
		const isToday = i === n - 1;
		const e = es[i];
		const foldedW = n === 1 ? view : dayW;
		const open = n === 1 ? view : isToday ? todayOpen : fullW;
		const w = lerp(foldedW, open, e);
		days.push({ start: s, end: isToday ? now : nextMidnight(s), x0: x, x1: x + w, e, foldedW, openW: open, today: isToday });
		x += w;
	});
	const room = Math.max(0, x - view);
	return { width: x, view, now, today, start, days, g, pan: g * room, room, centers };
}

/** The slot of `t` (times before the first day are on it, after now on today). */
export function dayIndexOf(axis: IDayAxis, t: number): number {
	const ds = axis.days;
	let lo = 0;
	let hi = ds.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ds[mid].start <= t) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

/** The day that is open most (the focus's day). */
export function focusDay(axis: IDayAxis): IDaySlot {
	let best = axis.days[0];
	for (const d of axis.days) {
		if (d.e > best.e) {
			best = d;
		}
	}
	return best;
}

/** Where `t` is in its slot (px from the axis's left edge): the folded day's middle when the day is shut, its
 *  place by the clock across the open day when open, and in between in proportion. */
export function slotX(d: IDaySlot, t: number): number {
	const span = d.end - d.start;
	const f = span > 0 ? clamp01((t - d.start) / span) : 0.5;
	return d.x0 + lerp(d.foldedW / 2, f * d.openW, d.e);
}

/** Where `t` is, in px from the axis's left edge. */
export function dayX(axis: IDayAxis, t: number): number {
	return slotX(axis.days[dayIndexOf(axis, t)], t);
}

export interface IDayBucket<T> {
	/** The same for everything in one folded day, or one hour of an open one. */
	readonly key: string;
	/** Its day's slot. */
	readonly day: number;
	/** By hour (its day is open or opening); else the whole day. */
	readonly hourly: boolean;
	readonly start: number;
	readonly end: number;
	/** Its middle: the folded day's middle, the hour's middle in the open day, by how open the day is. */
	readonly x: number;
	/** How visible (0 to 1): a day opening cross-fades its one mark into its hours, so no mark pops in or out. */
	readonly fade: number;
	readonly items: T[];
}

/** How far a day's tasks have gone from one mark to one a hour, 0 to 1, for a day `e` open. */
export function hourly(e: number): number {
	return smooth(e / FADE_E);
}

/** The hour of `t` in its day's slot: from its start to the next full hour (to now at most). */
export function hourOf(axis: IDayAxis, d: IDaySlot, t: number): { readonly start: number; readonly end: number } {
	const tt = Math.min(Math.max(t, d.start), axis.now);
	const h = new Date(tt * 1000);
	h.setMinutes(0, 0, 0);
	const start = Math.max(d.start, h.getTime() / 1000);
	return { start, end: Math.min(start + HOUR, d.end) };
}

/** The buckets `t` falls in: its folded day (while the day is shut or just opening) and its hour (once it opens). */
export function dayBucketsOf(axis: IDayAxis, t: number): Omit<IDayBucket<never>, 'items'>[] {
	const day = dayIndexOf(axis, t);
	const d = axis.days[day];
	const k = hourly(d.e);
	const out: Omit<IDayBucket<never>, 'items'>[] = [];
	if (k < 1) {
		out.push({ key: `d:${d.start}`, day, hourly: false, start: d.start, end: d.end, x: (d.x0 + d.x1) / 2, fade: 1 - k });
	}
	if (k > 0) {
		const { start, end } = hourOf(axis, d, t);
		out.push({ key: `h:${start}`, day, hourly: true, start, end, x: slotX(d, (start + Math.min(end, axis.now)) / 2), fade: k });
	}
	return out;
}

/** The one of those buckets that shows more (an item that is in one place, as a link or a hover has it). */
export function primaryBucketOf(axis: IDayAxis, t: number): Omit<IDayBucket<never>, 'items'> {
	const bs = dayBucketsOf(axis, t);
	return bs.find(b => b.fade >= 0.5) ?? bs[bs.length - 1];
}

/** Things (anything with an `at`) in the axis's buckets, oldest first; each bucket's items oldest first. */
export function dayBuckets<T extends { readonly at: number }>(axis: IDayAxis, items: readonly T[]): IDayBucket<T>[] {
	const byKey = new Map<string, IDayBucket<T>>();
	for (const it of items) {
		for (const b of dayBucketsOf(axis, it.at)) {
			let bucket = byKey.get(b.key);
			if (!bucket) {
				bucket = { ...b, items: [] };
				byKey.set(b.key, bucket);
			}
			bucket.items.push(it);
		}
	}
	const out = [...byKey.values()].sort((a, b) => a.start - b.start || +a.hourly - +b.hourly);
	for (const b of out) {
		b.items.sort((x, y) => x.at - y.at);
	}
	return out;
}

/** Marks side by side `step` px apart round a middle: the offset of the i-th of `len`. */
export function spread(i: number, len: number, step: number): number {
	return (i - (len - 1) / 2) * step;
}

export function monthDay(t: number): string {
	const d = new Date(t * 1000);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function hourMinute(t: number): string {
	const d = new Date(t * 1000);
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A bucket in words: "Sep 12", "Oct 9, 14:00 to 15:00", "Today, 20:00 to now". */
export function bucketWords(axis: IDayAxis, b: { hourly: boolean; start: number; end: number }): string {
	const isToday = b.start >= axis.today;
	if (!b.hourly) {
		return isToday ? 'Today' : monthDay(b.start);
	}
	const h = (t: number) => `${new Date(t * 1000).getHours()}:00`;
	return `${isToday ? 'Today' : monthDay(b.start)}, ${h(b.start)} to ${b.end >= axis.now ? 'now' : h(b.end)}`;
}

export interface IDayTick {
	/** The same tick in every frame, so the page moves the element instead of drawing it again. */
	readonly key: string;
	readonly x: number;
	readonly label?: string;
	/** day: a folded day's number under its middle; hour: an open day's hour; edge: where a day starts; now. */
	readonly kind: 'day' | 'hour' | 'edge' | 'now';
	/** How visible (0 to 1): a day's number fades as it opens, its hours fade in. */
	readonly alpha: number;
	/** The day this tick belongs to (its local midnight): a click on it opens that day. */
	readonly day?: number;
}

export interface IDayTitle {
	readonly key: string;
	readonly x: number;
	readonly text: string;
	readonly alpha: number;
}

export interface IDayAxisLabels {
	/** Over the ticks: a month's name where it starts, the open day's own title. */
	readonly titles: readonly IDayTitle[];
	readonly ticks: readonly IDayTick[];
}

/** What to write along the axis. Labels only where they have room; what comes and goes with a day opening fades. */
export function dayAxisLabels(axis: IDayAxis): IDayAxisLabels {
	const titles: IDayTitle[] = [];
	const ticks: IDayTick[] = [];
	const ds = axis.days;
	const dayW = ds.length ? ds[0].foldedW : 0;
	// a folded day's number every `step` days, 26 px apart
	const step = [1, 2, 3, 5, 7].find(s => dayW * s >= 26) ?? 7;
	let lastMonth = -1;
	let titleEnd = -Infinity;
	ds.forEach((d, i) => {
		const date = new Date(d.start * 1000);
		if (i > 0) {
			ticks.push({ key: `e:${d.start}`, x: d.x0, kind: 'edge', alpha: 1, day: d.start });
		}
		// the month over its first day on the axis (and the first day's), unless the open day's title is there
		if (date.getMonth() !== lastMonth) {
			lastMonth = date.getMonth();
			if (d.x0 >= titleEnd && d.e < 0.5) {
				titles.push({ key: `m:${d.start}`, x: d.x0, text: MONTHS[date.getMonth()], alpha: 1 - d.e });
				titleEnd = d.x0 + 36;
			}
		}
		const mid = (d.x0 + d.x1) / 2;
		const nearNow = axis.width - mid < 28;
		if (i % step === 0 && !nearNow && d.e < 1) {
			ticks.push({ key: `d:${d.start}`, label: String(date.getDate()), x: mid, kind: 'day', alpha: 1 - d.e, day: d.start });
		}
		if (d.e > 0) {
			titles.push({ key: `t:${d.start}`, x: d.x0, text: d.today ? 'Today · by hour' : `${monthDay(d.start)} · by hour`, alpha: d.e });
			titleEnd = Math.max(titleEnd, d.x0 + 120);
			// its hours: a tick each, a label every n hours so that labels stay 40 px apart (judged on the open day, so
			// the same ones are labelled all the way through the opening)
			const hours = Math.max(1, Math.ceil((d.end - d.start) / HOUR));
			const pph = d.openW / ((d.end - d.start) / HOUR);
			const hs = [1, 2, 3, 4, 6, 12].find(s => pph * s >= 40) ?? 12;
			for (let k = 1; k < hours; k++) {
				const t = d.start + k * HOUR;
				const x = slotX(d, t);
				const label = k % hs === 0 && axis.width - x > 44 && d.x1 - x > 12 ? `${new Date(t * 1000).getHours()}:00` : undefined;
				ticks.push({ key: `h:${t}`, x, label, kind: 'hour', alpha: d.e, day: d.start });
			}
		}
	});
	ticks.push({ key: 'now', x: axis.width, label: 'Now', kind: 'now', alpha: 1 });
	return { titles, ticks };
}

/** DESIGN.md's --ease-std, cubic-bezier(0.32, 0.72, 0, 1), as a function of progress 0 to 1. */
export function easeStd(p: number): number {
	if (p <= 0) {
		return 0;
	}
	if (p >= 1) {
		return 1;
	}
	const [x1, y1, x2, y2] = [0.32, 0.72, 0, 1];
	const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
	const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
	// x(t) = p by bisection (monotonic for these control points)
	let lo = 0;
	let hi = 1;
	for (let k = 0; k < 30; k++) {
		const mid = (lo + hi) / 2;
		if (bx(mid) < p) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return by((lo + hi) / 2);
}

/** The focus that opens a whole day, the nearest to `g`. */
export function nearestCenter(centers: readonly number[], g: number): number {
	let best = centers.length ? centers[0] : 1;
	for (const c of centers) {
		if (Math.abs(c - g) < Math.abs(best - g)) {
			best = c;
		}
	}
	return best;
}

/** One frame of following a target: closes the gap by 1 - e^(-dt / tau), so the same distance takes the same time
 *  at any frame rate; the last sliver is closed at once. */
export function follow(g: number, target: number, dtMs: number, tauMs: number): number {
	const d = target - g;
	if (Math.abs(d) < 1e-4) {
		return target;
	}
	return g + d * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
}

/** How long (ms) a glide over `dg` of the focus takes (a day is 1 / (days - 1)): 220 ms for the nearest, up to 520. */
export function glideMs(dg: number, days: number): number {
	const inDays = Math.abs(dg) * Math.max(1, days - 1);
	return Math.round(220 + Math.min(1, inDays / 8) * 300);
}

/** What the focus runs on: the page's frames and timers (the window's, or a fake one in a test). */
export interface IFocusClock {
	frame(cb: (ms: number) => void): number;
	cancelFrame(id: number): void;
	later(cb: () => void, ms: number): number;
	cancelLater(id: number): void;
}

/** The pause after the last wheel event before the page settles on a day. */
export const SETTLE_MS = 140;
/** How closely the focus follows a drag or a wheel (the gap closes by 63 % in this long). */
const FOLLOW_MS = 45;

/**
 * The focus as the person moves it. A wheel or a drag moves it at once, followed frame by frame; when the input
 * stops it glides to the nearest day (DESIGN.md's --ease-std), so the page never rests between two days; a click
 * on a day glides there. With reduced motion every move is a jump. One frame loop, only while something moves.
 */
export class DayFocus {
	private shown: number;
	private target: number;
	private glide: { from: number; to: number; t0: number; ms: number } | undefined;
	private frame = 0;
	private last = 0;
	private settle = 0;
	private fresh = false;

	private readonly world: () => { readonly room: number; readonly centers: readonly number[] };
	private readonly paint: (g: number) => void;
	private readonly clock: IFocusClock;
	private readonly reduced: () => boolean;

	constructor(g: number, world: () => { readonly room: number; readonly centers: readonly number[] }, paint: (g: number) => void, clock: IFocusClock, reduced: () => boolean) {
		this.shown = this.target = clamp01(g);
		this.world = world;
		this.paint = paint;
		this.clock = clock;
		this.reduced = reduced;
	}

	get g(): number {
		return this.shown;
	}

	/** A wheel: `dpx` of page, positive towards today. Settles on a day SETTLE_MS after the last one. */
	scrollBy(dpx: number): void {
		this.glide = undefined;
		this.target = clamp01(this.target + dpx / Math.max(this.world().room, 240));
		this.run();
		this.clock.cancelLater(this.settle);
		this.settle = this.clock.later(() => this.settleOn(this.target), SETTLE_MS);
	}

	/** A drag: the focus is `g` now (no settling until `release`). */
	dragTo(g: number): void {
		this.glide = undefined;
		this.clock.cancelLater(this.settle);
		this.target = clamp01(g);
		this.run();
	}

	/** The drag lets go moving `v` of the focus per ms: it carries a little on, then settles on a day. */
	release(v = 0): void {
		this.settleOn(clamp01(this.target + v * 150));
	}

	/** A click on a day (or the arrow keys): glide to it. */
	goTo(g: number): void {
		this.clock.cancelLater(this.settle);
		this.settleOn(clamp01(g), clamp01(g));
	}

	private settleOn(near: number, exact?: number): void {
		const to = exact ?? nearestCenter(this.world().centers, near);
		this.target = to;
		if (this.reduced() || Math.abs(to - this.shown) < 1e-4) {
			this.shown = to;
			this.glide = undefined;
			this.run();
			return;
		}
		this.glide = { from: this.shown, to, t0: -1, ms: glideMs(to - this.shown, this.world().centers.length) };
		this.run();
	}

	private run(): void {
		if (!this.frame) {
			this.fresh = true;
			this.frame = this.clock.frame(t => this.tick(t));
		}
	}

	private tick(t: number): void {
		this.frame = 0;
		const dt = this.fresh ? 16 : Math.min(50, t - this.last);
		this.fresh = false;
		this.last = t;
		let more = false;
		if (this.glide) {
			const gl = this.glide;
			if (gl.t0 < 0) {
				gl.t0 = t;
			}
			const p = Math.min(1, (t - gl.t0) / gl.ms);
			this.shown = lerp(gl.from, gl.to, easeStd(p));
			if (p >= 1) {
				this.glide = undefined;
				this.shown = gl.to;
			} else {
				more = true;
			}
		} else if (this.reduced()) {
			this.shown = this.target;
		} else {
			this.shown = follow(this.shown, this.target, dt, FOLLOW_MS);
			more = this.shown !== this.target;
		}
		this.paint(this.shown);
		if (more) {
			this.frame = this.clock.frame(t2 => this.tick(t2));
		}
	}

	dispose(): void {
		this.clock.cancelFrame(this.frame);
		this.clock.cancelLater(this.settle);
		this.frame = 0;
		this.glide = undefined;
	}
}
