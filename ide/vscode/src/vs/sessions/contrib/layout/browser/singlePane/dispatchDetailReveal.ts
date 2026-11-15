/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side pane's detail (Changes / Files, with the Tasks and Docs tabs) shown only once one of
 *  its view containers has something to show (150-side-pane.patch). singlePaneExistingSessionStrategy.ts calls
 *  reveal() where it used to show the auxiliary bar at once.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';

export class DispatchDetailReveal extends Disposable {
	/** A reveal waiting for the view containers. */
	private readonly _pending = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly viewDescriptorService: IViewDescriptorService,
		private readonly viewsService: IViewsService,
		private readonly layoutService: IAgentWorkbenchLayoutService,
		private readonly sessionsService: ISessionsService,
	) {
		super();
	}

	/**
	 * Shows the detail only once one of its view containers has something to show.
	 * Right after the window opens on a created session the Files / Changes containers are not
	 * active yet, and showing the detail then painted an empty pane (with the editor's Files
	 * placeholder showing through) until they were. Waits at most 5 s.
	 */
	reveal(): void {
		const reveal = () => {
			this._pending.clear();
			const session = this.sessionsService.activeSession.get();
			if (!session || !session.isCreated.get() || session.isQuickChat?.get() || this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
				return;
			}
			const suppression = this.layoutService.suppressEditorPartAutoVisibility();
			try {
				this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			} finally {
				suppression.dispose();
			}
		};
		if (this._hasActiveDetailContainer()) {
			reveal();
			return;
		}
		const store = new DisposableStore();
		this._pending.value = store;
		const models = new DisposableStore();
		store.add(models);
		const watch = () => {
			if (this._hasActiveDetailContainer()) {
				reveal();
				return;
			}
			models.clear();
			for (const container of this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar)) {
				models.add(this.viewDescriptorService.getViewContainerModel(container).onDidChangeActiveViewDescriptors(() => watch()));
			}
		};
		store.add(this.viewDescriptorService.onDidChangeViewContainers(() => watch()));
		store.add(this.viewDescriptorService.onDidChangeContainerLocation(() => watch()));
		// the detail shown or hidden by something else, or the whole pane toggled, meanwhile: theirs wins
		store.add(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.AUXILIARYBAR_PART) {
				this._pending.clear();
			}
		}));
		store.add(this.layoutService.onWillToggleSidePane(() => this._pending.clear()));
		const timer = setTimeout(reveal, 5000);
		store.add({ dispose: () => clearTimeout(timer) });
		watch();
	}

	private _hasActiveDetailContainer(): boolean {
		return this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar)
			.some(container => this.viewsService.isViewContainerActive(container.id));
	}
}
