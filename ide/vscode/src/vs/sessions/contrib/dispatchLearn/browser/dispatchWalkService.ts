/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Walk me through, as other places ask for it (task-fktjx): the Now tab's head and the side chat
 *  card's ⋯ offer it for the session on screen once a turn that changed files has ended. The walk itself is
 *  dispatchWalk.ts.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** `dispatch.learn.walkMeThrough`: walks the last turn of the session on screen. */
export const DISPATCH_WALK_COMMAND = 'dispatch.learn.walkMeThrough';

export interface IWalkOfferState {
	readonly sessionId: string;
	/** How many stops the walk has. */
	readonly stops: number;
}

export const IDispatchWalkService = createDecorator<IDispatchWalkService>('dispatchWalkService');

export interface IDispatchWalkService {
	readonly _serviceBrand: undefined;

	/** The walk the session on screen offers for its last turn; undefined while it works, or when the turn changed no file. */
	readonly offer: IObservable<IWalkOfferState | undefined>;
	/** A walk is on screen (the small cards and the side chat card keep out of its corner). */
	readonly walking: IObservable<boolean>;
	/** The walk's pill is on screen (the small cards sit above it). */
	readonly pillShown: IObservable<boolean>;
	/** Walks the last turn of the session on screen, from its first stop. */
	start(): Promise<void>;
}
