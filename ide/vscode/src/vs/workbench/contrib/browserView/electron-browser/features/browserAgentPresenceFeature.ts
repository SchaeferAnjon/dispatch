/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './browserAgentPresenceFeature.css';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserEditor, BrowserEditorContribution } from '../browserEditor.js';
import { IBrowserAgentPresenceService } from '../tools/browserAgentPresence.js';
import { ensureDispatchPalette } from '../../../../../base/browser/dispatchPalette.js';

// the dots and the frame are the app icon's state colours (--dispatch-state-*, base/common/dispatchPalette.ts)
ensureDispatchPalette();

/**
 * Dispatch: the border of a page an agent is using, drawn by the workbench around the page (it
 * never covers the page and never shows in the agent's screenshots): 2px green while the agent
 * works, amber while the user has control, nothing otherwise. It replaces VS Code's spinning
 * blue-green-purple border of a shared page, which kept redrawing while the agent worked.
 *
 * Notification toasts step aside for a live page: when the page sits where toasts appear (the
 * bottom right, which is where the Agents window's side pane puts it), the toasts are laid out to
 * the left of the page instead of over it, so a notification never pauses the page and the page
 * never swaps between itself and the "Paused due to Notification" placeholder. The notification
 * center moves with them. When there is no room to the left, a page an agent uses stays live anyway
 * (see webContentsViewRendererFeature).
 */
class BrowserAgentPresenceFeature extends BrowserEditorContribution {

	private _container: HTMLElement | undefined;
	private _model: IBrowserViewModel | undefined;

	constructor(
		editor: BrowserEditor,
		@IBrowserAgentPresenceService private readonly _presence: IBrowserAgentPresenceService,
	) {
		super(editor);
		this._register(this._presence.onDidChange(pageId => {
			if (pageId === this._model?.id) {
				this._render();
			}
		}));
		this._register(toDisposable(() => ToastPlacement.forWindow(this.editor.window).set(this, undefined)));
	}

	override onContainerCreated(container: HTMLElement): void {
		this._container = container;
		this._render();
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this._model = model;
		store.add(model.onDidChangeVisibility(() => this._placeToasts()));
		this._render();
	}

	override onModelDetached(): void {
		this._model = undefined;
		this._render();
	}

	override afterContainerLayout(): void {
		this._placeToasts();
	}

	override onPaneVisibilityChanged(): void {
		this._placeToasts();
	}

	private _render(): void {
		const mode = this._model ? this._presence.getMode(this._model.id) : 'idle';
		this._container?.classList.toggle('dispatch-agent-working', mode === 'working');
		this._container?.classList.toggle('dispatch-agent-paused', mode === 'paused');
		this._placeToasts();
	}

	/** Keep notification toasts clear of this page while it is shown. */
	private _placeToasts(): void {
		const placement = ToastPlacement.forWindow(this.editor.window);
		const container = this._container;
		if (!container || !this._model?.url || !container.isConnected || container.offsetWidth === 0) {
			placement.set(this, undefined);
			return;
		}
		const rect = container.getBoundingClientRect();
		const width = this.editor.window.innerWidth;
		const height = this.editor.window.innerHeight;
		// Where toasts appear by default: the bottom right corner (450 wide, up to about 3 toasts).
		const zone = { left: width - 3 - ToastPlacement.TOAST_WIDTH, right: width - 3, top: height - 25 - 260, bottom: height - 25 };
		const overlaps = rect.left < zone.right && rect.right > zone.left && rect.top < zone.bottom && rect.bottom > zone.top;
		if (!overlaps) {
			placement.set(this, undefined);
			return;
		}
		const right = width - rect.left + 8;
		placement.set(this, right + ToastPlacement.TOAST_WIDTH <= width - 8 ? right : undefined);
	}
}

/** Where the toasts of one window sit: the rightmost offset any shown page asks for. */
class ToastPlacement {
	static readonly TOAST_WIDTH = 450;
	private static readonly _byWindow = new WeakMap<Window, ToastPlacement>();

	static forWindow(window: Window): ToastPlacement {
		let placement = ToastPlacement._byWindow.get(window);
		if (!placement) {
			placement = new ToastPlacement(window);
			ToastPlacement._byWindow.set(window, placement);
		}
		return placement;
	}

	private readonly _wants = new Map<object, number>();
	private _observer: MutationObserver | undefined;

	private constructor(private readonly _window: Window) { }

	set(owner: object, right: number | undefined): void {
		if (right === undefined) {
			this._wants.delete(owner);
		} else {
			this._wants.set(owner, right);
		}
		this._apply();
		// the toasts and the center are made on the first notification: place them when they appear
		if (this._wants.size && !this._observer) {
			const workbench = this._window.document.querySelector('.monaco-workbench');
			if (workbench) {
				this._observer = new MutationObserver(() => this._apply());
				this._observer.observe(workbench, { childList: true });
			}
		} else if (!this._wants.size && this._observer) {
			this._observer.disconnect();
			this._observer = undefined;
		}
	}

	private _apply(): void {
		const max = this._wants.size ? Math.max(...this._wants.values()) : undefined;
		// the toasts and the notification center (the bell's list) sit in the same corner
		for (const el of this._window.document.querySelectorAll<HTMLElement>('.monaco-workbench > .notifications-toasts, .monaco-workbench > .notifications-center')) {
			el.style.right = max === undefined ? '' : `${Math.round(max)}px`;
		}
	}
}

BrowserEditor.registerContribution(BrowserAgentPresenceFeature);
