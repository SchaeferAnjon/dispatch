/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { choicesKey, connectFailure, machineIdForName, recentFolders, runOnChoices, runOnLabel, THIS_MAC } from '../../browser/dispatchRunOnModel.js';

suite('Dispatch Run on', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const machines = [
		{ id: 'local', name: '小蓝', local: true, online: true },
		{ id: 'mini', name: 'mini', local: false, online: true, ssh: 'apple@100.64.0.11', recent: [{ dir: '/Users/apple/Projects/kanban', label: 'kanban' }, { dir: '/Users/apple/Projects/kanban' }, { dir: 'relative/x' }, { dir: '/a/../b' }, { dir: '/Users/apple/x' }] },
		{ id: 'old', name: 'Old Mac', local: false, online: false, ssh: 'me@old' },
		{ id: 'nossh', name: 'No way in', local: false, online: true },
	];

	test('this Mac first and checked by default, the others with whether they answer', () => {
		assert.deepStrictEqual(runOnChoices(machines, undefined).map(c => [c.id, c.label, c.description, c.checked]), [
			[THIS_MAC, 'This Mac', '小蓝', true],
			['mini', 'mini', 'Online', false],
			['old', 'Old Mac', 'Not reachable right now', false],
		]);
		assert.deepStrictEqual(runOnChoices(machines, 'mini').filter(c => c.checked).map(c => c.id), ['mini']);
		assert.deepStrictEqual(runOnChoices(undefined, undefined).map(c => c.id), [THIS_MAC]);
	});

	test('the open menu is drawn again when a Mac comes, goes or changes whether it answers', () => {
		assert.strictEqual(choicesKey(machines), choicesKey(machines.map(m => ({ ...m }))));
		assert.notStrictEqual(choicesKey(machines.slice(0, 1)), choicesKey(machines));
		assert.notStrictEqual(choicesKey(machines), choicesKey(machines.map(m => m.id === 'mini' ? { ...m, online: false } : m)));
		assert.notStrictEqual(choicesKey(undefined), choicesKey(machines));
	});

	test('the chip names the machine', () => {
		assert.strictEqual(runOnLabel(undefined, machines), 'This Mac');
		assert.strictEqual(runOnLabel('mini', machines), 'mini');
		assert.strictEqual(runOnLabel('gone', machines, 'Studio'), 'Studio');
		assert.strictEqual(machineIdForName('Old Mac', machines), 'old');
		assert.strictEqual(machineIdForName(undefined, machines), undefined);
	});

	test('recent folders: absolute, no repeats, no ..', () => {
		assert.deepStrictEqual(recentFolders(machines[1]), [{ dir: '/Users/apple/Projects/kanban', label: 'kanban' }, { dir: '/Users/apple/x', label: 'x' }]);
		assert.deepStrictEqual(recentFolders(undefined), []);
	});

	test('failures say what to check', () => {
		assert.match(connectFailure('mini', 'connect ETIMEDOUT 100.1.1.1:22'), /on, awake/);
		assert.match(connectFailure('mini', 'All configured authentication methods failed'), /Settings › Macs/);
		assert.match(connectFailure('mini', 'Agent host process exited with code 3 before becoming ready.\noutput: Dispatch is not set up on this computer for this version yet'), /not set up on mini/);
	});
});
