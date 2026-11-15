/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Quote and Ask Question in the box a selection in a file or a diff brings up (315-quote.patch).
 *  feedbackInputWidget.ts draws the buttons with renderDispatchLeadingActions; agentFeedbackEditorInputContribution.ts
 *  turns the selection into the quote commands' args with dispatchQuoteArgs.
 *--------------------------------------------------------------------------------------------*/

import { addStandardDisposableListener } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { getBaseLayerHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate2.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IDispatchQuoteFileArgs } from '../../dispatchQuote/browser/dispatchQuote.js';

/**
 * A text button in front of the input (Quote, Ask Question), with a line after the
 * last one (kanban design/quote/redesign 第 3 节). It acts on the selection the box is for, not on
 * what is typed, so it is enabled while the input is empty.
 */
export interface IFeedbackInputWidgetLeadingAction {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** The hover: `Quote (⇧⌘L)`. */
	readonly title: string;
	readonly run: () => void;
}

/** The buttons in front of the feedback input, then a line after the last one; returns their container. */
export function renderDispatchLeadingActions(domNode: HTMLElement, actions: readonly IFeedbackInputWidgetLeadingAction[], store: DisposableStore, isBusy: () => boolean): HTMLElement {
	domNode.classList.add('has-leading-actions');
	const container = document.createElement('div');
	container.classList.add('agent-feedback-input-leading');
	for (const action of actions) {
		const button = document.createElement('button');
		button.type = 'button';
		button.classList.add('agent-feedback-input-leading-action');
		button.dataset.action = action.id;
		button.setAttribute('aria-label', action.title);
		const icon = document.createElement('span');
		icon.classList.add(...ThemeIcon.asClassNameArray(action.icon));
		icon.setAttribute('aria-hidden', 'true');
		const label = document.createElement('span');
		label.textContent = action.label;
		button.append(icon, label);
		store.add(getBaseLayerHoverDelegate().setupManagedHover(getDefaultHoverDelegate('mouse'), button, action.title));
		// keep the selection the box is for: a mousedown on a button would otherwise clear it
		store.add(addStandardDisposableListener(button, 'mousedown', e => e.preventDefault()));
		store.add(addStandardDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!isBusy()) {
				action.run();
			}
		}));
		container.appendChild(button);
	}
	const divider = document.createElement('span');
	divider.classList.add('agent-feedback-input-divider');
	divider.setAttribute('aria-hidden', 'true');
	container.appendChild(divider);
	domNode.appendChild(container);
	return container;
}

/** The selection (or the box's pinned range) as the args of the quote commands. */
export function dispatchQuoteArgs(editor: ICodeEditor, codeEditorService: ICodeEditorService, pinnedRange: Range | undefined): IDispatchQuoteFileArgs | undefined {
	const model = editor.getModel();
	const selection = editor.getSelection();
	const range = pinnedRange ?? (selection && !selection.isEmpty() ? selection : undefined);
	if (!model || !range || range.isEmpty()) {
		return undefined;
	}
	const text = model.getValueInRange(range);
	if (!text.trim()) {
		return undefined;
	}
	const diff = codeEditorService.listDiffEditors().find(d => d.getModifiedEditor() === editor || d.getOriginalEditor() === editor);
	const originalUri = diff?.getOriginalEditor().getModel()?.uri;
	return {
		uri: model.uri.toString(),
		startLineNumber: range.startLineNumber,
		startColumn: range.startColumn,
		endLineNumber: range.endLineNumber,
		endColumn: range.endColumn,
		text,
		from: diff ? 'diff' : 'file',
		originalUri: diff && originalUri && diff.getModifiedEditor() === editor ? originalUri.toString() : undefined,
	};
}
