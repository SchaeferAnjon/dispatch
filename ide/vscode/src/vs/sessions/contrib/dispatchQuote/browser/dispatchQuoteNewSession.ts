/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a quote taken before the conversation's first message is a card in the new-session input too, the
 *  same card as in a started conversation's input (kanban memo 2026-10-19: "before any turn the quote came in as a
 *  paragraph of text; make it these two cards from now on"). The new-session input's attachments register here
 *  (newChatContextAttachments.ts); Quote puts its card into the newest one.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';

export interface IDispatchNewSessionAttachments {
	addAttachments(...entries: IChatRequestVariableEntry[]): void;
}

const inputs: IDispatchNewSessionAttachments[] = [];

export function registerDispatchNewSessionInput(input: IDispatchNewSessionAttachments): IDisposable {
	inputs.push(input);
	return toDisposable(() => inputs.splice(inputs.indexOf(input), 1));
}

/** The new-session input shown last, if one is open. */
export function dispatchNewSessionInput(): IDispatchNewSessionAttachments | undefined {
	return inputs.at(-1);
}
