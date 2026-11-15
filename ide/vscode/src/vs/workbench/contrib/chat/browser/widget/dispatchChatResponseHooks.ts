/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: rows under a finished reply that the Agents window draws (patches/
 *  340-attribution.patch): "You changed 2 lines in NOTES.md" and the commit card
 *  (src/vs/sessions/contrib/dispatchAttribution). The chat list only calls these hooks, so the workbench
 *  does not depend on the sessions layer; a window that registers nothing looks as before.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IChatResponseViewModel } from '../../common/model/chatViewModel.js';

export interface IDispatchChatResponseFooterContext {
	/** The reply's content element; the rows go after it, before the footer toolbar. */
	readonly value: HTMLElement;
	readonly footerToolbar: HTMLElement | undefined;
	readonly element: IChatResponseViewModel;
}

export interface IDispatchChatResponseHooks {
	renderFooter?(context: IDispatchChatResponseFooterContext): void;
	/** The row element is reused for another reply: take the rows away. */
	removeFooter?(value: HTMLElement): void;
}

let hooks: IDispatchChatResponseHooks | undefined;

export function setDispatchChatResponseHooks(value: IDispatchChatResponseHooks): IDisposable {
	hooks = value;
	return toDisposable(() => {
		if (hooks === value) {
			hooks = undefined;
		}
	});
}

export function getDispatchChatResponseHooks(): IDispatchChatResponseHooks | undefined {
	return hooks;
}
