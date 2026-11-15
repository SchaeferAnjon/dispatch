/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { SYNCED_CUSTOMIZATION_SCHEME } from '../common/agentHostFileSystemService.js';
import { AGENT_BUILTIN_CUSTOMIZATION_SCHEME } from '../common/agentHostCustomizationUri.js';
import { AgentSession, type IAgent } from '../common/agent.js';
import { isCustomizationEnabled, isSkillEligibleForUserInvocation } from '../common/customizationEnablement.js';
import { CompletionItem, CompletionItemKind, CompletionsParams } from '../common/state/protocol/commands.js';
import { MessageAttachmentKind } from '../common/state/protocol/state.js';
import { toSkillCompletionAttachmentMeta } from '../common/meta/agentCompletionAttachmentMeta.js';
import { buildDefaultChatUri, CustomizationType, DirectoryCustomization, PluginCustomization, SkillCustomization, type Customization } from '../common/state/sessionState.js';
import { CompletionTriggerCharacter, IAgentHostCompletionItemProvider } from './agentHostCompletions.js';
import { extractWhitespaceDelimitedSlashToken, matchesSlashCompletion } from './agentHostSlashCompletion.js';


/**
 * Generic completion provider that contributes slash completions for skills
 * exposed through an agent's global and session-effective customizations.
 */
export class AgentHostSkillCompletionProvider extends Disposable implements IAgentHostCompletionItemProvider {

	readonly kinds: ReadonlySet<CompletionItemKind> = new Set([CompletionItemKind.UserMessage]);
	readonly triggerCharacters = [CompletionTriggerCharacter.Slash] as const;

	constructor(
		private readonly _getAgent: (session: URI | string) => IAgent | undefined,
		/**
		 * The owning session's last host-published customization snapshot.
		 * Supplied by Agent Host so the provider hands it to
		 * `getChatCustomizations` explicitly instead of the agent reading it
		 * from shared host state. `undefined` when the host has published no
		 * snapshot for the session yet.
		 */
		private readonly _getHostCustomizations: (session: URI | string) => readonly Customization[] | undefined = () => undefined,
	) {
		super();
	}

	async provideCompletionItems(params: CompletionsParams, token: CancellationToken): Promise<readonly CompletionItem[]> {
		const leading = extractWhitespaceDelimitedSlashToken(params.text, params.offset);
		if (!leading) {
			return [];
		}

		const sessionUri = typeof params.channel === 'string' ? URI.parse(params.channel) : params.channel;
		const agent = this._getAgent(sessionUri);
		if (!agent) {
			return [];
		}
		const provider = AgentSession.provider(sessionUri);
		const dispatchEngine = provider === 'claude' || provider === 'codex' || provider === 'opencode';
		let candidates = await this._getCandidates(agent, sessionUri);
		if (dispatchEngine) {
			// Dispatch IDE: the Agents window's own skills (Fix Checks, Create PR, ...) are synced to every
			// harness; they drive GitHub Copilot's Changes toolbar and are not skills of these engines. The
			// engine lists its copy of a synced bundle again under the bundle's hashed folder name
			// (`1819622649:commit`), and its built-in entries mix commands with skills (Claude Code's
			// `/clear`, `/config`): the slash menu has the commands in their own group.
			const isMenuSkill = await agent.getSlashMenuSkillFilter?.(URI.parse(buildDefaultChatUri(sessionUri)));
			candidates = candidates.filter(skill => {
				// the synced bundle itself, or its copy on disk that an engine reads as a skill folder (Codex)
				if (COPILOT_BUILTIN_SKILLS.has(skill.name) && (skill.synced || SYNCED_BUNDLE_FOLDER.test(skill.uri))) {
					return false;
				}
				if (!skill.uri.startsWith(`${AGENT_BUILTIN_CUSTOMIZATION_SCHEME}:`)) {
					return true;
				}
				return !SYNCED_COPY_NAME.test(skill.name) && (!isMenuSkill || isMenuSkill(skill.name));
			});
		}
		if (token.isCancellationRequested || candidates.length === 0) {
			return [];
		}

		// `/abc` → typed = 'abc'; empty after just '/' → typed = ''.
		const typed = leading.typed;
		// A skill's synced-bundle copy has a different URI than its on-disk file, so dedupe by name + description, not URI.
		const skillsSeen = new Set<string>();
		return candidates
			.filter(skill => {
				const identity = `${skill.slashCommandName}\0${skill.description ?? ''}`;
				if (matchesSlashCompletion(typed, skill.slashCommandName) && !skillsSeen.has(identity)) {
					skillsSeen.add(identity);
					return true;
				}
				return false;
			})
			.map(skill => ({
				insertText: '/' + skill.slashCommandName + ' ',
				rangeStart: leading.rangeStart,
				rangeEnd: leading.rangeEnd,
				attachment: {
					type: MessageAttachmentKind.Simple,
					label: '/' + skill.slashCommandName,
					_meta: toSkillCompletionAttachmentMeta({
						uri: skill.uri,
						name: skill.name,
						displayName: skill.slashCommandName,
						description: skill.description,
					}),
				},
			}));
	}

