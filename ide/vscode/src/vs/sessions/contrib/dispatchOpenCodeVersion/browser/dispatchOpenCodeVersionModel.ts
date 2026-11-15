/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the decision behind the OpenCode version notice (dispatchOpenCodeVersion.contribution.ts),
 *  free of workbench imports so tests/opencode-version.test.mjs can load it.
 *--------------------------------------------------------------------------------------------*/

/** One row of `dispatch engines list --json` (dispatch-bridge's `dispatch.engines`). */
export interface IEngineVersionRow {
	readonly id: string;
	readonly installed: boolean;
	readonly version: string;
	/** the oldest version Dispatch can drive ("" when there is none) */
	readonly min_version?: string;
	/** the installed copy reaches it */
	readonly supported?: boolean;
	/** what upgrades it, as a person would type it */
	readonly command?: string;
}

export const OPENCODE_ENGINE_ID = 'opencode';

/**
 * The OpenCode row when the copy Dispatch would run is too old to start a session; undefined when
 * OpenCode is not installed (the harness is not offered then), new enough, or the CLI did not say.
 */
export function openCodeTooOld(rows: readonly IEngineVersionRow[] | undefined): IEngineVersionRow | undefined {
	const row = rows?.find(r => r.id === OPENCODE_ENGINE_ID);
	return row && row.installed && row.supported === false && !!row.min_version ? row : undefined;
}
