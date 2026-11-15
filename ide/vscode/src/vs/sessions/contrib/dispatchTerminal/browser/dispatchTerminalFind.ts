/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: ⌘F in a terminal session. VS Code's own find box (the one its terminal and editors use), driven
 *  by xterm's search addon in the session's screen (dispatchXterm.ts). Enter and ⇧Enter step through the
 *  matches, Escape closes it and puts the keyboard back in the terminal.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { SimpleFindWidget } from '../../../../workbench/contrib/codeEditor/browser/find/simpleFindWidget.js';
import { DispatchTerminalController } from './dispatchTerminalController.js';

class DispatchTerminalFindWidget extends SimpleFindWidget {
	private _result: { resultIndex: number; resultCount: number } | undefined;

	constructor(
		private readonly _controller: DispatchTerminalController,
		@IContextViewService contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService hoverService: IHoverService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super({ showCommonFindToggles: true, checkImeCompletionState: true, showResultCount: true, type: 'Terminal', matchesLimit: 1000 }, contextViewService, contextKeyService, hoverService, keybindingService, configurationService, accessibilityService);
		const results = _controller.xterm?.onFindResults;
		if (results) {
			this._register(results(r => {
				this._result = r;
				this.updateResultCount();
			}));
		}
		this._register(addDisposableListener(this.getDomNode(), EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
				e.preventDefault();
				e.stopPropagation();
				this.hide();
			}
		}));
	}

	private _options() {
		return { regex: this._getRegexValue(), wholeWord: this._getWholeWordValue(), caseSensitive: this._getCaseSensitiveValue() };
	}

	find(previous: boolean): void {
		const found = this._controller.xterm?.findNext(this.inputValue, previous, this._options()) ?? false;
		this.updateButtons(found);
	}

	findFirst(): void {
		this.find(false);
	}

	override hide(): void {
		super.hide();
		this._controller.xterm?.clearFind();
		this._controller.focus();
	}

	protected _onInputChanged(): boolean {
		this.find(false);
		return false;
	}

	protected _onFocusTrackerFocus(): void { }
	protected _onFocusTrackerBlur(): void { }
	protected _onFindInputFocusTrackerFocus(): void { }
	protected _onFindInputFocusTrackerBlur(): void { }

	protected async _getResultCount(): Promise<{ resultIndex: number; resultCount: number } | undefined> {
		return this._result;
	}
}

const widgets = new WeakMap<DispatchTerminalController, DispatchTerminalFindWidget>();

/** Shows the find box over the terminal, with the selection (one line of it) to look for. */
export function showTerminalFind(accessor: ServicesAccessor, controller: DispatchTerminalController): void {
	const host = controller.xterm?.element.parentElement;
	if (!host) {
		return;
	}
	let widget = widgets.get(controller);
	if (!widget) {
		widget = accessor.get(IInstantiationService).createInstance(DispatchTerminalFindWidget, controller);
		widgets.set(controller, widget);
		controller.onDispose(() => widget?.dispose());
	}
	if (widget.getDomNode().parentElement !== host) {
		host.appendChild(widget.getDomNode());
	}
	const selection = controller.selection;
	widget.reveal(selection && !selection.includes('\n') ? selection : undefined);
}
