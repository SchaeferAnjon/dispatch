/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { ISashEvent, IVerticalSashLayoutProvider, Sash, SashState, Orientation as SashOrientation } from '../../base/browser/ui/sash/sash.js';
import { Part } from '../../workbench/browser/part.js';
import { SESSIONS_LIST_MINIMUM_WIDTH } from './parts/sidebarPart.js';
import { DispatchDockedDetailFit, IDispatchDockedDetailHost } from './dispatchDockedDetailFit.js';
import { EditorInput } from '../../workbench/common/editor/editorInput.js';

/** Accessors the controller uses to read/write the docked panel width and query visibility. */
export interface IDockedAuxiliaryBarHost {
	getWidth(): number;
	setWidth(width: number): void;
	/** Whether the editor area (editor or docked aux bar) is visible. */
	isEditorAreaVisible(): boolean;
	/** Whether the editor part itself is visible, excluding the docked aux bar. */
	isEditorVisible(): boolean;
	/** Whether the docked auxiliary bar (detail panel) is visible. */
	isAuxiliaryBarVisible(): boolean;
	/** Hide the docked auxiliary bar via the workbench part-visibility API. */
	hideAuxiliaryBar(): void;
	/** Reserves space on the right of the editor header and pane while tabs remain full-width. */
	setEditorContentRightInset(px: number): void;
	/** Height of the editor tabs above the optional header. */
	getTabsHeight(): number;
	/** Dispatch IDE: the editor in front, and showing or hiding the detail (dispatchDockedDetailFit.ts). */
	activeEditor(): EditorInput | undefined;
	hasDockedDetails(): boolean;
	/** Dispatch IDE: the active session has no changes; its Changes tab is the list alone (dispatchDockedDetailFit.ts). */
	hasNoChanges?(): boolean;
	setAuxiliaryBarHidden(hidden: boolean): void;
}

/**
 * Owns the single-pane "docked detail panel" behaviour: reparenting the auxiliary
 * bar into the editor part as an absolutely-positioned overlay on the right (below
 * the editor tab strip), sizing it, insetting the editor content, and the draggable
 * resize sash. Created by the workbench only in single-pane mode; the standard
 * layout never constructs it.
 */
export class DockedAuxiliaryBarController extends Disposable {

	static readonly MIN_WIDTH = 220;
	static readonly EDITOR_MIN_WIDTH = 300;
	static readonly EDITOR_PREFERRED_WIDTH = 1000;
	/** Dispatch IDE: 340, not 300: a session opens straight into the detail, and its Changes / Files / Tasks / Docs tabs and `+` need about 325px. */
	static readonly DEFAULT_WIDTH = 340;
	/** The upstream default: a persisted width equal to it was never chosen by the user. */
	static readonly PREVIOUS_DEFAULT_WIDTH = 300;
	static readonly COLLAPSE_WIDTH = 4;
	static readonly NO_EDITOR_MIN_WIDTH = SESSIONS_LIST_MINIMUM_WIDTH;

	private _docked = false;
	private _sash: Sash | undefined;
	private _sashStartWidth = 0;
	private _sashCollapsed = false;
	private _layoutState: { requestedWidth: number; editorWidth: number; auxiliaryBarWidth: number } | undefined;
	/** Dispatch IDE: the detail takes the whole pane when there is no file or no room beside it. */
	private readonly _dispatchFit: DispatchDockedDetailFit;

	constructor(
		private readonly editorPartContainer: HTMLElement,
		private readonly auxiliaryBarPart: Part,
		private readonly host: IDockedAuxiliaryBarHost,
	) {
		super();
		const fitHost: IDispatchDockedDetailHost = host;
		this._dispatchFit = new DispatchDockedDetailFit(fitHost);
	}

	/** Dispatch IDE: an editor is about to be shown in the side pane. */
	willShowEditor(editor: EditorInput): void {
		this._dispatchFit.willShow(editor);
	}

