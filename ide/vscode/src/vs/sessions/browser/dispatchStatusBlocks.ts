/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session's status as Dispatch's icon in miniature, in the sessions list and the session title
 *  (130-session-rows.patch). sessionStatusIcon.ts asks dispatchStatusIcon which icon a status gets.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchStatusBlocks.css';
import * as DOM from '../../base/browser/dom.js';
import { ensureDispatchDotStyles } from '../../base/browser/dispatchDot.js';
import { ensureDispatchPalette } from '../../base/browser/dispatchPalette.js';
import { dispatchIconElement, dispatchIconRounds } from '../../base/browser/dispatchIcon.js';
import { IDisposable } from '../../base/common/lifecycle.js';
import { SessionStatus } from '../services/sessions/common/session.js';

const $ = DOM.$;

// The status dots (span.dispatch-status-dot) are the shared dot, a disc and its glow (base/common/dispatchDot.ts);
// dispatchStatusBlocks.css gives each state its colour.
ensureDispatchDotStyles('.dispatch-status-dot');
ensureDispatchPalette();

// Dispatch IDE: the status is Dispatch's icon in miniature (DESIGN.md「图标色即图例」): the Dock icon's ten blocks at
// its proportions (base/common/dispatchIcon.ts), without the plate and the dot. Running: design/icon-motion's 落块 as
// it is (user 2026-11-15, task-dw425: 「就用这一版」): the ten blocks fall 220ms apart from above, the design's height
// scaled to the 3px blocks, faster and faster, and bounce twice; the full icon rests 1s, empties and falls again.
// The blocks start above the 16px box (dispatchStatusBlocks.css lets them out of it). Idle: the grid still, one
// colour; needs input: the grid in amber (Waiting for you); error: a coral dot.
const DISPATCH_BLOCKS_RUNNING_KEY = '__dispatch_blocks_running__';
const DISPATCH_BLOCKS_STILL_KEY = '__dispatch_blocks_still__';
const DISPATCH_BLOCKS_IDLE_KEY = '__dispatch_blocks_idle__';
const DISPATCH_BLOCKS_WAITING_KEY = '__dispatch_blocks_waiting__';
const DISPATCH_DOT_ERROR_KEY = '__dispatch_dot_error__';
/** The small icon's box, px. */
const DISPATCH_BLOCKS_SIZE = 16;

// also the inbox (dispatchInbox.contribution.ts)
export function createDispatchBlocks(mode: 'running' | 'still' | 'idle' | 'waiting'): { element: HTMLElement; disposable?: IDisposable } {
	const element = $(`span.dispatch-status-blocks.${mode}`);
	element.setAttribute('aria-hidden', 'true');
	// running and still: the app icon's own colours (base/common/dispatchPalette.ts; kanban preference「状态色用图标配色」);
	// idle and waiting: one colour, from the CSS
	const svg = element.appendChild(dispatchIconElement(DISPATCH_BLOCKS_SIZE, { plate: false, dot: false, fill: mode === 'running' || mode === 'still' ? 'theme' : 'none' }));
	if (mode !== 'running') {
		return { element };
	}
	return { element, disposable: dispatchIconRounds(svg) };
}

/**
 * The state blocks come from contrib/dispatchBlocks (050-blocks.patch), which
 * sets `render` when it loads (this layer does not import contrib). `play`: the state just changed, so
 * the mark moves once (the amber circle knocks).
 */
export const dispatchStateBlocks: { render?: (state: 'waiting' | 'stopped' | 'done' | 'empty', play: boolean) => HTMLElement } = {};

/** The icon for a status, as SessionStatusIcon caches and draws it; undefined leaves it to VS Code's own. */
export function dispatchStatusIcon(status: SessionStatus, isRead: boolean, isArchived: boolean, reducedMotion: boolean, currentCacheKey: string | undefined): { cacheKey: string; color: string; createIcon: () => { element: HTMLElement; disposable?: IDisposable } } | undefined {
	if (status === SessionStatus.InProgress) {
		const still = reducedMotion;
		return { cacheKey: still ? DISPATCH_BLOCKS_STILL_KEY : DISPATCH_BLOCKS_RUNNING_KEY, color: '', createIcon: () => createDispatchBlocks(still ? 'still' : 'running') };
	} else if (dispatchStateBlocks.render && (status === SessionStatus.NeedsInput || status === SessionStatus.Error || (!isArchived && (status === SessionStatus.Completed || status === SessionStatus.Untitled)))) {
		// Dispatch IDE (050-blocks.patch; DESIGN.md「符号表」, task-o01fh): waiting for you: VS Code's filled circle in
		// amber, knocking when it turns up; stopped: the coral one; done and not read yet: the filled check in the done
		// colour; read or new: nothing, the 14px slot stays.
		const render = dispatchStateBlocks.render;
		const state = status === SessionStatus.NeedsInput ? 'waiting' : status === SessionStatus.Error ? 'stopped' : !isRead && status === SessionStatus.Completed ? 'done' : 'empty';
		const changed = currentCacheKey !== undefined && currentCacheKey !== `__dispatch_state_${state}__`;
		return { cacheKey: `__dispatch_state_${state}__`, color: '', createIcon: () => ({ element: render(state, changed) }) };
	} else if (status === SessionStatus.NeedsInput) {
		// Waiting for you: the whole grid amber (DESIGN.md: amber is "waiting for you")
		return { cacheKey: DISPATCH_BLOCKS_WAITING_KEY, color: '', createIcon: () => createDispatchBlocks('waiting') };
	} else if (status === SessionStatus.Error) {
		return { cacheKey: DISPATCH_DOT_ERROR_KEY, color: '', createIcon: () => ({ element: $('span.dispatch-status-dot.error') }) };
	} else if (!isArchived && (status === SessionStatus.Completed || status === SessionStatus.Untitled)) {
		return { cacheKey: DISPATCH_BLOCKS_IDLE_KEY, color: '', createIcon: () => createDispatchBlocks('idle') };
	}
	return undefined;
}
