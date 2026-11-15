/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the time axis that gets finer towards now (patches/065-time-axis.patch), one
 *  module for every time chart in the Agents window: the Task graph (patches/430-tasks.patch)
 *  and the Projects page's Timeline (kanban design/task-graph/redesign/README.md §1 and §3,
 *  design/projects-page/timeline-v2/README.md).
 *
 *  Three zones, left to right: by day (from `start`, or the first day with something in it, at most
 *  `days` back, to the day before yesterday), by half day (yesterday and the day before), by hour
 *  (today, up to now). Today gets max(288, width / 3); the half-day zone min(width / 3, half of what
 *  is left); the day zone the rest. A zone with nothing in it shrinks to a 64 px strip and gives its
 *  room away. Things that happen in the same hour, half day or day (by zone) fall into one bucket:
 *  the pages draw a bucket as one mark.
 *
 *  timeAxis() → zones and the x of a time (timeX); bucketize() → the marks; timeAxisLabels() → the
 *  zone titles and ticks; renderTimeAxis() draws those as the 44 px head over a chart. Everything but
 *  renderTimeAxis is pure (times are epoch seconds, days are local days); no imports.
 *--------------------------------------------------------------------------------------------*/

export const HOUR = 3600;
export const DAY = 86400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0: by day, 1: by half day (the two days before today), 2: by hour (today). */
export type TimeZoneIndex = 0 | 1 | 2;

export interface ITimeZone {
	readonly start: number;
	readonly end: number;
	readonly x0: number;
	readonly x1: number;
	/** Something happened in it (else it is a strip, or empty). */
	readonly on: boolean;
}

export interface ITimeAxis {
	readonly width: number;
	readonly now: number;
	/** Local midnight today. */
	readonly today: number;
	/** Local midnight two days ago: where the half-day zone starts. */
	readonly recent: number;
	/** Where the day zone starts (a local midnight). */
	readonly start: number;
	readonly zones: readonly [ITimeZone, ITimeZone, ITimeZone];
}