	/**
	 * Position the auxiliary bar inside the editor part's right region so the editor
	 * tab bar spans the full width and the editor header ends at the detail panel.
	 */
	layout(): void {
		const auxiliaryBarContainer = this.auxiliaryBarPart.getContainer();
		if (!auxiliaryBarContainer) {
			return;
		}

		// Reparent the auxiliary bar into the editor part once, as an absolutely
		// positioned overlay on the right that moves with the editor part.
		if (!this._docked) {
			this.editorPartContainer.appendChild(auxiliaryBarContainer);
			auxiliaryBarContainer.classList.add('docked-auxiliarybar');
			this._docked = true;
		}

		if (!this.host.isEditorAreaVisible() || !this.host.isAuxiliaryBarVisible()) {
			if (this.host.isEditorAreaVisible()) {
				// Dispatch IDE: a list folded away for room comes back once the pane is wide enough (dispatchDockedDetailFit.ts)
				this._dispatchFit.fills(this.editorPartContainer.getBoundingClientRect().width);
			}
			this._layoutState = undefined;
			auxiliaryBarContainer.style.display = 'none';
			this.host.setEditorContentRightInset(0);
			if (this._sash) {
				this._sash.state = SashState.Disabled;
			}
			return;
		}

		const editorRect = this.editorPartContainer.getBoundingClientRect();
		// Dispatch IDE: or nothing to show beside the detail, or no room for both (dispatchDockedDetailFit.ts)
		const editorContentHidden = !this.host.isEditorVisible() || this._dispatchFit.fills(editorRect.width);
		const auxWidth = editorContentHidden ? editorRect.width : this._getLayoutWidth(this.host.getWidth(), editorRect.width);
		if (editorContentHidden) {
			this._layoutState = undefined;
		}
		const top = this._getTop();
		const height = Math.max(0, editorRect.height - top);

		auxiliaryBarContainer.style.display = '';
		auxiliaryBarContainer.style.position = 'absolute';
		auxiliaryBarContainer.style.right = '0';
		auxiliaryBarContainer.style.top = `${top}px`;
		auxiliaryBarContainer.style.width = `${auxWidth}px`;
		auxiliaryBarContainer.style.height = `${height}px`;

		this.host.setEditorContentRightInset(auxWidth);
		this.auxiliaryBarPart.layout(auxWidth, height, top, editorRect.width - auxWidth);

		this._ensureSash();
		// The real grid sash owns resizing/collapsing when editor content is hidden.
		this._sash!.state = editorContentHidden ? SashState.Disabled : SashState.Enabled;
		this._sash!.layout();
	}

	/** Returns the detail width that fits beside the editor content. */
	static getEffectiveWidth(hostWidth: number, editorWidth: number): number {
		const maxWidth = editorWidth - DockedAuxiliaryBarController.EDITOR_MIN_WIDTH;
		return Math.min(editorWidth, Math.max(DockedAuxiliaryBarController.MIN_WIDTH, Math.min(hostWidth, maxWidth)));
	}

	private _getLayoutWidth(requestedWidth: number, editorWidth: number): number {
		const constrainedWidth = DockedAuxiliaryBarController.getEffectiveWidth(requestedWidth, editorWidth);
		const previous = this._layoutState;
		let auxiliaryBarWidth = constrainedWidth;

		if (previous?.requestedWidth === requestedWidth) {
			if (editorWidth > previous.editorWidth) {
				const editorGrowth = editorWidth - previous.editorWidth;
				const previousEditorContentWidth = previous.editorWidth - previous.auxiliaryBarWidth;
				const editorGrowthBeforeAuxiliaryBar = Math.max(0, DockedAuxiliaryBarController.EDITOR_PREFERRED_WIDTH - previousEditorContentWidth);
				auxiliaryBarWidth = Math.min(constrainedWidth, previous.auxiliaryBarWidth + Math.max(0, editorGrowth - editorGrowthBeforeAuxiliaryBar));
			} else {
				auxiliaryBarWidth = Math.min(previous.auxiliaryBarWidth, constrainedWidth);
			}

			auxiliaryBarWidth = Math.max(Math.min(editorWidth, DockedAuxiliaryBarController.MIN_WIDTH), auxiliaryBarWidth);
		}

		this._layoutState = { requestedWidth, editorWidth, auxiliaryBarWidth };
		return auxiliaryBarWidth;
	}

	private _ensureSash(): void {
		if (this._sash) {
			return;
		}

		const editorPartContainer = this.editorPartContainer;
		const layoutProvider: IVerticalSashLayoutProvider = {
			getVerticalSashLeft: () => {
				const width = editorPartContainer.clientWidth;
				const auxWidth = this.host.isEditorVisible()
					? this._layoutState?.auxiliaryBarWidth ?? DockedAuxiliaryBarController.getEffectiveWidth(this.host.getWidth(), width)
					: width;
				return Math.max(0, width - auxWidth);
			},
			getVerticalSashTop: () => this._getTop(),
			getVerticalSashHeight: () => Math.max(0, editorPartContainer.clientHeight - this._getTop()),
		};

		const sash = this._register(new Sash(editorPartContainer, layoutProvider, { orientation: SashOrientation.VERTICAL }));
		this._sash = sash;

		this._register(sash.onDidStart(() => {
			this._sashStartWidth = this._layoutState?.auxiliaryBarWidth ?? this.host.getWidth();
			this._sashCollapsed = false;
		}));
		this._register(sash.onDidChange((e: ISashEvent) => {
			if (this._sashCollapsed) {
				return;
			}
			// Dragging left (currentX < startX) widens the detail panel.
			const delta = e.startX - e.currentX;
			const width = editorPartContainer.clientWidth;
			const requestedWidth = this._sashStartWidth + delta;
			if (requestedWidth < DockedAuxiliaryBarController.COLLAPSE_WIDTH) {
				this._sashCollapsed = true;
				this.host.hideAuxiliaryBar();
				return;
			}
			this.host.setWidth(DockedAuxiliaryBarController.getEffectiveWidth(requestedWidth, width));
			this.layout();
		}));
		this._register(sash.onDidReset(() => {
			this.host.setWidth(DockedAuxiliaryBarController.DEFAULT_WIDTH);
			this.layout();
		}));
	}

	private _getTop(): number {
		return this.host.getTabsHeight();
	}
}
