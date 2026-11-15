/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Waiting for you's 7-day rule (design/home-now direction A, picked 2026-11-11, task-0v1o9).
 *  A thing that has not moved for WAITING_FRESH_DAYS is Older: it leaves the sidebar's rows and its number, and on
 *  the page it folds into Older. "Moved" is the last time anything about it changed (a session stopping again, a
 *  reply, the task being edited, coming back from Not now). Computed here once; the sidebar, the page and the
 *  settings' count read it through dispatchWaitingModel.ts's `dispatchWaitingWeek`. No imports but types, so the
 *  Node tests load it as it is (ide/tests/waiting-week.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import type { IDispatchWaitingItem } from './dispatchWaitingModel.js';

/** How many days a thing counts as waiting for the person after it last moved. */
export const WAITING_FRESH_DAYS = 7;

/** When the thing last moved (epoch seconds); 0 when the CLI gave no time at all. */
export function waitingChangedAt(item: IDispatchWaitingItem, now = Date.now() / 1000): number {
	const back = item.snooze_until && item.snooze_until <= now ? item.snooze_until : 0;
	return Math.max(item.updated_at ?? 0, item.stopped_at ?? 0, item.at ?? 0, item.created_at ?? 0, back);
}

export interface IDispatchWaitingWeek {
	/** Moved in the last WAITING_FRESH_DAYS, the newest first: the sidebar's rows and number, the page's This week. */
	readonly week: readonly IDispatchWaitingItem[];
	/** Not moved for longer, the newest first: the page's Older. */
	readonly older: readonly IDispatchWaitingItem[];
}

/** Split into this week and older, each the newest first. A thing without any time stays in this week. */
export function splitWaiting(items: readonly IDispatchWaitingItem[], now = Date.now() / 1000, days = WAITING_FRESH_DAYS): IDispatchWaitingWeek {
	const line = now - days * 86400;
	const at = new Map(items.map(i => [i, waitingChangedAt(i, now)] as const));
	const newest = (a: IDispatchWaitingItem, b: IDispatchWaitingItem) => at.get(b)! - at.get(a)!;
	return {
		week: items.filter(i => !at.get(i) || at.get(i)! >= line).sort(newest),
		older: items.filter(i => !!at.get(i) && at.get(i)! < line).sort(newest),
	};
}

/** How long ago it moved, short: "now", "12m", "3h", "2d" (the rows' last column). */
export function waitingAge(item: IDispatchWaitingItem, now = Date.now() / 1000): string {
	const at = waitingChangedAt(item, now);
	if (!at) {
		return '';
	}
	const s = Math.max(0, now - at);
	return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** A design direction to pick (`dispatch flow design`): a task on the board with a proposal page, no session behind it. */
export function isDesignDecide(item: IDispatchWaitingItem): boolean {
	return item.kind === 'decide' && item.source === 'board';
}

/**
 * What the thing is (the rows' first slot, DESIGN.md 符号表, user 2026-11-12, task-he465), apart from what is asked
 * of the person (the third column's word): a proposal page to pick from, a question (an engine's question with
 * options, or a reply to read), a command to approve, a thing only the person can do.
 */
export type WaitingThing = 'proposal' | 'question' | 'approval' | 'only-you';

export function waitingThing(item: IDispatchWaitingItem): WaitingThing {
	switch (item.kind) {
		case 'approve': return 'approval';
		case 'decide': return isDesignDecide(item) ? 'proposal' : 'question';
		case 'unread': return 'question';
		default: return 'only-you';
	}
}

const THING_NAME: Record<WaitingThing, string> = { proposal: 'Proposal', question: 'Question', approval: 'Approval', 'only-you': 'Only you' };

/** The thing in one word: its icon's name for screen readers. */
export function waitingThingName(item: IDispatchWaitingItem): string {
	return THING_NAME[waitingThing(item)];
}

/** What the person is asked to do, in one word: the rows' third column. */
export function waitingAskWord(item: IDispatchWaitingItem): string {
	switch (item.kind) {
		case 'approve': return 'Approve';
		case 'decide': return 'Pick';
		case 'unread': return 'Reply';
		default: return 'Only you';
	}
}