export interface ITimeAxisOptions {
	/** When the things drawn happened (epoch seconds): a zone without any of them is a strip. */
	readonly times: readonly number[];
	readonly now: number;
	readonly width: number;
	/** Where the day zone starts (its local midnight); default: the first of `times`. */
	readonly start?: number;
	/** How far back at most, in days (default 30). */
	readonly days?: number;
	/** Today's least width (default 288). */
	readonly minToday?: number;
	/** The width of a zone with nothing in it (default 64). */
	readonly strip?: number;
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

export function timeAxis(o: ITimeAxisOptions): ITimeAxis {
	const now = o.now;
	const today = midnight(now);
	const recent = midnight(now, 2);
	const days = Math.max(3, o.days ?? 30);
	const strip = o.strip ?? 64;
	const w = Math.max(0, o.width);
	let first = o.start ?? now;
	let hasRecent = false;
	let hasToday = false;
	for (const t of o.times) {
		if (o.start === undefined) {
			first = Math.min(first, t);
		}
		hasToday = hasToday || t >= today;
		hasRecent = hasRecent || (t >= recent && t < today);
	}
	// the day zone starts on the first day with something in it (at most `days` back); with nothing
	// before the day before yesterday there is no day zone
	const start = Math.min(recent, Math.max(midnight(first), midnight(now, days - 1)));
	const hasDay = start < recent;

	let C = hasToday ? Math.max(o.minToday ?? 288, w / 3) : strip;
	let B = hasRecent ? Math.min(w / 3, (w - C) / 2) : strip;
	// a narrow page: every zone that has something keeps at least a strip
	C = Math.max(Math.min(C, w - B - (hasDay ? strip : 0)), Math.min(strip, w));
	B = Math.max(0, Math.min(B, w - C - (hasDay ? strip : 0)));
	let A = w - B - C;
	if (!hasDay) {
		// no day zone: its room goes to today, else to the half-day zone
		if (hasToday || !hasRecent) {
			C += A;
		} else {
			B += A;
		}
		A = 0;
	}
	return {
		width: w, now, today, recent, start,
		zones: [
			{ start, end: recent, x0: 0, x1: A, on: hasDay && o.times.some(t => t < recent) },
			{ start: recent, end: today, x0: A, x1: A + B, on: hasRecent },
			{ start: today, end: now, x0: A + B, x1: w, on: hasToday },
		],
	};
}

export function zoneOf(axis: ITimeAxis, t: number): TimeZoneIndex {
	return t < axis.recent ? 0 : t < axis.today ? 1 : 2;
}

/** Where `t` is on the axis, in px from its left edge (times outside are pinned to the ends). */
export function timeX(axis: ITimeAxis, t: number): number {
	const z = axis.zones[zoneOf(axis, t)];
	const span = z.end - z.start;
	let f = span > 0 ? (t - z.start) / span : 0;
	f = f < 0 ? 0 : f > 1 ? 1 : f;
	return z.x0 + f * (z.x1 - z.x0);
}

export interface ITimeBucket<T> {
	/** Zone and start: the same for everything in one hour, half day or day. */
	readonly key: string;
	readonly zone: TimeZoneIndex;
	readonly start: number;
	readonly end: number;
	/** The middle of the bucket (up to now), in px. */
	readonly x: number;
	readonly items: T[];
}

/** The bucket `t` falls in: its zone's unit (a local day, half day or hour) around it. */
export function bucketOf(axis: ITimeAxis, t: number): { key: string; zone: TimeZoneIndex; start: number; end: number; x: number } {
	const zone = zoneOf(axis, t);
	const z = axis.zones[zone];
	const tt = Math.min(Math.max(t, z.start), axis.now);
	const d = new Date(tt * 1000);
	let start: number;
	let end: number;
	if (zone === 0) {
		start = midnight(tt);
		end = midnight(start + DAY + 2 * HOUR);   // the next midnight, also over a daylight saving change
	} else if (zone === 1) {
		const morning = d.getHours() < 12;
		d.setHours(morning ? 0 : 12, 0, 0, 0);
		start = d.getTime() / 1000;
		if (morning) {
			d.setHours(12);
			end = d.getTime() / 1000;
		} else {
			end = midnight(start + 14 * HOUR);
		}
	} else {
		d.setMinutes(0, 0, 0);
		start = d.getTime() / 1000;
		end = start + HOUR;
	}
	end = Math.min(end, z.end);
	return { key: `${zone}:${start}`, zone, start, end, x: timeX(axis, (start + Math.min(end, axis.now)) / 2) };
}

/** Things (anything with an `at`) grouped into the axis's buckets, oldest first; each bucket's items oldest first. */
export function bucketize<T extends { readonly at: number }>(axis: ITimeAxis, items: readonly T[]): ITimeBucket<T>[] {
	const byKey = new Map<string, ITimeBucket<T>>();
	for (const it of items) {
		const b = bucketOf(axis, it.at);
		let bucket = byKey.get(b.key);
		if (!bucket) {
			bucket = { ...b, items: [] };
			byKey.set(b.key, bucket);
		}
		bucket.items.push(it);
	}
	const out = [...byKey.values()].sort((a, b) => a.start - b.start);
	for (const b of out) {
		b.items.sort((x, y) => x.at - y.at);
	}
	return out;
}

export function monthDay(t: number): string {
	const d = new Date(t * 1000);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function hourMinute(t: number): string {
	const d = new Date(t * 1000);
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A bucket in words: "Sep 12", "Sep 26, afternoon", "Today, 17:00 to 18:00", "Today, 20:00 to now". */
export function bucketWhen(axis: ITimeAxis, b: { zone: TimeZoneIndex; start: number; end: number }): string {
	if (b.zone === 0) {
		return monthDay(b.start);
	}
	if (b.zone === 1) {
		return `${monthDay(b.start)}, ${new Date(b.start * 1000).getHours() < 12 ? 'morning' : 'afternoon'}`;
	}
	const h = (t: number) => `${new Date(t * 1000).getHours()}:00`;
	return `Today, ${h(b.start)} to ${b.end >= axis.now ? 'now' : h(b.end)}`;
}

export interface ITimeAxisTick {
	readonly x: number;
	readonly label?: string;
	/** major: a labelled tick; minor: a short one; now: the end of the axis. `first` labels hang right of their tick. */
	readonly kind: 'major' | 'minor' | 'now';
	readonly first?: boolean;
}

export interface ITimeAxisLabels {
	/** A title over each zone that has room for one ("Sep 2 to 24 · by day"). */
	readonly titles: readonly { readonly x: number; readonly text: string }[];
	readonly ticks: readonly ITimeAxisTick[];
}

/** What to write along the axis: zone titles and ticks, labels only where they have room (px at 11 to 12 px text). */
export function timeAxisLabels(axis: ITimeAxis): ITimeAxisLabels {
	const [A, B, C] = axis.zones;
	const titles: { x: number; text: string }[] = [];
	const fits = (z: ITimeZone, text: string) => z.x1 - z.x0 >= text.length * 5.8 + 8;
	const add = (z: ITimeZone, text: string, short?: string) => {
		const t = fits(z, text) ? text : short && fits(z, short) ? short : '';
		if (t) {
			titles.push({ x: z.x0, text: t });
		}
	};
	const lastDay = (z: ITimeZone) => new Date((z.end - DAY / 2) * 1000);
	const span = (z: ITimeZone, word: string) => {
		const a = new Date(z.start * 1000), b = lastDay(z);
		return `${monthDay(z.start)} ${word} ${a.getMonth() === b.getMonth() ? b.getDate() : monthDay(b.getTime() / 1000)}`;
	};
	if (A.x1 - A.x0 > 0) {
		add(A, `${span(A, 'to')} · by day`, span(A, 'to'));
	}
	add(B, B.on ? `${span(B, 'and')} · by half day` : span(B, 'and'), span(B, 'and'));
	add(C, C.on ? 'Today · by hour' : 'Today', 'Today');

	const ticks: ITimeAxisTick[] = [];
	// the day zone: a tick a day, a date every n days so that labels stay 26 px apart
	if (A.x1 - A.x0 > 0) {
		const n = Math.max(1, Math.round((A.end - A.start) / DAY));
		const ppd = (A.x1 - A.x0) / n;
		const step = [1, 2, 3, 4, 5, 7].find(s => ppd * s >= 26) ?? 7;
		for (let k = 0; k < n; k++) {
			const t = midnight(A.start + k * DAY + 2 * HOUR);
			const label = k % step === 0 && (n - k) * ppd >= 18 ? String(new Date(t * 1000).getDate()) : undefined;
			ticks.push({ x: timeX(axis, t), label, kind: label ? 'major' : 'minor', first: k === 0 });
		}
	}
	// the half-day zone: its two days and their noons
	if (B.on) {
		for (let k = 0; k < 4; k++) {
			const t = B.start + k * DAY / 2;
			ticks.push({ x: timeX(axis, t), label: k % 2 ? 'noon' : String(new Date(t * 1000).getDate()), kind: 'major', first: A.x1 - A.x0 <= 0 && k === 0 });
		}
	} else {
		ticks.push({ x: B.x0, kind: 'minor' });
	}
	// today: an hour a tick, a label every n hours so that labels stay 40 px apart, none too close to Now
	if (C.on) {
		const hours = Math.max(1, Math.ceil((C.end - C.start) / HOUR));
		const pph = (C.x1 - C.x0) / ((C.end - C.start) / HOUR);
		const hs = [1, 2, 3, 4, 6].find(s => pph * s >= 40) ?? 6;
		for (let k = 0; k < hours; k++) {
			const t = C.start + k * HOUR;
			const x = timeX(axis, t);
			const label = k % hs === 0 && axis.width - x > 44 ? `${new Date(t * 1000).getHours()}:00` : undefined;
			ticks.push({ x, label, kind: label ? 'major' : 'minor' });
		}
	}
	ticks.push({ x: axis.width, label: 'Now', kind: 'now' });
	return { titles, ticks };
}

/**
 * The axis head over a chart `axis.width` wide: zone titles (12 px) on top, ticks with their labels
 * (11 px, tabular) under them, Now at the right end in the text colour. Appended to `parent`; 44 px
 * high, positioned relative, laid out in absolute px from the chart's left edge. Colours are the
 * theme's (description foreground, foreground).
 */
export function renderTimeAxis(parent: HTMLElement, axis: ITimeAxis, labels: ITimeAxisLabels = timeAxisLabels(axis)): HTMLElement {
	const doc = parent.ownerDocument;
	const el = (tag: string, css: string, text?: string) => {
		const e = doc.createElement(tag);
		e.style.cssText = css;
		if (text !== undefined) {
			e.textContent = text;
		}
		return e;
	};
	const muted = 'var(--vscode-descriptionForeground)';
	const head = el('div', `position:relative;height:44px;width:${axis.width}px`);
	head.className = 'dispatch-time-axis';
	for (const t of labels.titles) {
		const z = el('div', `position:absolute;top:0;left:${t.x}px;font-size:12px;line-height:16px;color:${muted};white-space:nowrap`, t.text);
		z.className = 'dispatch-time-axis-zone';
		head.appendChild(z);
	}
	for (const t of labels.ticks) {
		const tick = el('div', `position:absolute;top:20px;left:${t.x}px;width:0;height:24px`);
		tick.className = `dispatch-time-axis-tick ${t.kind}`;
		tick.appendChild(el('i', `position:absolute;left:0;bottom:0;width:1px;height:${t.kind === 'minor' ? 3 : 5}px;`
			+ `background:color-mix(in srgb, ${muted} ${t.kind === 'minor' ? 30 : 45}%, transparent)`));
		if (t.label) {
			const shift = t.kind === 'now' ? 'translateX(-100%)' : t.first ? 'none' : 'translateX(-50%)';
			tick.appendChild(el('b', `position:absolute;left:0;top:0;transform:${shift};font-size:11px;line-height:14px;white-space:nowrap;`
				+ `font-variant-numeric:tabular-nums;font-weight:${t.kind === 'now' ? 500 : 400};color:${t.kind === 'now' ? 'var(--vscode-foreground)' : muted}`, t.label));
		}
		head.appendChild(tick);
	}
	parent.appendChild(head);
	return head;
}
