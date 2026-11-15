/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the time axis that gets finer towards now (patches/065-time-axis.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bucketize, bucketWhen, HOUR, midnight, timeAxis, timeAxisLabels, timeX, zoneOf } from '../../browser/dispatchTimeAxis.js';

// Sunday Sep 27 2026, 20:42 local time
const NOW = new Date(2026, 8, 27, 20, 42).getTime() / 1000;
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime() / 1000;

suite('Dispatch time axis', () => {

	test('three zones: today at least 288 px, the two days before by half day, the rest by day', () => {
		const axis = timeAxis({ times: [at(9, 2), at(9, 26, 9), NOW - HOUR], now: NOW, width: 656 });
		const [A, B, C] = axis.zones;
		assert.strictEqual(A.start, midnight(at(9, 2)));
		assert.strictEqual(A.end, midnight(NOW, 2));
		assert.strictEqual(C.x1 - C.x0, 288);
		assert.strictEqual(B.x1 - B.x0, Math.min(656 / 3, (656 - 288) / 2));
		assert.strictEqual(A.x1 - A.x0, 656 - 288 - 184);
		assert.ok(A.on && B.on && C.on);
		assert.strictEqual(timeX(axis, NOW), 656);
		assert.strictEqual(timeX(axis, 0), 0);
		assert.strictEqual(zoneOf(axis, at(9, 25, 23)), 1);
	});

	test('a zone with nothing in it is a 64 px strip; with nothing before the day before yesterday there is no day zone', () => {
		const quietToday = timeAxis({ times: [at(9, 7), at(9, 26, 15)], now: NOW, width: 656 });
		assert.strictEqual(quietToday.zones[2].x1 - quietToday.zones[2].x0, 64);
		assert.ok(!quietToday.zones[2].on);
		const recentOnly = timeAxis({ times: [at(9, 26, 10), NOW - 60], now: NOW, width: 656 });
		assert.strictEqual(recentOnly.zones[0].x1, 0);
		assert.strictEqual(recentOnly.zones[1].x1 - recentOnly.zones[1].x0 + recentOnly.zones[2].x1 - recentOnly.zones[2].x0, 656);
	});

	test('at most 30 days back', () => {
		const axis = timeAxis({ times: [at(7, 1), NOW - HOUR], now: NOW, width: 656 });
		assert.strictEqual(axis.start, midnight(NOW, 29));
		assert.strictEqual(timeX(axis, at(7, 1)), 0);
	});

	test('buckets: a day, a half day, an hour', () => {
		const axis = timeAxis({ times: [at(9, 10), NOW], now: NOW, width: 656 });
		const items = [
			{ at: at(9, 10, 9) }, { at: at(9, 10, 22) },              // one day
			{ at: at(9, 26, 9) }, { at: at(9, 26, 11, 59) },          // Sep 26 morning
			{ at: at(9, 26, 12) },                                    // Sep 26 afternoon
			{ at: at(9, 27, 17, 5) }, { at: at(9, 27, 17, 55) },     // today 17:00
			{ at: at(9, 27, 18, 1) },
		];
		const bs = bucketize(axis, items);
		assert.deepStrictEqual(bs.map(b => b.items.length), [2, 2, 1, 2, 1]);
		assert.deepStrictEqual(bs.map(b => bucketWhen(axis, b)), ['Sep 10', 'Sep 26, morning', 'Sep 26, afternoon', 'Today, 17:00 to 18:00', 'Today, 18:00 to 19:00']);
		assert.ok(bs.every((b, i) => i === 0 || b.x > bs[i - 1].x));
		const last = bucketize(axis, [{ at: NOW - 60 }])[0];
		assert.strictEqual(bucketWhen(axis, last), 'Today, 20:00 to now');
	});

	test('labels: zone titles and ticks with room', () => {
		const axis = timeAxis({ times: [at(9, 2), at(9, 26, 9), NOW - HOUR], now: NOW, width: 656 });
		const labels = timeAxisLabels(axis);
		assert.deepStrictEqual(labels.titles.map(t => t.text), ['Sep 2 to 24 · by day', 'Sep 25 and 26 · by half day', 'Today · by hour']);
		const majors = labels.ticks.filter(t => t.label).map(t => t.label);
		assert.strictEqual(majors[0], '2');
		assert.ok(majors.includes('noon') && majors.includes('0:00') && majors[majors.length - 1] === 'Now');
		const xs = labels.ticks.filter(t => t.label && t.kind === 'major').map(t => t.x);
		assert.ok(xs.every((x, i) => i === 0 || x - xs[i - 1] >= 18), 'labels do not sit on each other');
	});

	test('a fixed start: the day zone from there, on only when something happened in it', () => {
		const axis = timeAxis({ times: [NOW - HOUR], now: NOW, width: 656, start: at(9, 14), days: 14 });
		assert.strictEqual(axis.start, midnight(at(9, 14)));
		assert.ok(axis.zones[0].x1 > 0 && !axis.zones[0].on);
		assert.strictEqual(timeX(axis, at(9, 14, 0, 0)), 0);
	});
});
