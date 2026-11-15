/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the slash menu's rows (dispatchSlashMenuModel.ts).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildSlashRows, firstSelectable, ISlashEntry, ISlashGrayEntry, nextSelectable, parseSlashQuery, scoreEntry, SlashAction, SlashGroupId, SlashRow } from '../../browser/dispatchSlashMenuModel.js';

function entry(group: SlashGroupId, name: string, description = '', extra: Partial<ISlashEntry> = {}): ISlashEntry {
	return { id: `${group}:${name}`, group, name, slash: group === SlashGroupId.Commands || group === SlashGroupId.Skills, description, action: SlashAction.Run, ...extra };
}

const commands = ['compact', 'context', 'usage', 'init', 'security-review', 'recap', 'goal'].map(n => entry(SlashGroupId.Commands, n));
const skills = ['bilibili-series-to-notes', 'concept-animation', 'concept-svg', 'delivery-page', 'designer', 'anthropic-skills:computer-use'].map(n => entry(SlashGroupId.Skills, n, '', { action: SlashAction.Insert }));
const mcp = [entry(SlashGroupId.Mcp, 'playwright', 'Connected', { action: SlashAction.Open })];
const plugins = [entry(SlashGroupId.Plugins, 'superpowers', '15 skills', { action: SlashAction.Open })];
const agents = [entry(SlashGroupId.Agents, 'designer', 'Design reviews', { action: SlashAction.Switch })];
const models = [
	...['Opus 5.5', 'Opus 5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5'].map((n, i) => entry(SlashGroupId.Model, n, '', { action: SlashAction.Switch, current: i === 0 })),
	entry(SlashGroupId.Model, 'All models and effort', 'Open the model picker', { action: SlashAction.Open, trailing: true }),
];
const all = [...commands, ...skills, ...mcp, ...plugins, ...agents, ...models];
const gray: ISlashGrayEntry[] = [
	{ name: 'resume', why: 'Claude Code has /resume only in its terminal', where: 'Your sessions are in Sessions on the left', go: 'sessions' },
	{ name: 'review', why: '/review is a Codex and OpenCode command', where: 'Start a Codex or OpenCode session to use it', go: '' },
	{ name: 'compact', why: 'not here', where: '', go: '' },
];

function describeRows(rows: SlashRow[]): string[] {
	return rows.map(r => {
		switch (r.kind) {
			case 'header': return `# ${r.group} ${r.count}`;
			case 'grayHeader': return '# gray';
			case 'item': return r.entry.name;
			case 'more': return `more ${r.group} ${r.total}${r.matches ? ' matches' : ''}`;
			case 'gray': return `gray ${r.entry.name}`;
			case 'empty': return `empty ${r.query}`;
		}
	});
}

suite('dispatchSlashMenuModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the menu opens only while the whole input is one /token', () => {
		assert.strictEqual(parseSlashQuery('/'), '');
		assert.strictEqual(parseSlashQuery('/Comp'), 'comp');
		assert.strictEqual(parseSlashQuery('/compact '), undefined);
		assert.strictEqual(parseSlashQuery('/compact now'), undefined);
		assert.strictEqual(parseSlashQuery('hello /compact'), undefined);
		assert.strictEqual(parseSlashQuery(''), undefined);
		assert.strictEqual(parseSlashQuery('/a\nb'), undefined);
	});

	test('/ alone: every group with its first four, the rest behind Show all', () => {
		const rows = describeRows(buildSlashRows(all, gray, '', new Set()));
		assert.deepStrictEqual(rows, [
			'# commands 7', 'compact', 'context', 'usage', 'init', 'more commands 7',
			'# skills 6', 'bilibili-series-to-notes', 'concept-animation', 'concept-svg', 'delivery-page', 'more skills 6',
			'# mcp 1', 'playwright',
			'# plugins 1', 'superpowers',
			'# agents 1', 'designer',
			'# model 5', 'Opus 5.5', 'Opus 5', 'Fable 5.1', 'Sonnet 5.5', 'more model 5',
		]);
	});

	test('Show all opens a group; the model picker row comes last once every model is in view', () => {
		const rows = describeRows(buildSlashRows(all, gray, '', new Set([SlashGroupId.Commands, SlashGroupId.Model])));
		assert.deepStrictEqual(rows.slice(0, 9), ['# commands 7', 'compact', 'context', 'usage', 'init', 'security-review', 'recap', 'goal', '# skills 6']);
		assert.deepStrictEqual(rows.slice(-7), ['# model 5', 'Opus 5.5', 'Opus 5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5', 'All models and effort']);
	});

	test('a whole group name shows that group only', () => {
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'skills', new Set())), ['# skills 6', ...skills.map(s => s.name)]);
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'mcp', new Set())), ['# mcp 1', 'playwright']);
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'models', new Set())).slice(-1), ['All models and effort']);
		assert.deepStrictEqual(describeRows(buildSlashRows(all, [], 'agents', new Set())), ['# agents 1', 'designer']);
	});

	test('typing filters across groups, best first', () => {
		const rows = describeRows(buildSlashRows(all, [], 'comp', new Set()));
		assert.deepStrictEqual(rows, ['# commands 1', 'compact', '# skills 1', 'anthropic-skills:computer-use']);
		const conc = describeRows(buildSlashRows(all, [], 'conc', new Set()));
		assert.deepStrictEqual(conc, ['# skills 2', 'concept-animation', 'concept-svg']);
		// fuzzy: letters in order
		assert.ok(scoreEntry({ name: 'security-review', description: '' }, 'secrev') > 0);
		assert.strictEqual(scoreEntry({ name: 'usage', description: '' }, 'xyz'), 0);
		// a name the engine calls differently
		assert.ok(scoreEntry({ name: 'usage', description: '', aliases: ['cost'] }, 'cos') > 0);
	});

	test('a command this session cannot run gets a grey row: first when typed in full, last otherwise', () => {
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'res', new Set())), ['# gray', 'gray resume']);
		// three letters also find what an entry says it does (the designer agent's "Design reviews")
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'rev', new Set())), ['# commands 1', 'security-review', '# agents 1', 'designer', '# gray', 'gray review']);
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'review', new Set())), ['# gray', 'gray review', '# commands 1', 'security-review', '# agents 1', 'designer']);
		// fewer than three characters: no grey rows
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 're', new Set())).filter(r => r.startsWith('gray')), []);
		// a command the engine has is never grey
		assert.ok(!describeRows(buildSlashRows(all, gray, 'compact', new Set())).includes('gray compact'));
	});

	test('nothing matches: one row that says Enter sends the text', () => {
		assert.deepStrictEqual(describeRows(buildSlashRows(all, gray, 'zzzz', new Set())), ['empty zzzz']);
	});

	test('the keyboard skips heads and wraps round', () => {
		const rows = buildSlashRows(all, gray, 'comp', new Set());
		const first = firstSelectable(rows);
		assert.strictEqual(first, 1);
		assert.strictEqual(nextSelectable(rows, first, 1), 3);
		assert.strictEqual(nextSelectable(rows, 3, 1), 1);
		assert.strictEqual(nextSelectable(rows, 1, -1), 3);
		assert.strictEqual(firstSelectable(buildSlashRows(all, gray, 'zzzz', new Set())), -1);
	});
});
