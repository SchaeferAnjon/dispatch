/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which of Claude Code's slash commands the Agents window's slash menu offers.
 *
 *  Claude Code runs a message that starts with `/name` itself, the same as in its terminal, and
 *  its output comes back as a synthetic assistant message (claudeMapSessionEvents.ts shows it).
 *  The live session's list is the SDK's `supportedCommands()`, which mixes commands and skills
 *  under their display names; the init message has every command's canonical name
 *  (`slash_commands`), which of them are skills (`skills`, `plugin:skill` for a plugin's) and which
 *  only make sense in a terminal. A command is a name in `slash_commands` that is not a skill; the
 *  Skills group lists the skills (claudeSlashMenuSkillFilter). Some commands are the menu's own groups here (`/model`, `/mcp`, `/agents`), some
 *  are Dispatch's (`/clear`, `/rename`), some are about the terminal or claude.ai: those stay out.
 *  Everything else, the user's own commands included, is offered. Before the chat's first message
 *  there is no SDK process to ask, so a short list of the built-in ones stands in.
 *--------------------------------------------------------------------------------------------*/

import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { localize } from '../../../../nls.js';
import type { IAgentSlashCommand } from '../../common/agent.js';

/** What the live SDK session reported: every command, and which are skills or terminal-only. */
export interface IClaudeSlashCommandSnapshot {
	readonly commands: readonly SlashCommand[];
	readonly skills: readonly string[];
	/** the init message's `slash_commands`: every command's canonical name, skills included */
	readonly slashCommands: readonly string[];
	readonly terminalCommands: readonly string[];
}

/**
 * Commands the menu does not offer: another group or Dispatch does it (clear, rename, model, mcp,
 * agents, plugin, hooks), or it belongs to the terminal, the claude.ai account or Claude Code's own
 * settings (the slash menu's grey rows say where those went, `dispatch slash`).
 */
const NOT_IN_MENU: ReadonlySet<string> = new Set([
	'clear', 'reset', 'new', 'rename', 'name', 'model', 'mcp', 'agents', 'plugin', 'plugins', 'hooks', 'skills',
	'config', 'settings', 'effort', 'fast', 'color', 'heapdump', 'resume', 'login', 'logout', 'exit', 'quit', 'help',
	'vim', 'statusline', 'permissions', 'memory', 'terminal-setup', 'ide', 'theme', 'add-dir', 'export', 'rewind',
	'feedback', 'bug', 'release-notes', 'upgrade', 'privacy-settings', 'output-style', 'install-github-app',
	'autocompact', 'auto-mode-setup', 'usage-credits', 'extra-usage', 'design', 'design-consent', 'design-revoke',
	'import', 'team-onboarding', 'ultrareview', 'workflow-launch-exec', 'status', 'doctor', 'keybindings',
]);

/** Built-ins that do their work without an argument: choosing them sends them at once. */
const RUNS_AT_ONCE: ReadonlySet<string> = new Set([
	'compact', 'context', 'usage', 'cost', 'stats', 'init', 'security-review', 'recap', 'insights', 'skill-doctor',
	'list-agents', 'reload-skills',
]);

/** Argument hints the SDK leaves empty for commands that need one. */
const ARGUMENT_HINTS: Readonly<Record<string, () => string>> = {
	goal: () => localize('claudeSlash.goalHint', "<condition>"),
};

interface IFallbackCommand {
	readonly name: string;
	readonly description: () => string;
	/** Offered only once the chat has messages. */
	readonly needsHistory?: boolean;
	readonly aliases?: readonly string[];
}

/** Before the first message: Claude Code's built-in commands that work here, in the menu's order. */
const FALLBACK: readonly IFallbackCommand[] = [
	{ name: 'compact', description: () => localize('claudeSlash.compact', "Summarize the conversation to free up context"), needsHistory: true },
	{ name: 'context', description: () => localize('claudeSlash.context', "Show what fills the context window") },
	{ name: 'usage', description: () => localize('claudeSlash.usage', "Show plan usage and when the limits reset"), aliases: ['cost', 'stats'] },
	{ name: 'init', description: () => localize('claudeSlash.init', "Write a CLAUDE.md for this project") },
	{ name: 'security-review', description: () => localize('claudeSlash.securityReview', "Review the changes on this branch for security issues") },
	{ name: 'recap', description: () => localize('claudeSlash.recap', "Summarize what happened in this session"), needsHistory: true },
	{ name: 'goal', description: () => localize('claudeSlash.goal', "Set a goal Claude keeps working toward") },
];

/** The order the menu lists Claude Code's commands in: the everyday ones first, the rest as the SDK lists them. */
const ORDER: readonly string[] = FALLBACK.map(c => c.name);

export function claudeSlashCommandsForMenu(snapshot: IClaudeSlashCommandSnapshot | undefined, hasHistory: boolean): IAgentSlashCommand[] {
	if (!snapshot) {
		return FALLBACK
			.filter(c => hasHistory || !c.needsHistory)
			.map(c => toMenuCommand(c.name, c.description(), '', c.aliases));
	}
	const isSkill = skillMatcher(snapshot.skills);
	// the canonical names of the commands: a skill's display name (`Get笔记` for `getnote`) is not one
	const canonical = snapshot.slashCommands.length ? new Set(snapshot.slashCommands) : undefined;
	const terminal = new Set(snapshot.terminalCommands);
	const out: IAgentSlashCommand[] = [];
	for (const command of snapshot.commands) {
		const name = command.name;
		if (!name || name.startsWith('_') || isSkill(name) || terminal.has(name) || NOT_IN_MENU.has(name) || (canonical && !canonical.has(name))) {
			continue;
		}
		if (!hasHistory && (name === 'compact' || name === 'recap')) {
			continue;
		}
		out.push(toMenuCommand(name, cleanDescription(command.description), command.argumentHint, command.aliases));
	}
	const rank = (name: string) => {
		const i = ORDER.indexOf(name);
		return i < 0 ? ORDER.length : i;
	};
	return out
		.map((command, index) => ({ command, index }))
		.sort((a, b) => rank(a.command.name) - rank(b.command.name) || a.index - b.index)
		.map(x => x.command);
}

/**
 * Which of the SDK's built-in entries (the Customizations' "Built-in" skills, every command the SDK
 * has that is not a file on disk) the Skills group lists: the live session's skills, `docs` for
 * `anthropic-skills:docs` included. Before the first message, the curated built-ins minus the
 * commands (`/init` is a command here, as in Claude Code's own menu).
 */
export function claudeSlashMenuSkillFilter(snapshot: IClaudeSlashCommandSnapshot | undefined): (name: string) => boolean {
	if (snapshot?.skills.length) {
		return skillMatcher(snapshot.skills);
	}
	const commands = new Set([...FALLBACK.map(c => c.name), ...NOT_IN_MENU]);
	return name => !commands.has(name);
}

/** A name the init message lists as a skill, as it is or as a plugin's (`anthropic-skills:docs` for `docs`). */
function skillMatcher(skills: readonly string[]): (name: string) => boolean {
	const names = new Set(skills);
	const tails = new Set(skills.filter(s => s.includes(':')).map(s => s.slice(s.lastIndexOf(':') + 1)));
	return name => names.has(name) || tails.has(name);
}

function toMenuCommand(name: string, description: string, argumentHint: string | undefined, aliases: readonly string[] | undefined): IAgentSlashCommand {
	const hint = argumentHint?.trim() || ARGUMENT_HINTS[name]?.();
	return {
		name,
		description,
		...(hint ? { argumentHint: hint } : {}),
		...(aliases?.length ? { aliases } : {}),
		runsImmediately: RUNS_AT_ONCE.has(name) || !hint,
	};
}

/** The SDK's descriptions sometimes carry a `(user)` / `(project)` source tag in front: keep the sentence. */
function cleanDescription(description: string | undefined): string {
	return (description ?? '').replace(/^\((?:user|project|plugin|built-?in)[^)]*\)\s*/i, '').trim();
}
