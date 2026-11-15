/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a line under the person's own message (patches/415-next-up.patch). The chat
 *  list calls these two after it draws a request and before it reuses the row; what the line says is Dispatch's
 *  (src/vs/sessions/contrib/dispatchCapture), which registers itself here: the workbench does not import it.
 *--------------------------------------------------------------------------------------------*/

import { IChatRequestViewModel } from '../../../common/model/chatViewModel.js';

export interface IDispatchRequestLine {
	/** Draw (or update) the line for this request; `value` is the request's content element. */
	render(value: HTMLElement, element: IChatRequestViewModel): void;
	/** The row is reused for another element: take the line away. */
	remove(value: HTMLElement): void;
}

let line: IDispatchRequestLine | undefined;

export function setDispatchRequestLine(l: IDispatchRequestLine | undefined): void {
	line = l;
}

export function renderDispatchRequestLine(value: HTMLElement, element: IChatRequestViewModel): void {
	line?.render(value, element);
}

export function removeDispatchRequestLine(value: HTMLElement): void {
	line?.remove(value);
}
