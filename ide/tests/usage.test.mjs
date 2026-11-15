import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Usage page's arithmetic (kanban task-it54z): the allowance's ten blocks, the weekly line with its unread gaps,
// the 5-hour windows, the year's colours.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const M = await import(pathToFileURL(path.join(vs, 'sessions/contrib/accountMenu/browser/dispatchUsageModel.ts')));

test('ten blocks: full, half or empty; amber over 80%, coral at the limit', () => {
	assert.deepEqual(M.meterCells(45), ['on', 'on', 'on', 'on', 'half', '', '', '', '', '']);
	assert.deepEqual(M.meterCells(100).filter(c => c === 'on').length, 10);
	assert.deepEqual([M.meterLevel(79), M.meterLevel(80), M.meterLevel(99)], ['', 'warn', 'hit']);
});

test('numbers as people read them', () => {
	assert.equal(M.usd(15990.24), '$15,990');
	assert.equal(M.usd(3.333), '$3.33');
	assert.equal(M.usd(0.004), '<$0.01');
	assert.equal(M.usd(0), '$0');
	assert.equal(M.tokens(41_979_292_055), '42B');
	assert.equal(M.tokens(5_618_919), '5.6M');
	assert.equal(M.rate(0, 10), '0%');
	assert.equal(M.rate(1, 300), '0.3%');
	assert.equal(M.rate(96, 574), '17%');
	assert.equal(M.rateLevel(96, 574), 'err');
	assert.equal(M.rateLevel(41, 589), 'warn');
	assert.equal(M.agoDay('2026-10-08', '2026-10-09'), 'yesterday');
	assert.equal(M.agoDay('2026-09-02', '2026-10-09'), 'Sep 2');
});

test('5-hour windows: a new one where the value drops or five hours have passed', () => {
	const h = 3600;
	const w = M.windows5h([[0, 2], [h, 30], [2 * h, 100], [3 * h, 5], [9 * h, 7]]);
	assert.deepEqual(w.map(x => [x.start / h, x.peak]), [[0, 100], [3, 5], [9, 7]]);
});

test('the weekly line: solid while read, dashed through a gap, down to 0 at a reset in it', () => {
	const h = 3600, day = 86400;
	const x = t => t / h, y = v => 100 - v;
	const anchor = 3 * day; // a reset every seven days from day 3
	const pts = [[0, 10], [h, 12], [2 * day, 60], [4 * day, 5]];
	const { solid, dashed } = M.weeklyPaths(pts, 5 * day, anchor, false, x, y);
	assert.match(solid, /^M0\.0,90\.0H1\.0V88\.0M48\.0,40\.0M96\.0,95\.0$/);
	// from the reading before the gap: hold, drop to 0 at day 3, up to the next reading; after the last one, hold to the end
	assert.ok(dashed.includes('M1.0,88.0H48.0V40.0'), dashed);
	assert.ok(dashed.includes('M48.0,40.0H72.0V100.0H96.0V95.0'), dashed);
	assert.ok(dashed.endsWith('M96.0,95.0H120.0'), dashed);
	// a live reading: nothing after it
	assert.ok(!M.weeklyPaths(pts, 5 * day, anchor, true, x, y).dashed.endsWith('H120.0'));
});

test('what the chart says under the pointer', () => {
	const day = 86400;
	const pts = [[0, 10], [2 * day, 60]];
	assert.deepEqual(M.readingAt(pts, [[0, 33]], 3 * day, 600), { kind: 'read', weekly: 10, session: 33 });
	assert.deepEqual(M.readingAt(pts, [], 3 * day, 4 * day), { kind: 'reset', at: 3 * day });
	assert.deepEqual(M.readingAt(pts, [], null, 4 * day), { kind: 'held', at: 2 * day, weekly: 60 });
	assert.deepEqual(M.readingAt(pts, [], null, -5), { kind: 'none' });
});

test('the year: the day takes the engine that ran most sessions, deeper with more', () => {
	assert.equal(M.topEngine({ codex: 3, 'claude-code': 5 }), 'claude-code');
	assert.equal(M.topEngine({ codex: 2, 'claude-code': 2 }), 'claude-code');
	assert.ok(M.heatStrength(1) < M.heatStrength(5) && M.heatStrength(5) < M.heatStrength(40));
});
