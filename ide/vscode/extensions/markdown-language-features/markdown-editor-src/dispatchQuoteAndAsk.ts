/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Quote and Ask Question in the box a selection brings up (315-quote.patch). editor.ts calls addQuoteAndAskItems.
 *--------------------------------------------------------------------------------------------*/

import type { CommentModeController, EditorModel, OffsetRange } from '@vscode/markdown-editor';
import './dispatchQuoteAndAsk.css';

/*
 * Dispatch: two rows under the "Add comment" box that appears on a selection, the same two the chat's
 * selection boxes offer, in the same order (kanban design/quote/redesign 方向 B):
 * - "Quote" (⇧⌘L, also from the keyboard while the selection is up): the extension puts the selection
 *   in the session's chat input as a quote card;
 * - "Ask Question": a side chat about the selection; whatever is typed in the box is the question.
 */

interface CommentControllerInternals {
	readonly _widget?: { readonly element: HTMLElement; readonly inputElement: HTMLTextAreaElement };
	_pinnedRange?: OffsetRange;
	_submittedRange?: OffsetRange;
	_hide?(): void;
}

interface IQuoteAndAskHandlers {
	quote(range: OffsetRange): void;
	ask(range: OffsetRange, question: string): void;
}

const isMac = /Mac/.test(navigator.platform);

export function addQuoteAndAskItems(controller: CommentModeController, model: EditorModel, handlers: IQuoteAndAskHandlers): void {
	const internals = controller as unknown as CommentControllerInternals;
	const widget = internals._widget;
	if (!widget || typeof internals._hide !== 'function') {
		return;
	}
	const currentRange = (): OffsetRange | undefined => {
		const range = internals._pinnedRange ?? model.selection.get()?.range;
		return range && !range.isEmpty ? range : undefined;
	};
	// same as submitting a comment: hide, and stay hidden until the selection changes
	const close = (range: OffsetRange) => {
		internals._submittedRange = range;
		internals._hide!();
	};
	const row = (className: string, iconId: string, text: string, keys?: string): HTMLButtonElement => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `md-selection-action ${className}`;
		const icon = document.createElement('span');
		icon.className = `codicon codicon-${iconId}`;
		icon.setAttribute('aria-hidden', 'true');
		const label = document.createElement('span');
		label.className = 'md-selection-action-label';
		label.textContent = text;
		button.append(icon, label);
		if (keys) {
			const kbd = document.createElement('kbd');
			kbd.textContent = keys;
			button.appendChild(kbd);
			button.title = `${text} (${keys})`;
		}
		// keep the selection: a mousedown on the row would otherwise move it
		button.addEventListener('mousedown', e => e.preventDefault());
		widget.element.appendChild(button);
		return button;
	};
	const quote = () => {
		const range = currentRange();
		if (range) {
			close(range);
			handlers.quote(range);
		}
	};
	row('md-quote', 'quote', 'Quote', isMac ? '\u21e7\u2318L' : 'Ctrl+Shift+L').addEventListener('click', quote);
	row('md-ask', 'comment-discussion', 'Ask Question').addEventListener('click', () => {
		const range = currentRange();
		if (range) {
			const question = widget.inputElement.value.trim();
			close(range);
			handlers.ask(range, question);
		}
	});
	// ⇧⌘L quotes the selection, from the text or from the box
	document.addEventListener('keydown', e => {
		const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
		if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l' && currentRange()) {
			e.preventDefault();
			e.stopPropagation();
			quote();
		}
	}, true);
}
