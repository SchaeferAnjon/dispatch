/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which coding agents the person uses (kanban app/cli/agents_catalog.py is what it asks).
 *
 *  Dispatch wraps the official agent CLIs. The CLI looks for every one it knows by name on this Mac
 *  (`dispatch engines detect`) and keeps the choice in DISPATCH_DIR/agents.json:
 *    - the agents Dispatch can run (Claude Code, Codex, OpenCode) are on until turned off, so one
 *      installed later shows up by itself;
 *    - every other agent found is off until turned on, and Dispatch cannot start sessions with it yet.
 *  No imports in here: the wizard, Customizations and the node tests use it.
 *--------------------------------------------------------------------------------------------*/

/** One row of `dispatch engines detect` (kanban app/cli/onboarding.py agent_rows). */
export interface IAgentRow {
	readonly id: string;
	readonly name: string;
	readonly installed: boolean;
	readonly path: string;
	/** One plain sentence: who makes it, what it costs or needs. */
	readonly about: string;
	readonly version: string;
	readonly account: string;
	readonly install: string;
	/** Dispatch can start sessions with it (the agent host has it). */
	readonly runnable: boolean;
	readonly enabled: boolean;
	/** The agent a new session starts with: the saved default, else the first one of Dispatch's that is here and on. */
	readonly is_default: boolean;
	readonly sessions: number | null;
}

/** The saved choice: `off` the agents Dispatch runs that are turned off, `on` the other agents turned on. */
export interface IAgentChoice {
	readonly off: readonly string[];
	readonly on: readonly string[];
	/** The agent a new session starts with ('' = none chosen: the first one that is on). */
	readonly default: string;
	readonly saved: boolean;
	/** Which of the agents Dispatch runs are on this Mac (`dispatch engines enabled`); unknown from an older CLI. */
	readonly installed?: readonly string[];
	/** The agent a new session really starts with: the saved default while it is here and on, else the first here and on ('' = none here). */
	readonly effective?: string;
}

/** The agents Dispatch can start sessions with; their ids are the agent host's provider ids. */
export const RUNNABLE_AGENTS: readonly string[] = ['claude', 'codex', 'opencode'];

/** The one short line for an agent Dispatch cannot start sessions with. */
export const NOT_RUNNABLE = 'Dispatch cannot start sessions with it yet.';

/** The agents the person sees in a list: Dispatch's own three always, the others when found. */
export function listedAgents(rows: readonly IAgentRow[]): readonly IAgentRow[] {
	return rows.filter(r => r.runnable || r.installed);
}

/** The two lists to save when one agent is switched, from the rows as they stand. */
export function choiceAfterToggle(rows: readonly IAgentRow[], id: string, enabled: boolean): { off: string[]; on: string[] } {
	const on = (r: IAgentRow) => r.id === id ? enabled : r.enabled;
	return {
		off: rows.filter(r => r.runnable && !on(r)).map(r => r.id),
		on: rows.filter(r => !r.runnable && on(r)).map(r => r.id),
	};
}

/** Switching this agent off would leave none of the agents Dispatch runs on. */
export function isLastRunnable(rows: readonly IAgentRow[], id: string): boolean {
	const row = rows.find(r => r.id === id);
	return !!row && row.runnable && row.enabled && rows.filter(r => r.runnable && r.enabled).length === 1;
}

/** `choice` as the host sees it: is the agent host's provider `id` offered for a new session? Everything is while nothing is known. */
export function isProviderEnabled(choice: IAgentChoice | undefined, id: string): boolean {
	if (!choice) {
		return true;
	}
	if (choice.off.includes(id)) {
		return false;
	}
	// one of Dispatch's agents that is not on this Mac is not offered while another one is: a new Mac with only
	// OpenCode started every new session on Claude Code, which was not there to answer (kanban task-6vw2). With
	// none here they all stay, and the new-session page says to install one (dispatchNoAgent.contribution.ts).
	const here = choice.installed;
	return !(here && here.length && RUNNABLE_AGENTS.includes(id) && !here.includes(id));
}

/** None of the agents Dispatch runs is on this Mac (false while that is not known). */
export function noAgentInstalled(choice: IAgentChoice | undefined): boolean {
	return !!choice?.installed && choice.installed.length === 0;
}

/** The agent a new session starts with: the chosen one while it is still here and on, else the first of `ids` (the agents of Dispatch's that are here and on, in order). */
export function effectiveDefault(ids: readonly string[], chosen: string): string {
	return ids.includes(chosen) ? chosen : ids[0] ?? '';
}

/** `rows` with `is_default` worked out again from `enabled` and the chosen default (as agents_catalog.py with_choice does). */
export function recomputeDefault(rows: readonly IAgentRow[], chosen: string): IAgentRow[] {
	const here = rows.filter(r => r.runnable && r.installed && r.enabled).map(r => r.id);
	const dflt = effectiveDefault(here, chosen);
	return rows.map(r => ({ ...r, is_default: r.id === dflt }));
}

/** What the wizard saves: the Dispatch-run agents the person unticked, the other agents they ticked, and the default they set ('' = none). */
export function wizardChoice(rows: readonly IAgentRow[], engineOff: ReadonlySet<string>, agentOn: ReadonlySet<string>, chosenDefault = ''): { off: string[]; on: string[]; default: string } {
	const here = rows.filter(r => r.runnable && r.installed && !engineOff.has(r.id)).map(r => r.id);
	return {
		default: here.includes(chosenDefault) ? chosenDefault : '',
		off: rows.filter(r => r.runnable && r.installed && engineOff.has(r.id)).map(r => r.id),
		on: rows.filter(r => !r.runnable && r.installed && agentOn.has(r.id)).map(r => r.id),
	};
}
