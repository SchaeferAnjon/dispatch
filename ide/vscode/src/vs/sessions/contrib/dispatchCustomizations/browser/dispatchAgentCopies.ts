/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which files on this Mac are Dispatch's own copies of the helper agents it ships, for the sub-agent
 *  menu (modePicker.ts) and Customizations > Sub-agents. The list is the one Settings › Soul shows (`dispatch builtins`,
 *  agent_builtins.py, kept by settingsData); the match is builtinAgentFor's.
 *--------------------------------------------------------------------------------------------*/

import { settingsData } from '../../dispatchSettings/browser/dispatchSettingsData.js';
import { BuiltinAgent, builtinAgentFor } from './dispatchBuiltinAgentsModel.js';

/** Says whether a file is Dispatch's copy, from the list read last (`fallback` until Soul's has been read once); the
 *  list is read again in the background when it is older than ten seconds, so the next look has the fresh one. */
export function dispatchAgentCopies(fallback?: readonly BuiltinAgent[]): (path: string) => boolean {
	const agents = settingsData.get<{ agents?: BuiltinAgent[] }>('builtins')?.agents ?? fallback;
	void settingsData.refresh('builtins', 10_000).catch(() => undefined);
	return path => !!builtinAgentFor(path, agents);
}
