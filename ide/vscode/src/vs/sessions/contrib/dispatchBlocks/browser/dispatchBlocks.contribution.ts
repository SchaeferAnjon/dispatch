/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: puts Dispatch's block symbols to work (patches/050-blocks.patch): the
 *  session rows' marks (sessionStatusIcon.ts) and the side bar's entries (media/dispatchBlocksSidebar.css).
 *  The module itself is dispatchBlocks.ts; the showcase is dispatchBlocksShowcase.ts.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchBlocksSidebar.css';
import { dispatchStateBlocks } from '../../../browser/dispatchStatusBlocks.js';
import { DISPATCH_STATE_LABEL, knock } from './dispatchBlocks.js';
import { stateMark } from './dispatchMarks.js';
import './dispatchBlocksShowcase.js';
import { localize } from '../../../../nls.js';

/** A 14px slot for a session row's mark (DESIGN.md: the slot stays when it is empty). */
function slot(cls: string, label: string | undefined): HTMLElement {
	const el = document.createElement('span');
	el.className = `dispatch-block dispatch-row-state ${cls}`;
	if (label) {
		el.setAttribute('role', 'img');
		el.setAttribute('aria-label', label);
		el.title = label;
	} else {
		el.setAttribute('aria-hidden', 'true');
	}
	return el;
}

// a session row's mark (DESIGN.md「符号表」, user 2026-11-15, task-o01fh): VS Code's round state icons in the 14px
// slot; waiting the amber filled circle (it knocks when it turns up), stopped the coral one, done and not read yet the
// filled check in the done colour, read or new nothing
dispatchStateBlocks.render = (state, play) => {
	if (state === 'empty') {
		return slot('empty', undefined);
	}
	const el = slot(state, state === 'done' ? localize('dispatchBlocks.doneUnread', "Done, the reply is not read yet") : DISPATCH_STATE_LABEL[state]);
	el.appendChild(stateMark(state));
	if (state === 'waiting' && play) {
		knock(el);
	}
	return el;
};