	private async _getCandidates(agent: IAgent, session: URI): Promise<readonly SlashCommmandCandidate[]> {
		const chat = URI.parse(buildDefaultChatUri(session));
		const customizations = await agent.getChatCustomizations(chat, { configurationResource: session, resource: session }, this._getHostCustomizations(session));
		const result: SlashCommmandCandidate[] = [];
		for (const c of customizations) {
			if (c.type === CustomizationType.McpServer || (c.type === CustomizationType.Plugin ? !isCustomizationEnabled(c) : !c.enabled) || !c.children) {
				continue;
			}
			for (const child of c.children) {
				if (child.type === CustomizationType.Skill && isSkillEligibleForUserInvocation(child)) {
					result.push(this._toSlashCommandCandidate(c, child));
				}
			}
		}
		return result;
	}

	private _toSlashCommandCandidate(container: PluginCustomization | DirectoryCustomization, skill: SkillCustomization): SlashCommmandCandidate {
		// see getCanonicalPluginCommandId
		let slashCommandName = skill.name;
		if (container.type === CustomizationType.Plugin && !isSyncedCustomization(container) && skill.name !== container.name) {
			slashCommandName = `${container.name}:${skill.name}`;
		}
		return {
			slashCommandName: slashCommandName,
			name: skill.name,
			description: skill.description,
			uri: skill.uri,
			synced: container.uri.startsWith(SYNCED_CUSTOMIZATION_SCHEME + ':'),
		};
	}
}

function isSyncedCustomization(container: PluginCustomization): boolean {
	return container.uri.startsWith(SYNCED_CUSTOMIZATION_SCHEME + ':');
}

interface SlashCommmandCandidate {
	readonly slashCommandName: string;
	readonly name: string;
	readonly description: string | undefined;
	readonly uri: string;
	/** From the workbench's synced bundle, not the engine's own folders. */
	readonly synced: boolean;
}

/** Dispatch IDE: an engine's own name for a skill of a synced bundle: the bundle's folder is a content hash. */
const SYNCED_COPY_NAME = /^(?:\d+|[0-9a-f]{8,}):/i;

/** Dispatch IDE: where the agent host writes a synced bundle for an engine (agentPlugins/vscode-synced-customization-…/). */
const SYNCED_BUNDLE_FOLDER = /\/vscode-synced-customization-[^/]+\//;

/** Dispatch IDE: the skills in src/vs/sessions/skills (the Agents window's Changes toolbar and Run button). */
const COPILOT_BUILTIN_SKILLS: ReadonlySet<string> = new Set([
	'act-on-feedback', 'code-review', 'commit', 'create-draft-pr', 'create-pr', 'fix-ci', 'generate-run-commands',
	'merge', 'merge-changes', 'sync', 'sync-upstream', 'troubleshoot', 'update-pr', 'update-skills',
]);
