/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which Claude Code commands the slash menu offers (claudeSlashCommands.ts), and the
 *  transcript system lines a restore reads back (claudeTranscriptSystemLines.ts).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { ResponsePartKind } from '../../../common/state/sessionState.js';
import { claudeSlashCommandsForMenu, claudeSlashMenuSkillFilter } from '../../../node/claude/claudeSlashCommands.js';
import { claudeTranscriptPath, withTranscriptSystemLines } from '../../../node/claude/claudeTranscriptSystemLines.js';
import { mapSessionMessagesToTurns } from '../../../node/claude/claudeReplayMapper.js';

function sdkCommand(name: string, argumentHint = '', description = `${name} description`, aliases?: string[]) {
	return { name, description, argumentHint, ...(aliases ? { aliases } : {}) };
}

suite('claudeSlashCommands', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('before the first message: the built-in commands that work here', () => {
		assert.deepStrictEqual(claudeSlashCommandsForMenu(undefined, false).map(c => c.name), ['context', 'usage', 'init', 'security-review', 'goal']);
		const withHistory = claudeSlashCommandsForMenu(undefined, true);
		assert.deepStrictEqual(withHistory.map(c => c.name), ['compact', 'context', 'usage', 'init', 'security-review', 'recap', 'goal']);
		assert.strictEqual(withHistory.find(c => c.name === 'compact')?.runsImmediately, true);
		const goal = withHistory.find(c => c.name === 'goal');
		assert.strictEqual(goal?.runsImmediately, false);
		assert.ok(goal?.argumentHint);
		assert.deepStrictEqual(withHistory.find(c => c.name === 'usage')?.aliases, ['cost', 'stats']);
	});

	test('the live list: skills, terminal commands and what other parts of the window do stay out', () => {
		const snapshot = {
			commands: [
				sdkCommand('dataviz'), sdkCommand('doctor'), sdkCommand('clear', '[name]'), sdkCommand('compact', '<optional custom summarization instructions>'),
				sdkCommand('context'), sdkCommand('model', '<model>'), sdkCommand('mcp'), sdkCommand('color'), sdkCommand('usage', '', 'Show usage', ['cost', 'stats']),
				sdkCommand('__remote-workflow'), sdkCommand('save-session', '[alias]', '(user) Save current session state'), sdkCommand('list-sessions'),
				sdkCommand('goal'), sdkCommand('recap'), sdkCommand('rename', '[name]'), sdkCommand('insights'),
			],
			skills: ['dataviz', 'doctor'],
			slashCommands: [],
			terminalCommands: ['doctor', 'color'],
		};
		const menu = claudeSlashCommandsForMenu(snapshot, true);
		assert.deepStrictEqual(menu.map(c => c.name), ['compact', 'context', 'usage', 'recap', 'goal', 'save-session', 'list-sessions', 'insights']);
		const save = menu.find(c => c.name === 'save-session')!;
		assert.strictEqual(save.description, 'Save current session state');
		assert.strictEqual(save.argumentHint, '[alias]');
		assert.strictEqual(save.runsImmediately, false);
		assert.strictEqual(menu.find(c => c.name === 'list-sessions')?.runsImmediately, true);
		assert.strictEqual(menu.find(c => c.name === 'compact')?.runsImmediately, true);
		assert.deepStrictEqual(menu.find(c => c.name === 'usage')?.aliases, ['cost', 'stats']);
		// no history yet: nothing to compact or recap
		assert.ok(!claudeSlashCommandsForMenu(snapshot, false).some(c => c.name === 'compact' || c.name === 'recap'));
	});

	test('the live list by canonical names: a skill under its display name or a plugin\'s name is no command', () => {
		const snapshot = {
			commands: [
				sdkCommand('context'), sdkCommand('Get笔记'), sdkCommand('docs'), sdkCommand('init'), sdkCommand('security-review'),
				sdkCommand('list-sessions'), sdkCommand('code-review'), sdkCommand('1819622649:commit'), sdkCommand('clear'),
			],
			// the init message: canonical names, skills as `plugin:skill`
			skills: ['getnote', 'anthropic-skills:docs', 'code-review', '1819622649:commit'],
			slashCommands: ['context', 'getnote', 'anthropic-skills:docs', 'init', 'security-review', 'list-sessions', 'code-review', '1819622649:commit', 'clear'],
			terminalCommands: [],
		};
		assert.deepStrictEqual(claudeSlashCommandsForMenu(snapshot, false).map(c => c.name), ['context', 'init', 'security-review', 'list-sessions']);

		const isSkill = claudeSlashMenuSkillFilter(snapshot);
		assert.deepStrictEqual(['docs', 'code-review', '1819622649:commit', 'clear', 'init', 'context', 'config'].filter(isSkill), ['docs', 'code-review', '1819622649:commit']);
	});

	test('before the first message the curated built-ins are skills except the commands', () => {
		const isSkill = claudeSlashMenuSkillFilter(undefined);
		assert.deepStrictEqual(['init', 'review', 'security-review', 'code-review', 'simplify', 'clear', 'config'].filter(isSkill), ['review', 'code-review', 'simplify']);
	});

	test('a restore reads back what local commands printed', async () => {
		const messages = [
			{ type: 'user', uuid: 'u1', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>' } },
			{ type: 'system', uuid: 'x1', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: undefined },
			{ type: 'user', uuid: 'u2', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: '<command-message>doctor</command-message>\n<command-name>/doctor</command-name>' } },
			{ type: 'assistant', uuid: 'a2', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Checking your setup' }] } },
		] as unknown as SessionMessage[];
		const transcript = [
			JSON.stringify({ type: 'system', subtype: 'local_command', uuid: 'x1', content: '<local-command-stdout>## Context Usage\n\nTokens: 12k</local-command-stdout>' }),
			JSON.stringify({ type: 'user', uuid: 'u1' }),
			'{"type":"system", broken',
		].join('\n');
		const filled = await withTranscriptSystemLines(messages, async () => transcript);
		assert.deepStrictEqual((filled[1] as { message: unknown }).message, { subtype: 'local_command', text: '<local-command-stdout>## Context Usage\n\nTokens: 12k</local-command-stdout>' });

		const turns = mapSessionMessagesToTurns(filled, URI.parse('claude:/s'), new NullLogService());
		assert.deepStrictEqual(turns.map(t => t.message.text), ['/context', '/doctor']);
		const context = turns[0].responseParts.find(p => p.kind === ResponsePartKind.Markdown);
		assert.strictEqual(context && 'content' in context ? context.content : undefined, '## Context Usage\n\nTokens: 12k');
		assert.ok(turns[1].responseParts.some(p => p.kind === ResponsePartKind.Markdown && p.content.includes('Checking your setup')));
	});

	test('nothing to read back: the messages come through unchanged', async () => {
		const messages = [{ type: 'user', uuid: 'u1', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: 'hi' } }] as unknown as SessionMessage[];
		let read = false;
		assert.strictEqual(await withTranscriptSystemLines(messages, async () => { read = true; return ''; }), messages);
		assert.strictEqual(read, false);
	});

	test('the transcript file sits under the config folder by the working directory', () => {
		assert.strictEqual(claudeTranscriptPath('/Users/me/.claude/', '/tmp/a.b/c', 'abc'), '/Users/me/.claude/projects/-tmp-a-b-c/abc.jsonl');
	});
});
