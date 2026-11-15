/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The bottom bar's cup in words (kanban task-vggq). Dispatch's background service holds the Mac awake only while an
// agent works or a phone is connected (kanban app/cli/awake.py), in the mode Settings › Keep awake picks; the cup
// shows while it holds, and its tip and panel say why, the same way the Settings page does. The panel sets the mode
// too (the same `dispatch.keepAwake` the Settings page sets), and its words follow the switch at once.

import { localize } from '../../../../nls.js';

/** Settings › Keep awake: the Mac only, the screen too, or let it sleep (`dispatch.keepAwake`). */
export type AwakeMode = 'system' | 'display' | 'off';

/** `dispatch.keepAwake` as a mode: anything else is the default, the Mac only. */
export function awakeMode(value: unknown): AwakeMode {
	return value === 'display' || value === 'off' ? value : 'system';
}

/** `dispatch.awake` (dispatch-bridge, from `dispatch awake --json`). */
export interface IAwakeState {
	readonly mode: AwakeMode;
	readonly holding: boolean;
	/** why it holds: 'working' (an agent works) or 'phone' (a phone is connected) */
	readonly reason?: string;
	/** agents working on this Mac, in any window or terminal */
	readonly working?: number;
}

export interface IAwakeWords {
	/** first line of the tip, and the panel's title */
	readonly head: string;
	/** the panel's line under the title */
	readonly why: string;
	/** how many agents work now, or '' when none */
	readonly count: string;
}

/** Agents working: the larger of what this window sees and what the background service counted on the whole Mac. */
export function awakeWorking(state: IAwakeState | undefined, inWindow: number): number {
	return Math.max(inWindow, typeof state?.working === 'number' ? state.working : 0);
}

/** `mode`: the setting as it is now, which leads what the background service last held (it follows within seconds). */
export function awakeWords(state: IAwakeState | undefined, inWindow: number, mode: AwakeMode = state?.mode ?? 'system'): IAwakeWords {
	const screen = mode === 'display';
	const phone = state?.reason === 'phone';
	const n = awakeWorking(state, inWindow);
	const count = n === 0
		? ''
		: n === 1
			? localize('dispatchAwake.one', "1 agent is working now.")
			: localize('dispatchAwake.many', "{0} agents are working now.", n);
	if (mode === 'off') {
		return {
			head: localize('dispatchAwake.headOff', "Your Mac sleeps as usual"),
			why: localize('dispatchAwake.whyOff', "Its own energy settings decide. Agents stop while it sleeps and go on when it wakes."),
			count,
		};
	}
	const head = phone
		? (screen
			? localize('dispatchAwake.headPhoneScreen', "Your Mac and its screen stay awake while your phone is connected")
			: localize('dispatchAwake.headPhone', "Your Mac stays awake while your phone is connected"))
		: (screen
			? localize('dispatchAwake.headScreen', "Your Mac and its screen stay awake while agents work")
			: localize('dispatchAwake.head', "Your Mac stays awake while agents work"));
	const why = phone
		? localize('dispatchAwake.whyPhone', "So your phone can reach it. Once the phone goes away and no agent works, it sleeps as usual.")
		: screen
			? localize('dispatchAwake.whyScreen', "It does not sleep and the screen stays on until the last agent finishes, then both sleep as usual.")
			: localize('dispatchAwake.why', "It does not sleep until the last agent finishes, then it sleeps as usual. The screen still dims and locks.");
	return { head, why, count };
}
