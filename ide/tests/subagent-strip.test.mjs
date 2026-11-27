import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The sub-agent strip above the message box, direction A (2026-11-12, task-1rzdr, kanban design/subagent-strip):
// when it shows, its head, its rows, what is folded into "N finished", and the step a conversation is on.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const M = await import(moduleAt('sessions/contrib/dispatchSubagents/browser/dispatchSubagentsModel.ts'));

const T0 = 1_000_000;
const agent = (o) => ({ id: o.name, state: 'sub-agent', startedAt: T0, elapsedMs: 0, ...o });

test('the clock shows seconds under an hour, so it is seen to move', () => {
	assert.equal(M.clockLabel(0), '0s');
	assert.equal(M.clockLabel(19_400), '19s');
	assert.equal(M.clockLabel(60_000), '1m 0s');
	assert.equal(M.clockLabel(909_000), '15m 9s');
	assert.equal(M.clockLabel(3_900_000), '1h 5m');
	assert.equal(M.clockLabel(-5), '0s', 'a clock a little ahead is no time, not a minus');
});

test('the strip shows only while one works; one stopped or back alone hides it', () => {
	assert.equal(M.stripOf([], T0, T0).visible, false);
	assert.equal(M.stripOf([agent({ name: 'a', state: 'stopped' })], T0, T0).visible, false);
	assert.equal(M.stripOf([agent({ name: 'a', state: 'done' })], T0, T0).visible, false);
	assert.equal(M.stripOf([agent({ name: 'a' }), agent({ name: 'b', state: 'done' })], T0, T0).visible, true);
});

test('the head counts the ones working; folded it adds the first one and its step', () => {
	const one = M.stripOf([agent({ name: 'Draw the samples', step: 'Open the page at four widths' })], T0, T0);
	assert.equal(one.head, '1 agent working');
	assert.equal(one.line, 'Draw the samples: Open the page at four widths');
	const two = M.stripOf([
		agent({ name: 'Check them in dark', startedAt: T0 + 5000 }),
		agent({ name: 'Draw the samples', startedAt: T0 + 1000 }),
	], T0, T0);
	assert.equal(two.head, '2 agents working');
	assert.equal(two.line, 'Draw the samples', 'the oldest first; without a step only its name');
});

test('rows: the ones working oldest first, then the stopped; back ones folded, newest first', () => {
	const s = M.stripOf([
		agent({ name: 'back old', state: 'done', startedAt: T0 + 1 }),
		agent({ name: 'stopped', state: 'stopped', startedAt: T0 + 2 }),
		agent({ name: 'late', startedAt: T0 + 9 }),
		agent({ name: 'early', startedAt: T0 + 3 }),
		agent({ name: 'back new', state: 'done', startedAt: T0 + 8 }),
	], T0, T0);
	assert.deepEqual(s.rows.map(r => r.name), ['early', 'late', 'stopped']);
	assert.deepEqual(s.finished.map(r => r.name), ['back new', 'back old']);
	assert.equal(M.finishedLabel(s.finished.length), '2 finished');
	assert.equal(M.finishedLabel(1), '1 finished');
});

test('only this round: sub-agents from an earlier message stay out', () => {
	const s = M.stripOf([
		agent({ name: 'earlier', state: 'done', startedAt: T0 - 60_000 }),
		agent({ name: 'now', startedAt: T0 + 2000 }),
	], T0, T0);
	assert.deepEqual(s.finished.map(r => r.name), []);
	assert.deepEqual(s.rows.map(r => r.name), ['now']);
	assert.equal(M.stripOf([agent({ name: 'x', state: 'done', startedAt: 1 })], undefined, T0).finished.length, 1, 'no round known: all of them');
});

