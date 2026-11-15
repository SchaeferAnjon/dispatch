/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../base/common/path.js';

// Dispatch IDE: `dispatch accounts use` (kanban app/cli/accounts.py) puts another saved Claude or Codex sign-in
// where the engine keeps its own, and bumps a number per engine in ~/.dispatch/accounts/switched.json. A Claude
// Code process or a Codex app-server started under an older number is still signed in with the previous account.
// The agents ask here between turns and restart it, so a running session goes on with the new account on its next
// message, without the person restarting anything (kanban task-y9u8).

export type DispatchAccountEngine = 'claude' | 'codex';

function switchedFile(): string {
	const base = process.env['DISPATCH_HOME']?.trim() || join(os.homedir(), '.dispatch');
	return join(base, 'accounts', 'switched.json');
}

let cache: { readonly stamp: string; readonly data: Record<string, { gen?: number } | undefined> } | undefined;

/** How many times `engine`'s account has been switched; 0 before the first switch or when it cannot be read. */
export function dispatchAccountGeneration(engine: DispatchAccountEngine): number {
	const file = switchedFile();
	try {
		const st = fs.statSync(file);
		const stamp = `${st.mtimeMs}:${st.size}`;
		if (cache?.stamp !== stamp) {
			cache = { stamp, data: JSON.parse(fs.readFileSync(file, 'utf8')) ?? {} };
		}
		return Number(cache.data[engine]?.gen) || 0;
	} catch {
		return 0;
	}
}

const startedUnder = new WeakMap<object, number>();

/** Remember the account number `owner` (a Claude chat, a Codex connection) started under. */
export function noteDispatchAccount(owner: object, engine: DispatchAccountEngine): void {
	if (!startedUnder.has(owner)) {
		startedUnder.set(owner, dispatchAccountGeneration(engine));
	}
}

/** Whether the account was switched since `owner` started. One never noted is noted now, as current. */
export function dispatchAccountSwitched(owner: object, engine: DispatchAccountEngine): boolean {
	const now = dispatchAccountGeneration(engine);
	const then = startedUnder.get(owner);
	if (then === undefined) {
		startedUnder.set(owner, now);
		return false;
	}
	return then !== now;
}
