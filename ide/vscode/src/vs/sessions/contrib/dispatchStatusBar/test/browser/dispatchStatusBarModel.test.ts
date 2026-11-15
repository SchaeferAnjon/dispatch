/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the bottom bar's model (patches/120-status-bar.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentsBusy, allowanceWords, duration, gaugeCells, IDispatchBuildLists, isNewUser, parseBuildQueue, queueBlocks } from '../../browser/dispatchStatusBarModel.js';

suite('dispatchStatusBarModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a gauge lights one cell per tenth used, the last one in part', () => {
		assert.deepStrictEqual(gaugeCells(100, 10), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		assert.deepStrictEqual(gaugeCells(17, 10).map(x => Math.round(x * 10) / 10), [1, 0.7, 0, 0, 0, 0, 0, 0, 0, 0]);
		assert.deepStrictEqual(gaugeCells(0, 5), [0, 0, 0, 0, 0]);
		assert.deepStrictEqual(gaugeCells(50, 5).map(x => Math.round(x * 10) / 10), [1, 1, 0.5, 0, 0]);
		assert.deepStrictEqual(gaugeCells(140, 2), [1, 1]);
	});

	test('an allowance says how much is used and when it resets, and stands out from 80% used', () => {
		const o = { narrow: false, newUser: false, usedWord: 'used', resetsWord: (w: string) => `resets ${w}` };
		assert.deepStrictEqual(allowanceWords(83, '01:00', 'Claude', o), { words: '83% used · 01:00', low: true });
		assert.deepStrictEqual(allowanceWords(83, '', 'Claude', o), { words: '83% used', low: true });
		assert.deepStrictEqual(allowanceWords(83, '01:00', 'Claude', { ...o, narrow: true }), { words: '83%', low: true });
		assert.deepStrictEqual(allowanceWords(1, '01:00', 'Codex', o), { words: 'resets 01:00', low: false });
		assert.deepStrictEqual(allowanceWords(1, '', 'Codex', o), { words: '', low: false });
		assert.deepStrictEqual(allowanceWords(1, '01:00', 'Codex', { ...o, newUser: true }), { words: 'Codex · resets 01:00', low: false });
		assert.deepStrictEqual(allowanceWords(1, '01:00', 'Codex', { ...o, newUser: true, narrow: true }), { words: '', low: false });
		assert.deepStrictEqual(allowanceWords(79.6, 'Sun 23:00', 'Claude', o), { words: '80% used · Sun 23:00', low: true });
		assert.strictEqual(allowanceWords(79, '', 'Claude', o).low, false);
	});

	test('the queue: the running build first, a block per build behind it, +N for the rest', () => {
		const now = 10_000;
		const q: IDispatchBuildLists = {
			building: [
				{ name: 'a', host: 'mini', label: 'A', stage: 'build', since: now - 240, estimate: 480 },
				{ name: 'b', host: 'local', label: 'B', stage: 'checks' },
			],
			waiting: [1, 2, 3, 4, 5, 6, 7].map(i => ({ name: `w${i}`, host: 'mini', label: `W${i}`, position: i })),
			failed: [], done: [],
		};
		const wide = queueBlocks(q, 6, now);
		assert.strictEqual(wide.head?.build.name, 'a');
		assert.strictEqual(wide.head?.state, 'build');
		assert.strictEqual(wide.head?.progress, 0.5);
		assert.deepStrictEqual([wide.waiting, wide.more], [6, 2]);
		const narrow = queueBlocks(q, 3, now);
		assert.deepStrictEqual([narrow.waiting, narrow.more], [3, 5]);
		// a fresh build has a sliver, an overdue one is never shown as full
		assert.strictEqual(queueBlocks({ ...q, building: [{ ...q.building[0], since: now }] }, 6, now).head?.progress, 0.06);
		assert.strictEqual(queueBlocks({ ...q, building: [{ ...q.building[0], since: now - 5000 }] }, 6, now).head?.progress, 0.94);
	});

	test('the queue when only checks run, when a build just finished, when nothing happens', () => {
		const checks = queueBlocks({ building: [{ name: 'b', host: 'mini', label: 'B', stage: 'checks' }], waiting: [], failed: [], done: [] }, 6, 0);
		assert.deepStrictEqual([checks.head?.state, checks.head?.progress, checks.waiting], ['checks', 1, 0]);
		const done = queueBlocks({ building: [], waiting: [{ name: 'w', host: 'mini', label: 'W' }], failed: [], done: [{ name: 'd', host: 'mini', label: 'D', ago: 5 }] }, 6, 0);
		assert.deepStrictEqual([done.head?.state, done.head?.build.name, done.waiting], ['done', 'd', 1]);
		const none = queueBlocks({ building: [], waiting: [], failed: [{ name: 'f', host: 'mini', label: 'F' }], done: [] }, 6, 0);
		assert.deepStrictEqual([none.head, none.waiting, none.more], [undefined, 0, 0]);
		assert.deepStrictEqual(queueBlocks(undefined, 6, 0), { head: undefined, waiting: 0, more: 0 });
	});

	test('reads the CLI answer, refuses what is not one', () => {
		assert.strictEqual(parseBuildQueue(undefined), undefined);
		assert.strictEqual(parseBuildQueue({ ok: false, message: 'no' }), undefined);
		assert.deepStrictEqual(parseBuildQueue({ building: [], waiting: [] })?.failed, []);
	});

	test('the agents\' test builds stay apart: never a failure of yours, one quiet block while they run (task-7ve7v)', () => {
		const b = (name: string, more: object = {}) => ({ name, host: 'mini', label: name, ...more });
		const q = parseBuildQueue({
			building: [], waiting: [], done: [],
			failed: [b('9999eeeeffff', { kind: 'yours', step: 'build', why: 'error TS2304', log: '/Users/apple/dispatch-builds/9999eeeeffff/build.log', retry: 'dispatch build start 9999eeeeffff --rebuild' })],
			agents: { building: [b('1111aaaa2222-dev', { stage: 'build' })], waiting: [b('3333bbbb4444-dev')], failed: [b('5555cccc6666-dev'), b('7777dddd8888-dev')], done: [] },
		});
		assert.deepStrictEqual(q?.failed.map(f => f.name), ['9999eeeeffff']);
		assert.strictEqual(q?.failed[0].step, 'build');
		assert.strictEqual(q?.agents.failed.length, 2);
		assert.strictEqual(agentsBusy(q), 2);
		// the bar's own queue blocks are the person's: nothing of theirs runs, so no growing block
		assert.deepStrictEqual(queueBlocks(q, 6, 0), { head: undefined, waiting: 0, more: 0 });
		assert.strictEqual(agentsBusy(undefined), 0);
	});

	test('a CLI from before the split: its development builds are taken for the agents\'', () => {
		const q = parseBuildQueue({
			building: [{ name: '1111aaaa2222-dev', host: 'mini', label: 'A', stage: 'build' }],
			waiting: [],
			failed: [{ name: '5555cccc6666-dev', host: 'mini', label: 'B' }, { name: '9999eeeeffff', host: 'mini', label: 'C' }],
			done: [], recent: { built: 3, failed: 9, checks_failed: 4 },
		});
		assert.deepStrictEqual(q?.failed.map(f => f.name), ['9999eeeeffff']);
		assert.deepStrictEqual(q?.agents.failed.map(f => f.name), ['5555cccc6666-dev']);
		assert.deepStrictEqual([q?.building.length, agentsBusy(q)], [0, 1]);
		// its counts mix both kinds: not shown
		assert.strictEqual(q?.recent, undefined);
	});

	test('durations and the first week', () => {
		assert.strictEqual(duration(20), '1 min');
		assert.strictEqual(duration(300), '5 min');
		assert.strictEqual(duration(3600), '1 h');
		assert.strictEqual(duration(4800), '1 h 20 min');
		const day = 24 * 3600 * 1000;
		assert.strictEqual(isNewUser(0, 10 * day), false);
		assert.strictEqual(isNewUser(1 * day, 3 * day), true);
		assert.strictEqual(isNewUser(1 * day, 9 * day), false);
	});
});
