/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side pane with no tab in it (a new session before its first message: no Now tab yet, user
 *  2026-10-10) says what it is for instead of being a blank block (0.9.2, task-qx5ln): Dispatch's logo in the middle
 *  of the pane, as the empty editor has it (the person missed it, blurt DIS-9 10-31), and the two lines under it; gone
 *  as soon as a tab joins. The logo is the Assistant's mark (dispatchBlocks.ts): the first time a window shows it,
 *  its blocks drop in; after that it stands formed.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchEmptySidePane.css';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { assistantMark } from '../../dispatchBlocks/browser/dispatchBlocks.js';

/** The logo's width, px: its blocks about 18px. */
const MARK_SIZE = 104;

class DispatchEmptySidePane extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchEmptySidePane';

	constructor(
		@IAgentWorkbenchLayoutService layoutService: IAgentWorkbenchLayoutService,
		@IEditorGroupsService groups: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
	) {
		super();
		const part = layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (!part || !layoutService.isSinglePaneLayoutEnabled) {
			return;
		}
		const empty = dom.append(part, dom.$('.dispatch-side-empty', { role: 'status' }));
		const logo = dom.append(empty, dom.$('.dispatch-side-empty-logo'));
		dom.append(empty, dom.$('b', undefined, localize('dispatchSideEmpty.title', "Nothing here yet")));
		dom.append(empty, dom.$('span', undefined, localize('dispatchSideEmpty.body', "Send a message to see its plan and work here.")));
		this._register(toDisposable(() => empty.remove()));
		const update = () => {
			const none = groups.mainPart.groups.every(g => g.isEmpty);
			const show = none && layoutService.isVisible(Parts.EDITOR_PART, mainWindow) && !layoutService.isVisible(Parts.AUXILIARYBAR_PART);
			// drawn when it comes into view, so its drop is seen (not run while the pane was hidden)
			if (show && !empty.classList.contains('shown')) {
				dom.clearNode(logo);
				logo.appendChild(assistantMark(MARK_SIZE, 'side-empty'));
			}
			empty.classList.toggle('shown', show);
		};
		this._register(Event.any(editorService.onDidEditorsChange, layoutService.onDidChangePartVisibility, groups.onDidAddGroup, groups.onDidRemoveGroup)(update));
		update();
	}
}

registerWorkbenchContribution2(DispatchEmptySidePane.ID, DispatchEmptySidePane, WorkbenchPhase.AfterRestored);
