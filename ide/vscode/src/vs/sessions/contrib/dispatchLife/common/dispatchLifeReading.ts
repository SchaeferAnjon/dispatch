/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Context reading under the input keeps its last value. While a turn runs the CLI often has no
 *  reading (the transcript is being written, or the board is slow and the read times out), and the meter said
 *  "Context unavailable" after every message until the reply was done. The person: "没有必要把数据清掉吧？你可以保留
 *  过去的数据，然后更新增量或者更新变化就可以了" (kanban, 2026-10-10). A new reading replaces the old one; "unavailable"
 *  is only for a session that has never had one.
 *--------------------------------------------------------------------------------------------*/

/** The reading's own fields; a snapshot without `percent` has no reading. */
export interface ILifeReading {
	readonly percent?: number;
	readonly context_tokens?: number;
	readonly limit_tokens?: number;
	readonly cumulative_read_tokens?: number;
}

/** What to show after a read: `next` when it has a reading, else `next` with the last reading (all four fields) kept. */
export function keepLastReading<T extends ILifeReading>(prev: T | undefined, next: T | undefined): T | undefined {
	if (!next) {
		return prev;
	}
	if (next.percent !== undefined || prev?.percent === undefined) {
		return next;
	}
	return {
		...next,
		percent: prev.percent,
		context_tokens: prev.context_tokens,
		limit_tokens: prev.limit_tokens,
		cumulative_read_tokens: prev.cumulative_read_tokens,
	};
}
