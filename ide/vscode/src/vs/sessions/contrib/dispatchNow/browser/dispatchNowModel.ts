/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the session Now tab shows, worked out without the window (direction A, 2026-11-11,
 *  task-0v1o9; kanban design/home-now/notes.md A4). dispatchNowEditor.ts draws it; ide/tests/now-model.test.mjs
 *  tests it. No imports but types: Node runs this file as it is.
 *--------------------------------------------------------------------------------------------*/

import type { IDispatchDeliverable, IDispatchPlanItem } from '../../dispatchTasks/browser/dispatchTasksModel.js';

/**
 * The heads the tab has: working, waiting for the person, paused (the turn is over but the task it is on has steps
 * left), done, a terminal session; a session that ended with an error says so as one more.
 */
export type NowMode = 'working' | 'waiting' | 'paused' | 'done' | 'terminal' | 'stopped';

export interface INowModeInput {
	/** The session runs in Dispatch's terminal: what it plans is not visible there. */
	readonly terminal: boolean;
	/** The session's own status. */
	readonly status: 'working' | 'needs-input' | 'error' | 'idle';
	/** Something waits for the person although the session is not running: a design direction to pick for one of
	 *  its tasks, or the task it is on is waiting for them. */
	readonly asks: boolean;
	/** The task it is on is not finished and its plan has steps not done. */
	readonly unfinished: boolean;
	/** The person stopped the last turn before it ended (Esc, the stop button). */
	readonly canceled?: boolean;
}

export function nowMode(i: INowModeInput): NowMode {
	if (i.terminal) {
		return 'terminal';
	}
	if (i.status === 'error') {
		return 'stopped';
	}
	if (i.status === 'needs-input') {
		return 'waiting';
	}
	if (i.status === 'working') {
		return 'working';
	}
	if (i.asks) {
		return 'waiting';
	}
	// a turn that ended with steps left is a pause, not done (it says at which step it stopped, also when the person
	// stopped it); a turn the person stopped with no steps to show is stopped; done is what is left: a finished task,
	// no task, or no plan, with a turn that ran to its end
	if (i.unfinished) {
		return 'paused';
	}
	return i.canceled ? 'stopped' : 'done';
}

/** The task it is on has steps left: not finished, with a plan that has a step not done. */
export function isUnfinished(task: { readonly status: string; readonly plan?: readonly IDispatchPlanItem[] } | null | undefined): boolean {
	return !!task && task.status !== 'done' && (task.plan ?? []).some(p => p.state !== 'done');
}

/** "step 3 of 5": the step it is on, else the first one not done; none without a plan. */
export function stepOf(plan: readonly IDispatchPlanItem[]): { readonly at: number; readonly of: number } | undefined {
	if (!plan.length) {
		return undefined;
	}
	const active = plan.findIndex(p => p.state === 'active');
	const at = active >= 0 ? active + 1 : Math.min(plan.filter(p => p.state === 'done').length + 1, plan.length);
	return { at, of: plan.length };
}

/** A span of time in the words the head uses: under a minute, minutes, hours, days. */
export type NowSpan = { readonly unit: 'now' } | { readonly unit: 'min' | 'h' | 'd'; readonly n: number };

export function spanOf(ms: number): NowSpan {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) {
		return { unit: 'now' };
	}
	if (s < 3600) {
		return { unit: 'min', n: Math.floor(s / 60) };
	}
	if (s < 86400) {
		return { unit: 'h', n: Math.floor(s / 3600) };
	}
	return { unit: 'd', n: Math.floor(s / 86400) };
}

export type NowStepKind = 'done' | 'now' | 'ask' | 'stop' | 'todo';

/**
 * Each step as the line draws it: done (a filled check); the one it is on: the green filled circle only while the session really runs
 * it (`head` working), the amber one when it waits for the person, else the large ring in the step's strong words
 * where it stopped; not started (the large ring). `head` is the head's state, given for the task it is on only. A
 * paused task with no step marked active stopped at its first step not done. A finished task's step that was never
 * ticked is not started.
 */
