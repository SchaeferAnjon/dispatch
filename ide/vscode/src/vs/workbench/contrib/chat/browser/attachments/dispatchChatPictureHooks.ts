/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: hooks for pictures in chat (patches/320-draw-and-ask.patch). The Agents window draws
 *  a picture attachment as a thumbnail with a pen and puts the lines of a picture's boxes into the
 *  sent message's bubble (src/vs/sessions/contrib/dispatchDraw); Point and talk draws its keyframes and
 *  its timed lines the same way (src/vs/sessions/contrib/dispatchPointTalk). The chat widgets here only
 *  call these hooks, so the workbench does not depend on the sessions layer; a window that registers
 *  nothing (the editor window) looks as before. Several features can register; each is called.
 *--------------------------------------------------------------------------------------------*/

import { combinedDisposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IChatRequestVariableEntry } from '../../common/attachments/chatVariableEntries.js';

export interface IDispatchChatImageAttachmentContext {
	/** The attachment's element (`.chat-attached-context-attachment.image-attachment`). */
	readonly element: HTMLElement;
	readonly attachment: IChatRequestVariableEntry;
	/** The picture's bytes, when the entry holds them (a reloaded one holds a file URI). */
	readonly imageData: Uint8Array | undefined;
	/** In the input box (not a sent message). */
	readonly isCurrentInput: boolean;
	readonly supportsDeletion: boolean;
}

export interface IDispatchChatRequestContext {
	/** The request's content element (attachments, then the bubble). */
	readonly container: HTMLElement;
	readonly variables: readonly IChatRequestVariableEntry[];
	/** The message as it was sent (its text). */
	readonly text?: string;
	/** Scroll the chat so this message shows: 0 its top at the top, 1 its bottom at the bottom. */
	readonly reveal?: (relativeTop: number) => void;
}

export interface IDispatchChatPictureHooks {
	decorateImageAttachment?(context: IDispatchChatImageAttachmentContext): IDisposable | undefined;
	decorateRequest?(context: IDispatchChatRequestContext): IDisposable | undefined;
}

const registered: IDispatchChatPictureHooks[] = [];

export function setDispatchChatPictureHooks(value: IDispatchChatPictureHooks): IDisposable {
	registered.push(value);
	return toDisposable(() => {
		const i = registered.indexOf(value);
		if (i >= 0) {
			registered.splice(i, 1);
		}
	});
}

function both(parts: (IDisposable | undefined)[]): IDisposable | undefined {
	const some = parts.filter((d): d is IDisposable => !!d);
	return some.length ? combinedDisposable(...some) : undefined;
}

const all: IDispatchChatPictureHooks = {
	decorateImageAttachment: context => both(registered.map(h => h.decorateImageAttachment?.(context))),
	decorateRequest: context => both(registered.map(h => h.decorateRequest?.(context))),
};

export function getDispatchChatPictureHooks(): IDispatchChatPictureHooks | undefined {
	return registered.length ? all : undefined;
}
