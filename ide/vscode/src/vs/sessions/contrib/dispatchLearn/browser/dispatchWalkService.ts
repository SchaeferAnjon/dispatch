/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Walk me through, as other places ask for it (task-fktjx): the Now tab's head and the side chat
 *  card's ⋯ offer it for the session on screen once a turn that changed files has ended. The walk itself is
 *  dispatchWalk.ts.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { WhySource } from '../common/dispatchExplainModel.js';

/** `dispatch.learn.walkMeThrough`: walks the last turn of the session on screen. */
export const DISPATCH_WALK_COMMAND = 'dispatch.learn.walkMeThrough';

export interface IWalkOfferState {
	readonly sessionId: string;
	/** How many stops the walk has. */
	readonly stops: number;
}

/** Why on a block of the Changes tab (task-39x97): the block as its diff shows it. */
export interface IWhyRequest {
	/** The file now (the diff's modified side). */
	readonly uri: URI;
	/** Its lines now, 1-based, inclusive (a block that only removed lines: the line before the gap). */
	readonly start: number;
	readonly end: number;
	readonly isNew: boolean;
	/** Its lines before (-) and now (+), for the model when nothing else says why. */
	readonly code: string;
}

export interface IWhyAnswer {
	readonly text: string;
	readonly source: WhySource;
	/** The walk of the same turn had it already (its sentence, or the model's answer it got). */
	readonly fromWalk: boolean;
	/** How long the one model call took (when one was made for it). */
	readonly ms?: number;
	/** How many blocks that one call asked about. */
	readonly asked?: number;
	readonly by?: string;
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
	/**
	 * Why a block of the Changes tab was changed: what the walk of the turn already says about its lines, a new file's
	 * first comment, the agent's own sentence before it changed the file; else one call to the session's own agent for
	 * every block of Changes with nothing said, this one first (task-39x97).
	 */
	why(block: IWhyRequest): Promise<IWhyAnswer>;
}
