/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the bottom bar's cup in words (patches/120-status-bar.patch, kanban task-vggq).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { awakeMode, awakeWords, awakeWorking } from '../../browser/dispatchAwakeWords.js';

suite('dispatchAwakeWords', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the cup says it holds while agents work, never while a window is open', () => {
		const w = awakeWords({ mode: 'system', holding: true, reason: 'working', working: 1 }, 1);
		assert.strictEqual(w.head, 'Your Mac stays awake while agents work');
		assert.ok(!/window/.test(w.head + w.why));
		assert.ok(/screen still dims/.test(w.why));
		assert.strictEqual(w.count, '1 agent is working now.');
	});

	test('screen on too, and a phone as the reason', () => {
		assert.strictEqual(awakeWords({ mode: 'display', holding: true, reason: 'working', working: 2 }, 0).head, 'Your Mac and its screen stay awake while agents work');
		const p = awakeWords({ mode: 'system', holding: true, reason: 'phone', working: 0 }, 0);
		assert.strictEqual(p.head, 'Your Mac stays awake while your phone is connected');
		assert.strictEqual(p.count, '');
	});

	test('agents working: the larger of this window and the whole Mac', () => {
		assert.strictEqual(awakeWorking({ mode: 'system', holding: true, working: 3 }, 1), 3);
		assert.strictEqual(awakeWorking({ mode: 'system', holding: true }, 2), 2);
		assert.strictEqual(awakeWorking(undefined, 0), 0);
		assert.strictEqual(awakeWords({ mode: 'system', holding: true, working: 3 }, 1).count, '3 agents are working now.');
	});

	test('the panel switches lead: its words follow the setting before the background service does', () => {
		const held = { mode: 'system', holding: true, reason: 'working', working: 1 } as const;
		assert.strictEqual(awakeWords(held, 0, 'display').head, 'Your Mac and its screen stay awake while agents work');
		const off = awakeWords(held, 0, 'off');
		assert.strictEqual(off.head, 'Your Mac sleeps as usual');
		assert.ok(/Agents stop while it sleeps/.test(off.why));
		assert.strictEqual(off.count, '1 agent is working now.');
		assert.strictEqual(awakeWords({ mode: 'system', holding: true, reason: 'phone' }, 0, 'off').head, 'Your Mac sleeps as usual');
	});

	test('the setting as a mode: anything unknown is the Mac only', () => {
		assert.strictEqual(awakeMode('display'), 'display');
		assert.strictEqual(awakeMode('off'), 'off');
		assert.strictEqual(awakeMode('system'), 'system');
		assert.strictEqual(awakeMode(undefined), 'system');
		assert.strictEqual(awakeMode(2), 'system');
	});
});
