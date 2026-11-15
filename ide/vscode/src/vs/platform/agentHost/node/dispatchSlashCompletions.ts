/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Commands group of the Agents window's slash menu, from the agent host. For a
 *  Claude Code, Codex or OpenCode session: the engine's own commands (IAgent.getSlashCommands: Claude
 *  Code's SDK list, Codex's commands Dispatch maps to app-server requests, OpenCode's ACP list, which
 *  also carries its skills) and Dispatch's `/clear` (localCommands/clearLocalCommand.ts). Each item
 *  says in `_meta.dispatchAction` whether choosing it runs at once or waits for an argument.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import type { IAgent, IAgentSlashCommand } from '../common/agent.js';
import { toCommandCompletionAttachmentMeta } from '../common/meta/agentCompletionAttachmentMeta.js';
import { CompletionItem, CompletionItemKind, CompletionsParams } from '../common/state/protocol/commands.js';
import { MessageAttachmentKind } from '../common/state/protocol/state.js';
import { isAhpChatChannel, parseRequiredSessionUriFromChatUri } from '../common/state/sessionState.js';
import { CompletionTriggerCharacter, IAgentHostCompletionItemProvider } from './agentHostCompletions.js';
import { extractLeadingSlashToken, ILeadingSlashToken, matchesSlashCompletion } from './agentHostSlashCompletion.js';
import { CLEAR_SLASH_COMMAND } from './localCommands/clearLocalCommand.js';

export class DispatchSlashCompletionProvider implements IAgentHostCompletionItemProvider {
	readonly kinds: ReadonlySet<CompletionItemKind> = new Set([CompletionItemKind.UserMessage]);
	readonly triggerCharacters = [CompletionTriggerCharacter.Slash] as const;

	constructor(
		private readonly _getAgent: (session: string) => IAgent | undefined,
		private readonly _hasHistory: (channel: string) => boolean,
		/** The agent's chat for a completion channel: a peer chat's channel, or the session's default chat. */
		private readonly _chatOf: (channel: string) => string,
	) { }

	async provideCompletionItems(params: CompletionsParams, token: CancellationToken): Promise<readonly CompletionItem[]> {
		const leading = extractLeadingSlashToken(params.text, params.offset);
		if (!leading) {
			return [];
		}
		const channel = params.channel.toString();
		const session = isAhpChatChannel(channel) ? parseRequiredSessionUriFromChatUri(channel) : channel;
		const agent = this._getAgent(session);
		if (!agent || (!agent.getSlashCommands && !agent.clearChatContext)) {
			return [];
		}
		const items: CompletionItem[] = [];
		const hasHistory = this._hasHistory(channel);
		if (agent.clearChatContext && hasHistory && matchesSlashCompletion(leading.typed, CLEAR_SLASH_COMMAND)) {
			items.push(toItem(leading, {
				name: CLEAR_SLASH_COMMAND,
				description: localize('dispatchSlash.clear', "Clear the model's context. The messages above stay on screen"),
				runsImmediately: true,
			}));
		}
		if (agent.getSlashCommands) {
			let commands: readonly IAgentSlashCommand[] = [];
			try {
				commands = await agent.getSlashCommands(URI.parse(this._chatOf(channel)), { hasHistory });
			} catch {
				commands = [];
			}
			if (token.isCancellationRequested) {
				return [];
			}
			const seen = new Set(items.map(i => i.insertText));
			for (const command of commands) {
				if (command.name === CLEAR_SLASH_COMMAND) {
					continue; // Dispatch's own, above
				}
				if (!matchesSlashCompletion(leading.typed, command.name) && !command.aliases?.some(alias => matchesSlashCompletion(leading.typed, alias))) {
					continue;
				}
				const item = toItem(leading, command);
				if (!seen.has(item.insertText)) {
					seen.add(item.insertText);
					items.push(item);
				}
			}
		}
		return items;
	}
}

function toItem(leading: ILeadingSlashToken, command: IAgentSlashCommand): CompletionItem {
	const runs = command.runsImmediately ?? !command.argumentHint;
	return {
		insertText: `/${command.name} `,
		rangeStart: leading.rangeStart,
		rangeEnd: leading.rangeEnd,
		attachment: {
			type: MessageAttachmentKind.Simple,
			label: `/${command.name}`,
			_meta: toCommandCompletionAttachmentMeta({
				command: command.name,
				description: command.description,
				...(command.isSkill ? { isSkill: true } : {}),
				...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
				dispatchAction: runs ? 'run' : 'insert',
			}),
		},
	};
}
