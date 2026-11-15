import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The session Now tab of direction A (2026-11-11, task-0v1o9): which head, which step, which rows, which marks.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const M = await import(moduleAt('sessions/contrib/dispatchNow/browser/dispatchNowModel.ts'));

const plan = (...states) => states.map((state, i) => ({ text: `step ${i + 1}`, state }));

test('the head: a terminal session is always the terminal, an error stops, a question waits, a run works', () => {
	const m = (o) => M.nowMode({ terminal: false, status: 'idle', asks: false, unfinished: false, ...o });
	assert.equal(m({ terminal: true, status: 'working', asks: true }), 'terminal');
	assert.equal(m({ status: 'error', asks: true }), 'stopped');
	assert.equal(m({ status: 'needs-input' }), 'waiting');
	assert.equal(m({ status: 'working', asks: true, unfinished: true }), 'working', 'a running turn is working, whatever waits');
	assert.equal(m({ asks: true, unfinished: true }), 'waiting', 'a direction to pick waits once the turn is over');
	assert.equal(m({ canceled: true }), 'stopped', 'a turn the person stopped is stopped, not done');
	assert.equal(m({ canceled: true, unfinished: true }), 'paused', 'with steps left it is paused at that step, also when the person stopped it');
	assert.equal(m({ canceled: true, asks: true }), 'waiting', 'what waits for the person still comes first');
});

test('a turn that ended with steps left is paused; done is a finished task, no task or no plan', () => {
	const m = (o) => M.nowMode({ terminal: false, status: 'idle', asks: false, unfinished: false, ...o });
	assert.equal(m({ unfinished: true }), 'paused');
	assert.equal(m({}), 'done');
	assert.equal(M.isUnfinished({ status: 'in_progress', plan: plan('done', 'active', 'todo') }), true);
	assert.equal(M.isUnfinished({ status: 'in_progress', plan: plan('done', 'todo') }), true);
	assert.equal(M.isUnfinished({ status: 'in_progress', plan: plan('done', 'done') }), false, 'every step done');
	assert.equal(M.isUnfinished({ status: 'done', plan: plan('done', 'active') }), false, 'a finished task');
	assert.equal(M.isUnfinished({ status: 'in_progress', plan: [] }), false, 'no plan');
	assert.equal(M.isUnfinished({ status: 'in_progress' }), false, 'no plan at all');
	assert.equal(M.isUnfinished(null), false, 'no task');
});

test('"step 3 of 5": the step it is on, else the first one not done, none without a plan', () => {
	assert.deepEqual(M.stepOf(plan('done', 'done', 'active', 'todo', 'todo')), { at: 3, of: 5 });
	assert.deepEqual(M.stepOf(plan('done', 'todo', 'todo')), { at: 2, of: 3 });
	assert.deepEqual(M.stepOf(plan('done', 'done')), { at: 2, of: 2 });
	assert.equal(M.stepOf([]), undefined);
});

test('a span in the head\'s words', () => {
	assert.deepEqual(M.spanOf(20_000), { unit: 'now' });
	assert.deepEqual(M.spanOf(12 * 60_000 + 5_000), { unit: 'min', n: 12 });
	assert.deepEqual(M.spanOf(2 * 3600_000 + 59 * 60_000), { unit: 'h', n: 2 });
	assert.deepEqual(M.spanOf(3 * 86400_000), { unit: 'd', n: 3 });
	assert.deepEqual(M.spanOf(-5), { unit: 'now' });
});

test('steps: done; the one it is on green only while it runs, amber when it waits, hollow where it paused; not started', () => {
	assert.deepEqual(M.stepKinds(plan('done', 'active', 'todo'), 'in_progress', 'working'), ['done', 'now', 'todo'], 'a green dot only while it runs');
	assert.deepEqual(M.stepKinds(plan('done', 'active', 'todo'), 'in_progress', 'waiting'), ['done', 'ask', 'todo']);
	assert.deepEqual(M.stepKinds(plan('done', 'active', 'todo'), 'waiting'), ['done', 'ask', 'todo']);
	assert.deepEqual(M.stepKinds(plan('done', 'active', 'todo'), 'done'), ['done', 'todo', 'todo']);
	assert.deepEqual(M.stepKinds(plan('done', 'active', 'todo'), 'in_progress', 'paused'), ['done', 'stop', 'todo'], 'paused: where it stopped');
	assert.deepEqual(M.stepKinds(plan('done', 'todo', 'todo'), 'in_progress', 'paused'), ['done', 'stop', 'todo'], 'paused with no step marked: the first not done');
	assert.deepEqual(M.stepKinds(plan('done', 'active', 'todo'), 'in_progress'), ['done', 'stop', 'todo'], 'another task of the session: not running, no green dot');
	assert.deepEqual(M.stepKinds(plan('done', 'todo'), 'in_progress', 'working'), ['done', 'todo'], 'no step marked while it works: no dot');
});

