import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Waiting for you's 7-day rule (design/home-now direction A, 2026-11-11, task-0v1o9): one place computes it, the side
// bar's rows and number and the page's This week and Older read it
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { splitWaiting, WAITING_FRESH_DAYS, waitingAge, waitingAskWord, waitingChangedAt, waitingThing, waitingThingName } = await import(moduleAt('sessions/contrib/sessions/browser/dispatchWaitingGroups.ts'));

const DAY = 86400;
const NOW = 100 * DAY;
const item = (id, kind, at, extra = {}) => ({ id, kind, project: 'p', at, title: id, phrase: '', source: 'ide', actions: [], ...extra });

test('the line is seven days, a constant', () => {
	assert.equal(WAITING_FRESH_DAYS, 7);
});

test('this week the newest first; not moved for longer is Older, the newest first', () => {
	const { week, older } = splitWaiting([
		item('old', 'decide', NOW - 20 * DAY),
		item('mid', 'approve', NOW - 2 * DAY),
		item('new', 'unread', NOW - 60),
		item('edge', 'only_you', NOW - 7 * DAY),
		item('past', 'only_you', NOW - 7 * DAY - 1),
	], NOW);
	assert.deepEqual(week.map(i => i.id), ['new', 'mid', 'edge']);
	assert.deepEqual(older.map(i => i.id), ['past', 'old']);
});

test('"not moved" is the last change: an edit, a session stopping again, coming back from Not now', () => {
	assert.equal(waitingChangedAt(item('t', 'only_you', NOW - 30 * DAY, { created_at: NOW - 30 * DAY, updated_at: NOW - DAY }), NOW), NOW - DAY);
	assert.equal(waitingChangedAt(item('s', 'approve', NOW - 9 * DAY, { stopped_at: NOW - 3 * DAY }), NOW), NOW - 3 * DAY);
	assert.equal(waitingChangedAt(item('b', 'only_you', NOW - 30 * DAY, { snooze_until: NOW - 3600 }), NOW), NOW - 3600);
	assert.equal(waitingChangedAt(item('h', 'only_you', NOW - 30 * DAY, { snooze_until: NOW + DAY }), NOW), NOW - 30 * DAY);
});

test('a thing without any time is not hidden away', () => {
	assert.deepEqual(splitWaiting([item('x', 'decide', 0)], NOW).week.map(i => i.id), ['x']);
});

test('the row says what is asked in one word and how long ago in a few characters', () => {
	assert.deepEqual(['decide', 'only_you', 'approve', 'unread'].map(k => waitingAskWord(item('a', k, NOW))), ['Pick', 'Only you', 'Approve', 'Reply']);
	assert.deepEqual([NOW - 10, NOW - 300, NOW - 7200, NOW - 3 * DAY].map(at => waitingAge(item('a', 'decide', at), NOW)), ['now', '5m', '2h', '3d']);
	assert.equal(waitingAge(item('a', 'decide', 0), NOW), '');
});

test('the first slot says what the thing is, apart from what is asked: only a proposal page is a proposal (task-he465)', () => {
	const things = [item('p', 'decide', NOW, { source: 'board' }), item('q', 'decide', NOW), item('r', 'unread', NOW), item('a', 'approve', NOW), item('o', 'only_you', NOW)];
	assert.deepEqual(things.map(i => waitingThing(i)), ['proposal', 'question', 'question', 'approval', 'only-you']);
	assert.deepEqual(things.map(i => waitingThingName(i)), ['Proposal', 'Question', 'Question', 'Approval', 'Only you']);
	assert.deepEqual(things.map(i => waitingAskWord(i)), ['Pick', 'Pick', 'Reply', 'Approve', 'Only you']);
});
