/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a turn started with a skill's slash command reads as that command after a restart
 *  (kanban task-wkq5g). OpenCode runs `/neat-freak` by sending the whole skill file as the user's
 *  message, followed by the line that names the skill's folder (packages/opencode/src/command/index.ts:
 *  "Base directory for this skill: …") and anything typed after the command. `session/load` replays
 *  that message, so the chat showed a skill file of 200 lines in place of what the person typed.
 *  Pure functions: tests/opencode-skill-turn.test.mjs loads this file as it is.
 *--------------------------------------------------------------------------------------------*/

const SKILL_TAIL = /\n*Base directory for this skill: ([^\n]+)\nRelative paths in this skill \(e\.g\., scripts\/, references\/\) are relative to this base directory\.(?:\n+([\s\S]*))?$/;

export interface IOpenCodeSkillTurn {
	/** the skill's name: its folder's name */
	readonly name: string;
	/** what the person typed after `/name`, if anything */
	readonly args: string;
}

/** The skill command a replayed user message came from, or undefined for a message the person typed. */
export function openCodeSkillTurn(text: string): IOpenCodeSkillTurn | undefined {
	const m = SKILL_TAIL.exec(text);
	if (!m) {
		return undefined;
	}
	const dir = m[1].trim().replace(/[\\/]+$/, '');
	const name = dir.split(/[\\/]/).pop() ?? '';
	if (!name || !/^[\w.:-]+$/.test(name)) {
		return undefined;
	}
	return { name, args: (m[2] ?? '').trim() };
}

/** What the chat shows for a user message: `/name args` for a skill's expansion, else the text itself. */
export function openCodeUserText(text: string): string {
	const skill = openCodeSkillTurn(text);
	return skill ? `/${skill.name}${skill.args ? ' ' + skill.args : ''}` : text;
}