test('rows: the task it is on first (a finished one too), the others not finished; finished ones fold away', () => {
	const tasks = [{ id: 'a', status: 'in_progress' }, { id: 'b', status: 'todo' }, { id: 'c', status: 'done' }, { id: 'd', status: 'done' }];
	const working = M.splitTasks(tasks, 'a');
	assert.deepEqual(working.rows.map(t => t.id), ['a', 'b']);
	assert.deepEqual(working.done.map(t => t.id), ['c', 'd']);
	const done = M.splitTasks(tasks.map(t => ({ ...t, status: 'done' })), 'd');
	assert.deepEqual(done.rows.map(t => t.id), ['d'], 'the session\'s last task stays a row when it is finished');
	assert.deepEqual(done.done.map(t => t.id), ['a', 'b', 'c']);
	assert.deepEqual(M.splitTasks(tasks, undefined).rows.map(t => t.id), ['a', 'b']);
});

test('sub-agents hang under the step it is on, else the last one done, else above the tasks', () => {
	assert.equal(M.agentAnchor(plan('done', 'active', 'todo')), 1);
	assert.equal(M.agentAnchor(plan('done', 'done', 'todo')), 1);
	assert.equal(M.agentAnchor(plan('todo', 'todo')), -1);
	assert.equal(M.agentAnchor([]), -1);
});

test('the delivery page and the proposal are the pages dispatch deliver made, the newest first', () => {
	const ds = [
		{ kind: 'commit', ref: 'abc', label: 'x' },
		{ kind: 'file', ref: '/a/index.html', label: 'Delivery page', at: 1 },
		{ kind: 'file', ref: '/b/index.html', label: 'Delivery page', at: 2 },
		{ kind: 'file', ref: '/c/index.html', label: 'Proposal', at: 3 },
	];
	assert.equal(M.deliveryPage(ds, 'Delivery page').ref, '/b/index.html');
	assert.equal(M.deliveryPage(ds, 'Proposal').ref, '/c/index.html');
	assert.equal(M.deliveryPage([{ kind: 'url', ref: 'https://x', label: 'Delivery page' }], 'Delivery page'), undefined);
	assert.equal(M.deliveryPage(undefined, 'Proposal'), undefined);
});

test('the terminal\'s last line: frames and empty lines skipped, a prompt at the end skipped', () => {
	assert.equal(M.lastTerminalLine('$ opencode\n\n● Reading src/reader.ts\n● Applied 3 edits to src/reader.ts\n\n'), '● Applied 3 edits to src/reader.ts');
	assert.equal(M.lastTerminalLine('build ok\nme@mac demo % '), 'build ok');
	assert.equal(M.lastTerminalLine('┌──────┐\n│ Ask anything │\n└──────┘\n────────'), 'Ask anything');
	assert.equal(M.lastTerminalLine('➜ demo git:(main) echo Applied 3 edits\nApplied 3 edits\n➜ demo git:(main) '), 'Applied 3 edits', 'a prompt a command was typed after');
	assert.equal(M.lastTerminalLine('me@mac demo % '), 'me@mac demo %', 'a prompt alone is still what it shows');
	assert.equal(M.lastTerminalLine(''), '');
});

test('stopped by the person: kept from the moment it happened, until a later turn is there (task-cq11p)', () => {
	const s = M.stoppedByPerson;
	// the conversation still loaded: its last reply says so, and the turn is kept
	assert.deepEqual(s({ idle: true, requests: 3, lastCanceled: true }), { canceled: true, mark: 3 });
	// loaded again after a switch or a reload: the reply no longer says it, the kept turn does
	assert.deepEqual(s({ idle: true, requests: 3, lastCanceled: false, marked: 3 }), { canceled: true, mark: 3 });
	// not loaded yet: the same last turn as far as anyone knows
	assert.deepEqual(s({ idle: true, marked: 3 }), { canceled: true, mark: 3 });
	// the person went on: while it works it is not stopped, and the kept turn is over
	assert.deepEqual(s({ idle: false, requests: 4, lastCanceled: false, marked: 3 }), { canceled: false, mark: undefined });
	assert.deepEqual(s({ idle: true, requests: 4, lastCanceled: false, marked: 3 }), { canceled: false, mark: undefined });
	// stopped again on the later turn: that one is kept
	assert.deepEqual(s({ idle: true, requests: 4, lastCanceled: true, marked: 3 }), { canceled: true, mark: 4 });
	// nothing was ever stopped
	assert.deepEqual(s({ idle: true, requests: 2, lastCanceled: false }), { canceled: false, mark: undefined });
	assert.deepEqual(s({ idle: true }), { canceled: false, mark: undefined });
});
