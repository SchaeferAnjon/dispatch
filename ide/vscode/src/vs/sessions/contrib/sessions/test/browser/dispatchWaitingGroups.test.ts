/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Waiting for you's 7-day rule (dispatchWaitingGroups.ts; 2026-11-11 direction A, task-0v1o9).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { splitWaiting, WAITING_FRESH_DAYS, waitingAge, waitingAskWord, waitingChangedAt, waitingThing } from '../../browser/dispatchWaitingGroups.js';
import type { DispatchWaitingKind, IDispatchWaitingItem } from '../../browser/dispatchWaitingModel.js';

const DAY = 86400;
const NOW = 100 * DAY;

function item(id: string, kind: DispatchWaitingKind, at: number, extra: Partial<IDispatchWaitingItem> = {}): IDispatchWaitingItem {
	return { id, kind, project: 'p', at, title: id, phrase: '', source: 'ide', actions: [], ...extra } as IDispatchWaitingItem;
}

suite('Dispatch Waiting for you, the 7-day rule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('this week the newest first, older than 7 days apart', () => {
		const { week, older } = splitWaiting([
			item('old', 'decide', NOW - 20 * DAY),
			item('mid', 'approve', NOW - 2 * DAY),
			item('new', 'unread', NOW - 60),
			item('edge', 'only_you', NOW - WAITING_FRESH_DAYS * DAY),
			item('past', 'only_you', NOW - WAITING_FRESH_DAYS * DAY - 1),
		], NOW);
		assert.deepStrictEqual(week.map(i => i.id), ['new', 'mid', 'edge']);
		assert.deepStrictEqual(older.map(i => i.id), ['past', 'old']);
	});

	test('the last change counts: an old task edited today is this week', () => {
		const task = item('t', 'only_you', NOW - 30 * DAY, { created_at: NOW - 30 * DAY, updated_at: NOW - DAY });
		assert.strictEqual(waitingChangedAt(task, NOW), NOW - DAY);
		assert.deepStrictEqual(splitWaiting([task], NOW).week.map(i => i.id), ['t']);
		// back from Not now: the time it came back
		const back = item('b', 'only_you', NOW - 30 * DAY, { snooze_until: NOW - 3600 });
		assert.strictEqual(waitingChangedAt(back, NOW), NOW - 3600);
		// still hidden: the time it comes back does not count yet
		assert.strictEqual(waitingChangedAt(item('h', 'only_you', NOW - 30 * DAY, { snooze_until: NOW + DAY }), NOW), NOW - 30 * DAY);
	});

	test('a thing without any time stays this week', () => {
		assert.deepStrictEqual(splitWaiting([item('x', 'decide', 0)], NOW).week.map(i => i.id), ['x']);
	});

	test('the words and ages of a row', () => {
		assert.deepStrictEqual(['decide', 'only_you', 'approve', 'unread'].map(k => waitingAskWord(item('a', k as DispatchWaitingKind, NOW))), ['Pick', 'Only you', 'Approve', 'Reply']);
		// what the thing is, apart from what is asked: only a proposal page is a proposal (task-he465)
		assert.deepStrictEqual(['decide', 'only_you', 'approve', 'unread'].map(k => waitingThing(item('a', k as DispatchWaitingKind, NOW))), ['question', 'only-you', 'approval', 'question']);
		assert.strictEqual(waitingThing({ ...item('a', 'decide', NOW), source: 'board' }), 'proposal');
		assert.deepStrictEqual([NOW - 10, NOW - 300, NOW - 7200, NOW - 3 * DAY].map(at => waitingAge(item('a', 'decide', at), NOW)), ['now', '5m', '2h', '3d']);
	});
});
