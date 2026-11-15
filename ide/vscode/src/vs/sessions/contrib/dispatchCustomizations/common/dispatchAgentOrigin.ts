/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where a sub-agent comes from (kanban preferences「内置和自己的分开」「Dispatch 自带算内置」). The
 *  sub-agent menu and Customizations > Sub-agents both ask agentOrigin, so they never disagree.
 *
 *  - engine: the engine ships it and there is no file anyone can edit; the agent host gives it an `<engine>-internal:`
 *    address (Claude Code's Explore, Plan, claude, claude-code-guide: claudeSessionCustomizationDiscovery.ts
 *    nonEditableUri), and before a session starts its curated stand-in says "(Built-In)".
 *  - dispatch: Dispatch's own unchanged copy of one of the helper agents it ships (agent/agents in the repository,
 *    installed into ~/.dispatch/agents by `dispatch builtin-agents`). The caller says which files those are
 *    (dispatchBuiltinAgentsModel.ts builtinAgentFor, from the CLI's list); a copy the person edited is theirs.
 *  - custom: any other file someone wrote: ~/.claude/agents (linked to ~/.dispatch/agents), a project's .claude/agents.
 *  The first two are Built-In. No names are listed here. No imports: ide/tests runs it on its own.
 *--------------------------------------------------------------------------------------------*/

const BUILTIN_DESCRIPTION = /^\(Built-In\)\s*/;

export type AgentOrigin = 'engine' | 'dispatch' | 'custom';

/** True for an agent the engine itself ships: `uri` its address (a mode's id), `description` what it says it does. */
export function isEngineBuiltinAgent(uri: string, description?: string): boolean {
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1] ?? '';
	return scheme.toLowerCase().endsWith('-internal') || BUILTIN_DESCRIPTION.test(description ?? '');
}

/** The file on this Mac a `file:` address names, or undefined for any other address. */
export function localPathOf(uri: string): string | undefined {
	const m = /^file:\/\/[^/]*(\/.*)$/i.exec(uri);
	return m ? decodeURIComponent(m[1]) : undefined;
}

/** Where the agent at `uri` comes from; `isDispatchCopy` says whether a file on this Mac is Dispatch's copy. */
export function agentOrigin(uri: string, description: string | undefined, isDispatchCopy?: (path: string) => boolean): AgentOrigin {
	if (isEngineBuiltinAgent(uri, description)) {
		return 'engine';
	}
	const path = localPathOf(uri);
	return path !== undefined && isDispatchCopy?.(path) ? 'dispatch' : 'custom';
}

/** The description without the "(Built-In)" the curated stand-ins start with. */
export function withoutBuiltinPrefix(description: string | undefined): string | undefined {
	return description?.replace(BUILTIN_DESCRIPTION, '');
}

/** The agents split into the built-in ones (the engine's, then Dispatch's) and the ones someone wrote, each group in
 *  the order given. */
export function splitAgentsByOrigin<T>(agents: readonly T[], origin: (agent: T) => { readonly uri: string; readonly description?: string }, isDispatchCopy?: (path: string) => boolean): { readonly builtin: T[]; readonly custom: T[] } {
	const engine: T[] = [];
	const dispatch: T[] = [];
	const custom: T[] = [];
	for (const agent of agents) {
		const { uri, description } = origin(agent);
		const where = agentOrigin(uri, description, isDispatchCopy);
		(where === 'engine' ? engine : where === 'dispatch' ? dispatch : custom).push(agent);
	}
	return { builtin: [...engine, ...dispatch], custom };
}
