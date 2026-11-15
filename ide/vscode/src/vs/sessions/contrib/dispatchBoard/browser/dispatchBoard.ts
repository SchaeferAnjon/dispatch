/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the task board's changes, pushed. chatd's board service (kanban app/cli/board_service.py)
 *  owns the board; dispatch-bridge (app/ide-ext/src/board.ts) listens to its change events and calls
 *  `_dispatch.board.changed` here, a burst of changes as one call. The board views (Tasks, Waiting for
 *  you, Projects, a session's life card) refresh on that instead of asking every few seconds.
 *
 *  `live` is true while the bridge is connected: a view that shows only board data skips its timer then;
 *  one that also shows sessions (they change outside the board) keeps its timer and refreshes on a push too.
 *  When the bridge loses chatd it calls once more with live false, and the timers take over again.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

export interface IDispatchBoardChange {
	readonly live: boolean;
	readonly rev: number;
	readonly ids: readonly string[];
	readonly kv: boolean;
	readonly issues: boolean;
	readonly all: boolean;
}

export const DISPATCH_BOARD_CHANGED_COMMAND = '_dispatch.board.changed';

const onChange = new Emitter<IDispatchBoardChange>();
let live = false;

/** Fires when the board changed (or the push came or went: then everything may have changed). */
export const onDidChangeDispatchBoard = onChange.event;

/** True while changes are pushed: a view of board data only does not need its timer. */
export function dispatchBoardLive(): boolean {
	return live;
}

CommandsRegistry.registerCommand(DISPATCH_BOARD_CHANGED_COMMAND, (_accessor, arg: unknown) => {
	const a = (arg && typeof arg === 'object' ? arg : {}) as Partial<IDispatchBoardChange>;
	live = a.live === true;
	onChange.fire({
		live,
		rev: typeof a.rev === 'number' ? a.rev : 0,
		ids: Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string') : [],
		kv: a.kv === true,
		issues: a.issues === true,
		all: a.all === true,
	});
});
