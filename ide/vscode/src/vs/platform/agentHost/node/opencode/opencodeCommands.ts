/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's slash commands for the Agents window's slash menu. OpenCode sends its
 *  command list itself (ACP `available_commands_update`, name and description only): its built-ins
 *  (`/init`, `/review`), the commands of its plugins and of the person, MCP prompts, and skills (its
 *  own, and the person's Claude Code skills a plugin loads as commands, "(user - Skill)"). A message
 *  that starts with `/name` goes to OpenCode unchanged and OpenCode runs it; nothing is rewritten here.
 *  The process's own HTTP server (`GET /command`) says which entries are skills or MCP prompts.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import type { IAgentSlashCommand } from '../../common/agent.js';

/** One entry of ACP's `available_commands_update` (`{ name, description, input?: { hint } }`). */
export interface IAcpAvailableCommand {
	readonly name: string;
	readonly description: string;
	readonly hint?: string;
}

/** What `GET /command` adds for a name: where it comes from. */
export type OpenCodeCommandSource = 'command' | 'skill' | 'mcp' | string;

export function readAvailableCommands(value: unknown): IAcpAvailableCommand[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: IAcpAvailableCommand[] = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const c = item as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
		if (typeof c.name !== 'string' || !c.name) {
			continue;
		}
		const hint = c.input && typeof c.input.hint === 'string' ? c.input.hint : undefined;
		out.push({ name: c.name, description: typeof c.description === 'string' ? c.description : '', ...(hint ? { hint } : {}) });
	}
	return out;
}

/** Commands that take what follows them, and what to type there. */
const ARGUMENT_HINTS: Readonly<Record<string, () => string>> = {
	review: () => localize('opencodeSlash.reviewHint', "[commit | branch | pr]"),
	refactor: () => localize('opencodeSlash.refactorHint', "<what to refactor>"),
	'ralph-loop': () => localize('opencodeSlash.taskHint', "<task>"),
	'ulw-loop': () => localize('opencodeSlash.taskHint2', "<task>"),
	'resume-session': () => localize('opencodeSlash.aliasHint', "<alias>"),
	'save-session': () => localize('opencodeSlash.aliasHint2', "[alias]"),
};

/** OpenCode's own `/compact` works over ACP but newer versions leave it out of the list. */
const COMPACT: IAcpAvailableCommand = { name: 'compact', description: 'compact the session' };

export function openCodeSlashCommandsForMenu(list: readonly IAcpAvailableCommand[], sources: ReadonlyMap<string, OpenCodeCommandSource> | undefined, hasHistory: boolean): IAgentSlashCommand[] {
	const out: IAgentSlashCommand[] = [];
	const seen = new Set<string>();
	const all = hasHistory && !list.some(c => c.name === COMPACT.name) ? [...list, COMPACT] : list;
	for (const command of all) {
		const name = command.name;
		// the synced copies of the Agents window's own skills under ~/.claude/skills/synced: duplicates
		if (seen.has(name) || name.startsWith('synced/') || (!hasHistory && name === COMPACT.name)) {
			continue;
		}
		seen.add(name);
		const tag = /^\((?<tag>[^)]*)\)\s*/.exec(command.description);
		const description = (tag ? command.description.slice(tag[0].length) : command.description).trim();
		const source = sources?.get(name);
		const isSkill = source === 'skill' || /skill/i.test(tag?.groups?.tag ?? '');
		const hint = command.hint?.trim() || ARGUMENT_HINTS[name]?.();
		out.push({
			name,
			description: name === COMPACT.name ? localize('opencodeSlash.compact', "Summarize the session to free up context") : capitalize(description),
			...(hint ? { argumentHint: hint } : {}),
			...(isSkill ? { isSkill: true } : {}),
			runsImmediately: !isSkill && !hint,
		});
	}
	return out;
}

function capitalize(text: string): string {
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
