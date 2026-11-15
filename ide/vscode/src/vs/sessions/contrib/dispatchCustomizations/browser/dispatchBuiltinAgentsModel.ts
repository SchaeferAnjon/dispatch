/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what Settings > Sub-agents says about the helper agents that come with Dispatch, and which file
 *  in the list is one of Dispatch's copies. No DOM: tests/builtin-agents.test.mjs loads it as it is.
 *--------------------------------------------------------------------------------------------*/

const ENGINE_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

export interface BuiltinAgent {
	name: string;
	description: string;
	enabled: boolean;
	builtin: boolean;
	path: string;
	yours: string[];
	engines: Record<string, { state: 'current' | 'update' | 'yours' | 'removed' | 'missing'; path: string }>;
}

export const isDispatchsCopy = (state: string) => state === 'current' || state === 'update';

/** The engines Dispatch's copy of `agent` is in place for, and the ones where something else is used. */
export function builtinAgentStatus(agent: BuiltinAgent): string {
	const label = (e: string) => ENGINE_LABELS[e] ?? e;
	const engines = Object.entries(agent.engines);
	if (!agent.enabled) {
		return `Off. Turn it on to add it to ${engines.map(([e]) => label(e)).join(', ')}.`;
	}
	const parts: string[] = [];
	const ours = engines.filter(([, v]) => isDispatchsCopy(v.state)).map(([e]) => label(e));
	if (ours.length) { parts.push(`For ${ours.join(', ')}`); }
	const yours = engines.filter(([, v]) => v.state === 'yours').map(([e]) => label(e));
	if (yours.length) { parts.push(`your own ${agent.name} is kept for ${yours.join(', ')}`); }
	const removed = engines.filter(([, v]) => v.state === 'removed').map(([e]) => label(e));
	if (removed.length) { parts.push(`you deleted it from ${removed.join(', ')}`); }
	const text = parts.join(' · ');
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The helper agent a listed file is Dispatch's unchanged copy of (Claude Code lists ~/.claude/agents, which links to
 *  ~/.dispatch/agents), or undefined: a file of yours with the same name is not one. */
export function builtinAgentFor(fsPath: string, agents: readonly BuiltinAgent[] | undefined): BuiltinAgent | undefined {
	return agents?.find(a => a.enabled && Object.values(a.engines).some(v => isDispatchsCopy(v.state) && (v.path === fsPath
		|| (!!a.engines.claude && isDispatchsCopy(a.engines.claude.state) && fsPath.endsWith(`/.claude/agents/${a.name}.md`)))));
}
