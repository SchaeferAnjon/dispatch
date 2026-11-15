/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what an unfinished task's green filled circle says. The board keeps a task In progress until the agent
 *  closes it, so "every step ticked" and "still working" are the same board status; the card tells them apart.
 *--------------------------------------------------------------------------------------------*/

/**
 * - running: the agent is working on it (the circle breathes);
 * - wrapup: every step of its plan is done and the agent has not closed it yet (the circle holds still; its hover says Wrapping up);
 * - idle: unfinished steps, but its session is not working now (the circle holds still).
 */
export type DispatchTaskPhase = 'running' | 'wrapup' | 'idle';

/**
 * The phase of a task the board lists as In progress; `sessionWorking` is undefined when its session is not
 * in the window (then the board is all there is to go on and the circle keeps breathing).
 */
export function taskPhase(plan: readonly { readonly state: string }[], sessionWorking: boolean | undefined): DispatchTaskPhase {
	if (plan.length > 0 && plan.every(p => p.state === 'done')) {
		return 'wrapup';
	}
	return sessionWorking === false ? 'idle' : 'running';
}
