import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// A task link in a reply opens the task in the side pane's Tasks tab at once (task-86t0e): the window keeps what the
// board said about each task, asks a few at a time, puts a click's question first and never asks twice at once.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { DispatchTaskBriefs } = await import(moduleAt('workbench/contrib/chat/common/dispatchTaskBriefs.ts'));

/** A board that answers when told to: every question waits until `answer(id)`. */
function board() {
	const asked = [];
	const waiting = new Map();
	return {
		asked,
		ask: id => { asked.push(id); return new Promise(resolve => waiting.set(id, resolve)); },
		answer: (id, value = { id, title: `Title of ${id}` }) => { waiting.get(id)(value); waiting.delete(id); },
		open: () => [...waiting.keys()],
	};
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('a fresh answer is used without asking again; an old one is still shown at once', async () => {
	let now = 1000;
	const s = new DispatchTaskBriefs({ freshMs: 60_000, now: () => now });
	const b = board();
	const p = s.get('task-a', b.ask);
	b.answer('task-a');
	assert.equal((await p).title, 'Title of task-a');
	assert.equal((await s.get('task-a', b.ask)).title, 'Title of task-a');
	assert.deepEqual(b.asked, ['task-a'], 'asked once');
	now += 61_000;
	assert.equal(s.isFresh('task-a'), false);
	assert.equal(s.peek('task-a').title, 'Title of task-a', 'an old answer is still there to show');
	void s.get('task-a', b.ask);
	assert.deepEqual(b.asked, ['task-a', 'task-a'], 'an old answer is asked again');
});

test('the same question twice at once is one question', async () => {
	const s = new DispatchTaskBriefs();
	const b = board();
	const one = s.get('task-a', b.ask);
	const two = s.get('task-a', b.ask, { fresh: true, urgent: true });
	b.answer('task-a');
	assert.equal(await one, await two);
	assert.deepEqual(b.asked, ['task-a']);
	assert.equal(s.pending, 0);
});

test('a reply\'s tasks are asked two at a time; a click goes before the ones in line', async () => {
	const s = new DispatchTaskBriefs({ concurrency: 2 });
	const b = board();
	s.prefetch(['task-a', 'task-b', 'task-c', 'task-d', 'task-a'], b.ask);
	assert.deepEqual(b.asked, ['task-a', 'task-b'], 'two at once, a repeated id once');
	const click = s.get('task-d', b.ask, { fresh: true, urgent: true });
	b.answer('task-a');
	await tick();
	assert.deepEqual(b.asked, ['task-a', 'task-b', 'task-d'], 'the clicked task is next, before task-c');
	b.answer('task-d');
	assert.equal((await click).title, 'Title of task-d');
	await tick();
	assert.deepEqual(b.open().sort(), ['task-b', 'task-c']);
	b.answer('task-b');
	b.answer('task-c');
	await tick();
	assert.equal(s.pending, 0);
	s.prefetch(['task-a', 'task-b', 'task-c', 'task-d'], b.ask);
	assert.equal(b.asked.length, 4, 'nothing fresh is asked again');
});

test('a task the board does not know is not kept; a failed question asks again next time', async () => {
	const s = new DispatchTaskBriefs();
	const b = board();
	const p = s.get('task-x', b.ask);
	b.answer('task-x', { id: 'task-x', error: 'no task task-x' });
	assert.equal((await p).error, 'no task task-x');
	assert.equal(s.peek('task-x'), undefined);
	const failing = new DispatchTaskBriefs();
	assert.equal(await failing.get('task-y', () => Promise.reject(new Error('bridge down'))), undefined);
	assert.equal(failing.pending, 0, 'a failed question does not block the line');
});

test('a list the Tasks tab got counts as answers; the oldest go when there are too many', () => {
	const s = new DispatchTaskBriefs({ max: 2 });
	s.remember([{ id: 'task-a', title: 'A' }, { id: 'task-b', title: 'B' }, { id: 'task-e', error: 'x' }]);
	assert.equal(s.peek('task-a').title, 'A');
	assert.equal(s.peek('task-e'), undefined);
	s.remember([{ id: 'task-c', title: 'C' }]);
	assert.equal(s.peek('task-a'), undefined, 'the oldest went');
	assert.equal(s.peek('task-c').title, 'C');
	assert.ok(s.isFresh('task-b'));
});
