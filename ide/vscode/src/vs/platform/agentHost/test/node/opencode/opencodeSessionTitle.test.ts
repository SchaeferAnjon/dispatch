/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: an OpenCode session OpenCode has not titled yet is named after the first thing typed.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { openCodeDiscoverable, openCodeTitleFromFirst, parseOpenCodeSessionRows } from '../../../node/opencode/opencodeSessions.js';

suite('OpenCode session titles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const row = (title: string, first: unknown) => ({ id: 'ses_abcdefgh1234', title, first, directory: '/p', created: 1, updated: 2 });

	test('OpenCode\'s own title wins; its placeholder gives way to the first thing typed', () => {
		const rows = parseOpenCodeSessionRows(JSON.stringify([
			row('Fix the cart total', 'Reply with exactly: X'),
			row('New session - 2026-10-06T22:15:25.429Z', 'Reply with exactly: SEEDED OPENCODE 8LXUH'),
			row('New session - 2026-10-06T22:15:25.429Z', null),
		]));
		assert.deepStrictEqual(rows?.map(r => r.title), ['Fix the cart total', 'Reply with exactly: SEEDED OPENCODE 8LXUH', undefined]);
	});

	test('output that is not a JSON list is a failed read, not "no sessions" (0.9.2 listed none and looked every id up)', () => {
		assert.strictEqual(parseOpenCodeSessionRows('Performing one time database migration...'), undefined);
		assert.strictEqual(parseOpenCodeSessionRows(''), undefined);
		assert.strictEqual(parseOpenCodeSessionRows('{}'), undefined);
		assert.deepStrictEqual(parseOpenCodeSessionRows('[]'), []);
	});

	test('discovery lists the listed sessions, newest first; the index keeps the others for lookups', () => {
		const rows = parseOpenCodeSessionRows(JSON.stringify([
			{ ...row('Old', null), id: 'ses_old000000001', updated: 5, listed: 1 },
			{ ...row('Empty', null), id: 'ses_empty0000001', updated: 9, listed: 0 },
			{ ...row('New', null), id: 'ses_new000000001', updated: 7, listed: 1 },
		]))!;
		assert.deepStrictEqual(rows.map(r => r.listed), [true, false, true]);
		assert.deepStrictEqual(openCodeDiscoverable(rows).map(r => r.title), ['New', 'Old']);
		assert.deepStrictEqual(openCodeDiscoverable(rows, 1).map(r => r.title), ['New']);
	});

	test('the first line only, at most 80 characters', () => {
		assert.deepStrictEqual([
			openCodeTitleFromFirst('  Count to ten\nthen stop  '),
			openCodeTitleFromFirst('x'.repeat(120)).length,
			openCodeTitleFromFirst(42),
		], ['Count to ten', 80, '']);
	});
});
