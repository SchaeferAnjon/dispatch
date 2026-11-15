/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the state marks of DESIGN.md「符号表」(user 2026-11-15, task-o01fh, design/marks-compare: VS Code's own
 *  round state icons, the ones its test and task lists use). Every place that says a state on a row takes its mark
 *  from here instead of drawing a dot, a thin check or a ring of its own:
 *
 *    done      passFilled           --dispatch-state-done (not seen yet)
 *    seen      passFilled           --text-2 (done and looked at; a finished step)
 *    now       circleLargeFilled    --dispatch-state-working (the step it is on; also "online"), breathes while live
 *    todo      circleLarge          --text-2 (not started)
 *    stop      circleLarge          --text-2 (where it stopped; the row's words are 500)
 *    waiting   circleLargeFilled    --dispatch-state-waiting
 *    stopped   circleLargeFilled    --dispatch-state-stopped (an error, interrupted)
 *    sub-agent circleLargeFilled    --dispatch-state-plan
 *    handoff   circleLargeFilled    --dispatch-state-handoff
 *
 *  14px in a row, 16px on an entry. Working (the ten falling blocks) is not one of these: see dispatchStatusBlocks.ts.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchMarks.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';

ensureDispatchPalette();

export type DispatchMark = 'done' | 'seen' | 'now' | 'todo' | 'stop' | 'waiting' | 'stopped' | 'sub-agent' | 'handoff';

const ICON: Readonly<Record<DispatchMark, ThemeIcon>> = {
	'done': Codicon.passFilled,
	'seen': Codicon.passFilled,
	'now': Codicon.circleLargeFilled,
	'todo': Codicon.circleLarge,
	'stop': Codicon.circleLarge,
	'waiting': Codicon.circleLargeFilled,
	'stopped': Codicon.circleLargeFilled,
	'sub-agent': Codicon.circleLargeFilled,
	'handoff': Codicon.circleLargeFilled,
};

/** One breath of the live `now` mark, ms; every live mark breathes on the same clock. */
export const DISPATCH_MARK_BREATH_MS = 2_000;

export interface IDispatchMarkOptions {
	/** 14 in a row (default), 16 on an entry. */
	readonly size?: 14 | 16;
	/** `now` only: the agent is really at it, so the mark breathes (still under reduced motion). */
	readonly live?: boolean;
	/** What it says, for screen readers; without one the mark is hidden from them (the row says it in words). */
	readonly label?: string;
}

/** A state mark: a codicon span in the state's colour. */
export function stateMark(mark: DispatchMark, opts: IDispatchMarkOptions = {}): HTMLElement {
	const el = document.createElement('span');
	el.className = `${ThemeIcon.asClassName(ICON[mark])} dispatch-mark ${mark}`;
	el.classList.toggle('s16', opts.size === 16);
	if (mark === 'now' && opts.live) {
		el.classList.add('live');
		el.style.setProperty('--dispatch-mark-phase', `-${Date.now() % DISPATCH_MARK_BREATH_MS}ms`);
	}
	if (opts.label) {
		el.setAttribute('role', 'img');
		el.setAttribute('aria-label', opts.label);
	} else {
		el.setAttribute('aria-hidden', 'true');
	}
	return el;
}
