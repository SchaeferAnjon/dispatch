// Walk me through (direction B frame 6, user 2026-11-15, task-fktjx, kanban design/learn-scene): a turn's changes
// as stops (a new file one, each block of an edited file one), the blocks of one file put together when there are too
// many, at most 8 with "and N more in Changes", what each stop says and where it came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const M = await import(pathToFileURL(path.join(vs, 'sessions/contrib/dispatchLearn/common/dispatchWalkModel.ts')));

const h = (start, end, added = end - start + 1, removed = 0) => ({ start, end, added, removed, ostart: start, oend: start + removed - 1 });
const edit = (rel, ...hunks) => ({ path: `/p/${rel}`, rel, isNew: false, lines: 100, hunks });
const made = (rel, lines) => ({ path: `/p/${rel}`, rel, isNew: true, lines, hunks: [] });

test('a new file is one stop over all its lines; each block of an edited file is one, in line order', () => {
	const { stops, more } = M.walkStops([made('learn/reminder.ts', 2), edit('learn/app.ts', h(9, 9), h(3, 4))]);
	assert.equal(more, 0);
	assert.deepEqual(stops.map(s => [s.name, s.isNew, s.start, s.end]), [['reminder.ts', true, 1, 2], ['app.ts', false, 3, 4], ['app.ts', false, 9, 9]]);
	assert.equal(M.stopTag(stops[0]), 'New file');
	assert.equal(M.stopTag(stops[1]), '2 lines added');
	assert.equal(M.stopLines(stops[0]), 'lines 1–2');
	assert.equal(M.stopLines(stops[2]), 'line 9');
	assert.equal(M.stopsLabel(stops.length), '3 stops');
	assert.equal(M.stopsLabel(1), '1 stop');
});

test('too many stops: the file with the most blocks is put together first, then the next', () => {
	const files = [edit('a.ts', h(1, 1), h(5, 5), h(9, 9), h(20, 22)), edit('b.ts', h(2, 2), h(8, 8), h(30, 31)), made('c.ts', 4), edit('d.ts', h(7, 7))];
	// 4 + 3 + 1 + 1 = 9 stops: a.ts (4 blocks) becomes one, 6 left
	let r = M.walkStops(files);
	assert.equal(r.stops.length, 6);
	assert.deepEqual(r.stops.filter(s => s.rel === 'a.ts').map(s => [s.start, s.end, s.hunks.length]), [[1, 22, 4]]);
	assert.equal(M.stopTag(r.stops[0]), '4 changes');
	assert.equal(r.stops.filter(s => s.rel === 'b.ts').length, 3);
	// at most 4: b.ts goes together too
	r = M.walkStops(files, 4);
	assert.deepEqual(r.stops.map(s => [s.rel, s.hunks.length]), [['a.ts', 4], ['b.ts', 3], ['c.ts', 0], ['d.ts', 1]]);
	assert.equal(r.more, 0);
});

test('more files than stops: the first 8 are walked, "and N more in Changes" counts the rest and the deleted ones', () => {
	const files = Array.from({ length: 11 }, (_, i) => edit(`f${i}.ts`, h(1, 1), h(4, 4)));
	files.push({ path: '/p/old.txt', rel: 'old.txt', isNew: false, deleted: true, lines: 0, hunks: [] });
	const r = M.walkStops(files);
	assert.equal(r.stops.length, 8);
	assert.deepEqual(r.stops.map(s => s.rel), ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts']);
	assert.ok(r.stops.every(s => s.hunks.length === 2));
	assert.equal(r.more, 4);
	// a file the diff found nothing in (the same lines again) is no stop
	assert.deepEqual(M.walkStops([edit('same.ts')]), { stops: [], more: 0 });
});

test('a block from the diff computer: lines now, and a block that only removed lines points at the line before it', () => {
	assert.deepEqual(M.hunkOf(3, 6, 3, 4, 20), { start: 3, end: 5, added: 3, removed: 1, ostart: 3, oend: 3 });
	assert.deepEqual(M.hunkOf(8, 8, 8, 10, 20), { start: 7, end: 7, added: 0, removed: 2, ostart: 8, oend: 9 });
	assert.deepEqual(M.hunkOf(1, 1, 1, 3, 20), { start: 1, end: 1, added: 0, removed: 2, ostart: 1, oend: 2 });
	assert.equal(M.stopTag({ isNew: false, added: 0, removed: 2, hunks: [{}] }), '2 lines removed');
	assert.equal(M.stopTag({ isNew: false, added: 1, removed: 1, hunks: [{}] }), '1 line changed');
});

test('the agent\'s own sentences: one each when there are as many as stops, one file stop takes the first, else none', () => {
	assert.deepEqual(M.assignSaid(2, ['Adds the switch.', 'Hooks it up.']), ['Adds the switch.', 'Hooks it up.']);
	assert.deepEqual(M.assignSaid(1, ['Adds the switch.', 'Hooks it up.']), ['Adds the switch.']);
	assert.deepEqual(M.assignSaid(3, ['Adds the switch.']), [undefined, undefined, undefined]);
	assert.deepEqual(M.assignSaid(2, ['Same.', 'Same.']), [undefined, undefined]);
	assert.deepEqual(M.assignSaid(2, []), [undefined, undefined]);
});

test('nothing found: only the lines; a sentence ends in a stop', () => {
	assert.equal(M.linesSentence({ start: 3, end: 5 }), 'Changed lines 3–5.');
	assert.equal(M.linesSentence({ start: 9, end: 9 }), 'Changed line 9.');
	assert.equal(M.asSentence('  Keeps the reminder time '), 'Keeps the reminder time.');
	assert.equal(M.asSentence('提醒的核心。'), '提醒的核心。');
});

test('the code the model is shown: a new file\'s first lines, a block\'s lines before and now', () => {
	const now = ['a', 'b', 'NEW', 'c'], before = ['a', 'b', 'OLD', 'c'];
	const [stop] = M.walkStops([edit('x.ts', M.hunkOf(3, 4, 3, 4, 4))]).stops;
	assert.equal(M.stopCode(stop, now, before), '-OLD\n+NEW');
	const [file] = M.walkStops([made('n.ts', 4)]).stops;
	assert.equal(M.stopCode(file, now, [], 2), 'a\nb');
});

test('keys on the card: → next, ← back, Esc ends', () => {
	assert.equal(M.walkKey('ArrowRight'), 'next');
	assert.equal(M.walkKey('ArrowLeft'), 'back');
	assert.equal(M.walkKey('Escape'), 'end');
	assert.equal(M.walkKey('Enter'), undefined);
});
