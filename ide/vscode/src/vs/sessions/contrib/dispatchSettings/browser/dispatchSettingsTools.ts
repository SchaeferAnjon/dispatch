/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: how many MCP servers the agents have, for Settings' Abilities counts (kanban task-lj06.23).
 *  The tool servers live in each agent's own settings (`dispatch mcp list`, Dispatch's own server among them, read with
 *  the rest of Settings, dispatchSettingsData.ts); the count was VS Code's own list, which is empty in Dispatch, so
 *  Settings said "0 tools" with three agents using one.
 *--------------------------------------------------------------------------------------------*/

import { IReader } from '../../../../base/common/observable.js';
import { settingsData } from './dispatchSettingsData.js';

/** The agents' tool servers set up for every project, each name once, plus the ones this window has. */
export function toolCount(windowServers: number, reader: IReader): number {
	const servers = settingsData.read<{ servers?: readonly { readonly name: string; readonly scope: string; readonly builtin?: boolean }[] }>(reader, 'mcp')?.servers ?? [];
	// Dispatch's own server is on Settings › Soul, not on the MCP servers page
	return new Set(servers.filter(s => s.scope === 'user' && !s.builtin).map(s => s.name)).size + windowServers;
}
