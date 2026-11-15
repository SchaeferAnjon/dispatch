/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the agent host's Commands for the slash menu (dispatchSlashCompletions.ts) and
 *  `/clear` (localCommands/clearLocalCommand.ts).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IAgent, IAgentSlashCommand } from '../../common/agent.js';
import { readCompletionAttachmentMeta } from '../../common/meta/agentCompletionAttachmentMeta.js';
import { CompletionItemKind } from '../../common/state/protocol/commands.js';
import { MessageAttachmentKind } from '../../common/state/protocol/state.js';
import { DispatchSlashCompletionProvider } from '../../node/dispatchSlashCompletions.js';
import { AgentHostSkillCompletionProvider } from '../../node/agentHostSkillCompletionProvider.js';
import { SYNCED_CUSTOMIZATION_SCHEME } from '../../common/agentHostFileSystemService.js';
import { CustomizationLoadStatus, CustomizationType, type Customization, type SkillCustomization } from '../../common/state/sessionState.js';
import { isClearCommand } from '../../node/localCommands/clearLocalCommand.js';

suite('dispatchSlashCompletions', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('Skills for an engine session: no Copilot built-ins, no synced copies, no commands of the engine', async () => {
		const skill = (name: string, uri: string): SkillCustomization => ({ type: CustomizationType.Skill, id: uri, uri, name });
		const container = (name: string, uri: string, children: SkillCustomization[], type: CustomizationType.Directory | CustomizationType.Plugin): Customization => (type === CustomizationType.Directory
			? { type, id: uri, uri, name, enabled: true, contents: CustomizationType.Skill, writable: false, load: { kind: CustomizationLoadStatus.Loaded }, children }
			: { type, id: uri, uri, name, load: { kind: CustomizationLoadStatus.Loaded }, children });
		const customizations: Customization[] = [
			container('user', 'file:///u/.claude/skills', [skill('humanizer', 'file:///u/.claude/skills/humanizer/SKILL.md')], CustomizationType.Directory),
			container('VS Code Synced Data', `${SYNCED_CUSTOMIZATION_SCHEME}:/plugins/bundle`, [skill('commit', `${SYNCED_CUSTOMIZATION_SCHEME}:/plugins/bundle/skills/commit/SKILL.md`)], CustomizationType.Plugin),
			container('builtin', 'agent-builtin:/skills', ['docs', 'code-review', 'clear', '1819622649:commit', '1998c3e0a00:notes'].map(n => skill(n, `agent-builtin:/skill/${encodeURIComponent(n)}`)), CustomizationType.Directory),
			// Codex reads the synced bundle from disk as one of its skill folders
			container('codex', 'file:///ud/agentPlugins/vscode-synced-customization-agent-host-codex-5021/1819622649/skills', [skill('fix-ci', 'file:///ud/agentPlugins/vscode-synced-customization-agent-host-codex-5021/1819622649/skills/fix-ci/SKILL.md'), skill('notes', 'file:///ud/agentPlugins/vscode-synced-customization-agent-host-codex-5021/1819622649/skills/notes/SKILL.md')], CustomizationType.Directory),
		];
		const engine = {
			getChatCustomizations: async () => customizations,
			getSlashMenuSkillFilter: async () => (name: string) => name !== 'clear',
		} as unknown as IAgent;
		const skills = disposables.add(new AgentHostSkillCompletionProvider(() => engine));
		const names = async (channel: string) => (await skills.provideCompletionItems({ kind: CompletionItemKind.UserMessage, channel, text: '/', offset: 1 }, CancellationToken.None)).map(i => i.insertText.trim());
		assert.deepStrictEqual(await names('claude:/s1'), ['/humanizer', '/docs', '/code-review', '/notes']);
		// other harnesses keep everything
		assert.deepStrictEqual(await names('copilotcli:/s1'), ['/humanizer', '/commit', '/docs', '/code-review', '/clear', '/1819622649:commit', '/1998c3e0a00:notes', '/fix-ci', '/notes']);
	});

	const commands: IAgentSlashCommand[] = [
		{ name: 'context', description: 'Show what fills the context window', runsImmediately: true },
		{ name: 'goal', description: 'Set a goal', argumentHint: '<condition>', runsImmediately: false },
		{ name: 'herdr', description: 'Herdr panes', isSkill: true },
		{ name: 'clear', description: 'the engine own clear' },
	];
	let lastHasHistory: boolean | undefined;
	const agent = {
		getSlashCommands: async (_chat: unknown, options: { hasHistory: boolean }) => { lastHasHistory = options.hasHistory; return commands; },
		clearChatContext: async () => true,
	} as unknown as IAgent;

	function provider(hasHistory: boolean) {
		return new DispatchSlashCompletionProvider(() => agent, () => hasHistory, channel => channel);
	}

	test('lists the engine commands and /clear once the chat has history, with what choosing does', async () => {
		const items = await provider(true).provideCompletionItems({ kind: CompletionItemKind.UserMessage, channel: 'claude:/s1', text: '/', offset: 1 }, CancellationToken.None);
		assert.strictEqual(lastHasHistory, true);
		assert.deepStrictEqual(items.map(i => i.insertText), ['/clear ', '/context ', '/goal ', '/herdr ']);
		const meta = (i: number) => {
			const attachment = items[i].attachment;
			return attachment.type === MessageAttachmentKind.Simple ? readCompletionAttachmentMeta(attachment) : undefined;
		};
		const clear = meta(0);
		assert.strictEqual(clear?.kind === 'command' ? clear.dispatchAction : undefined, 'run');
		const goal = meta(2);
		assert.ok(goal?.kind === 'command' && goal.dispatchAction === 'insert' && goal.argumentHint === '<condition>');
		const herdr = meta(3);
		assert.ok(herdr?.kind === 'command' && herdr.isSkill === true);
	});

	test('no /clear before the first message; only the leading token', async () => {
		const items = await provider(false).provideCompletionItems({ kind: CompletionItemKind.UserMessage, channel: 'codex:/s1', text: '/c', offset: 2 }, CancellationToken.None);
		assert.deepStrictEqual(items.map(i => i.insertText), ['/context ']);
		assert.deepStrictEqual(await provider(true).provideCompletionItems({ kind: CompletionItemKind.UserMessage, channel: 'codex:/s1', text: 'hi /c', offset: 5 }, CancellationToken.None), []);
	});

	test('/clear is the whole first word', () => {
		assert.ok(isClearCommand('/clear'));
		assert.ok(isClearCommand('/clear name'));
		assert.ok(!isClearCommand('/clearance'));
		assert.ok(!isClearCommand('please /clear'));
	});
});
