/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's command list for the slash menu (opencodeCommands.ts).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { openCodeSlashCommandsForMenu, readAvailableCommands } from '../../../node/opencode/opencodeCommands.js';

suite('opencodeCommands', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads ACP available_commands_update', () => {
		assert.deepStrictEqual(readAvailableCommands([
			{ name: 'init', description: 'guided AGENTS.md setup' },
			{ name: 'review', description: 'review changes', input: { hint: '[commit]' } },
			{ name: '', description: 'x' },
			null,
			{ description: 'no name' },
		]), [
			{ name: 'init', description: 'guided AGENTS.md setup' },
			{ name: 'review', description: 'review changes', hint: '[commit]' },
		]);
		assert.deepStrictEqual(readAvailableCommands('nope'), []);
	});

	test('commands, skills and the synced duplicates', () => {
		const list = readAvailableCommands([
			{ name: 'init', description: 'guided AGENTS.md setup' },
			{ name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
			{ name: 'handoff', description: '(builtin) Create a detailed context summary' },
			{ name: 'save-session', description: '(user) Save current session state' },
			{ name: 'herdr', description: '(user - Skill) 用户明确要操作 Herdr 时用。' },
			{ name: 'synced/abc_def/morning', description: '(user - Skill) Render the morning brief' },
			{ name: 'customize-opencode', description: 'How to customize OpenCode' },
			{ name: 'init', description: 'twice' },
		]);
		const menu = openCodeSlashCommandsForMenu(list, new Map([['customize-opencode', 'skill']]), false);
		assert.deepStrictEqual(menu.map(c => [c.name, !!c.isSkill, c.runsImmediately]), [
			['init', false, true],
			['review', false, false],
			['handoff', false, true],
			['save-session', false, false],
			['herdr', true, false],
			['customize-opencode', true, false],
		]);
		assert.strictEqual(menu[0].description, 'Guided AGENTS.md setup');
		assert.strictEqual(menu[2].description, 'Create a detailed context summary');
		assert.strictEqual(menu[4].description, '用户明确要操作 Herdr 时用。');
	});

	test('compact works over ACP though newer OpenCode leaves it out of the list', () => {
		const list = readAvailableCommands([{ name: 'init', description: 'guided AGENTS.md setup' }]);
		assert.ok(!openCodeSlashCommandsForMenu(list, undefined, false).some(c => c.name === 'compact'));
		const compact = openCodeSlashCommandsForMenu(list, undefined, true).find(c => c.name === 'compact');
		assert.strictEqual(compact?.runsImmediately, true);
	});
});