export function stepKinds(plan: readonly IDispatchPlanItem[], taskStatus: string, head?: NowMode): NowStepKind[] {
	if (taskStatus === 'done') {
		return plan.map(p => p.state === 'done' ? 'done' : 'todo');
	}
	const active = plan.findIndex(p => p.state === 'active');
	const at = active >= 0 ? active : head === 'paused' ? plan.findIndex(p => p.state !== 'done') : -1;
	return plan.map((p, i) => p.state === 'done' ? 'done'
		: i !== at ? 'todo'
			: head === 'working' ? 'now'
				: head === 'waiting' || taskStatus === 'waiting' ? 'ask'
					: 'stop');
}

export interface INowTaskLike {
	readonly id: string;
	readonly status: string;
}

/**
 * The tasks drawn as rows (the one it is on first, then the others not finished) and the finished ones folded into
 * "Done in this session". The one it is on stays a row when it is finished: that is what the session did.
 */
export function splitTasks<T extends INowTaskLike>(tasks: readonly T[], currentId: string | undefined): { readonly rows: T[]; readonly done: T[] } {
	const current = tasks.find(t => t.id === currentId);
	const rest = tasks.filter(t => t !== current);
	return {
		rows: [...(current ? [current] : []), ...rest.filter(t => t.status !== 'done')],
		done: rest.filter(t => t.status === 'done'),
	};
}

/** Where the sub-agents the session sent out hang: under the step it is on, else the last step done; -1 above the tasks. */
export function agentAnchor(plan: readonly IDispatchPlanItem[]): number {
	const active = plan.findIndex(p => p.state === 'active');
	if (active >= 0) {
		return active;
	}
	for (let i = plan.length - 1; i >= 0; i--) {
		if (plan[i].state === 'done') {
			return i;
		}
	}
	return -1;
}

/** The page `dispatch deliver` made for the task (deliver.py labels it), newest first. */
export function deliveryPage(deliverables: readonly IDispatchDeliverable[] | undefined, kind: 'Delivery page' | 'Proposal'): IDispatchDeliverable | undefined {
	return [...(deliverables ?? [])].reverse().find(d => d.kind === 'file' && d.label === kind);
}

const BOX = /[─-▟⠀-⣿]/g;
const PROMPT = /[%$#❯›>]\s*$/;

/**
 * The last line a terminal shows that says something: frames, bars and empty lines skipped, and a shell's prompt
 * at the end skipped when something came before it (a line ending in % $ # ❯ › >, or one an earlier line starts
 * with: the prompt a command was typed after, "➜ demo git:(main) echo hi").
 */
export function lastTerminalLine(text: string): string {
	const lines = text.split(/\r?\n/)
		.map(l => l.replace(BOX, ' ').replace(/\s+/g, ' ').trim())
		.filter(l => /[\p{L}\p{N}]/u.test(l));
	const last = lines[lines.length - 1];
	if (lines.length > 1 && (PROMPT.test(last) || lines.slice(0, -1).some(l => l.length > last.length && l.startsWith(last + ' ')))) {
		lines.pop();
	}
	return lines.at(-1) ?? '';
}

/** What is known of a session's last turn when asking whether the person stopped it. */
export interface IStoppedInput {
	/** The session is at rest. */
	readonly idle: boolean;
	/** How many requests the conversation has, when it is loaded. */
	readonly requests?: number;
	/** Its last reply says it was stopped: only a conversation that stayed loaded since then says so. */
	readonly lastCanceled?: boolean;
	/** The number of requests it had when its last one was stopped, kept from the moment it happened. */
	readonly marked?: number;
}

/**
 * Whether the person stopped the session's last turn, and what to keep about it. A conversation loaded again (after
 * a switch to another session, after a reload) no longer says that its last reply was stopped, and the head read
 * "Done" again; so the turn it happened on is kept (`mark`: the number of requests at that moment) until a later
 * turn is there. Not loaded yet: the same last turn, as far as anyone knows.
 */
export function stoppedByPerson(i: IStoppedInput): { readonly canceled: boolean; readonly mark: number | undefined } {
	if (i.lastCanceled && i.requests !== undefined) {
		return { canceled: i.idle, mark: i.requests };
	}
	if (i.marked === undefined || (i.requests !== undefined && i.requests !== i.marked)) {
		return { canceled: false, mark: undefined };
	}
	return { canceled: i.idle, mark: i.marked };
}