test('a row: how long, the step and its clock, "Stopped after" once stopped; never a token count', () => {
	const now = T0 + 100_000;
	const [w] = M.stripOf([agent({ name: 'w', tokens: 259_100, elapsedMs: 909_000, step: 'Read notes.md', stepSince: now - 19_000 })], T0, now).rows;
	assert.equal(w.meta, '15m 9s', 'no engine gives a sub-agent its own tokens: no number, whatever comes in');
	assert.equal(w.second, 'Read notes.md');
	assert.equal(w.stepTime, '19s');
	const [bare] = M.stripOf([agent({ name: 'b', elapsedMs: 42_000 })], T0, now).rows;
	assert.equal(bare.meta, '42s');
	assert.equal(bare.second, '', 'no step known: an empty second line, not a guess');
	assert.equal(bare.stepTime, '');
	const s = M.stripOf([agent({ name: 'w' }), agent({ name: 's', state: 'stopped', elapsedMs: 124_000, step: 'old step', stepSince: T0 })], T0, now);
	const stopped = s.rows.find(r => r.name === 's');
	assert.equal(stopped.second, 'Stopped after 2m 4s');
	assert.equal(stopped.stepTime, '', 'a stopped one has no step clock');
});

test('the step clock keeps its start while the step stays the same', () => {
	assert.equal(M.stepSince(undefined, 'Read a', 50), 50);
	assert.equal(M.stepSince({ step: 'Read a', since: 10 }, 'Read a', 50), 10);
	assert.equal(M.stepSince({ step: 'Read a', since: 10 }, 'Read b', 50), 50);
});

test('the step a conversation is on: its newest tool call still running, shown, in one line', () => {
	const part = (o) => ({ tool: true, running: true, hidden: false, message: '', ...o });
	assert.equal(M.runningStep([]), '');
	assert.equal(M.runningStep([part({ message: 'Reading  a.md\n' }), part({ message: 'Reading b.md', running: false })]), 'Reading a.md');
	assert.equal(M.runningStep([part({ message: 'Reading a.md' }), part({ message: 'hidden', hidden: true })]), 'Reading a.md');
	assert.equal(M.runningStep([part({ message: 'Running task', subagent: { description: 'Count to 1500 A' } })]), 'Count to 1500 A', 'a call that started a sub-agent says what it was sent to do');
	assert.equal(M.runningStep([part({ message: 'Running task', subagent: { description: '' } })]), 'Running task', 'Codex and OpenCode give no description: the call\'s own words');
	assert.equal(M.runningStep([{ tool: false, running: true, hidden: false, message: 'words' }]), '', 'words are not a step');
});

test('one sub-agent\'s step: its own newest running call in the reply that sent it out, found by its chat', () => {
	const part = (o) => ({ tool: true, running: true, hidden: false, message: '', ...o });
	const parts = [
		part({ id: 'call-a', subagent: { description: 'Count to 1500 A', chat: 'agent-host://s/1/subagent/call-a' }, message: 'task' }),
		part({ id: 'a1', parent: 'call-a', message: 'Reading a.md', running: false }),
		part({ id: 'a2', parent: 'call-a', message: 'Running ls' }),
		part({ id: 'call-b', subagent: { description: 'Count to 1500 B' }, message: 'task' }),
		part({ id: 'b1', parent: 'call-b', message: 'Reading b.md' }),
	];
	assert.equal(M.subagentStep(parts, { resource: 'agent-host://s/1/subagent/call-a', fragment: '' }), 'Running ls', 'by the chat the call names');
	assert.equal(M.subagentStep(parts, { resource: 'agent-host://s/1#subagent/call-b', fragment: 'subagent/call-b' }), 'Reading b.md', 'by the call in the chat\'s fragment');
	assert.equal(M.subagentStep(parts, { resource: 'agent-host://s/2/subagent/call-b', fragment: '' }), 'Reading b.md', 'by the call at the end of its path');
	assert.equal(M.subagentStep(parts, { resource: 'agent-host://s/1/subagent/call-c', fragment: '' }), '', 'a sub-agent not in this reply: nothing');
	assert.equal(M.subagentStep(parts.slice(0, 2), { resource: 'agent-host://s/1/subagent/call-a', fragment: '' }), 'Reading a.md', 'between calls: the last one it ran, as VS Code\'s block shows it (task-518qw)');
});
