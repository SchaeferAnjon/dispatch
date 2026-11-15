/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a terminal asked to show (an extension's terminal.show(): Settings › Agents › OpenCode ›
 *  Add Provider…, which runs `opencode auth login`, a sign-in, the setup wizard's Add provider; the status bar's
 *  Terminal) while a page covers the middle of the Agents window (Settings, the setup wizard, Waiting for you…):
 *  the bottom panel shows under the page, which stays, and the terminal takes the focus. A page used to cover the
 *  panel for as long as it was up (workbench.ts), so Add Provider… waited for a provider and a key typed into a
 *  terminal no one could see (the new-user run on the 0.9.1 release, kanban task-7mmi3).
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';

class DispatchTerminalOverPage extends Disposable {

	static readonly ID = 'workbench.contrib.dispatchTerminalOverPage';

	constructor(
		@ITerminalGroupService terminalGroupService: ITerminalGroupService,
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(terminalGroupService.onDidShow(() => {
			if (!customViewService.activeCustomView.get() || customViewService.bottomPanel.get()) {
				return;
			}
			customViewService.setBottomPanel(true);
			// the panel did not take the focus while the page covered it
			void terminalGroupService.activeInstance?.focusWhenReady(true);
		}));
	}
}

registerWorkbenchContribution2(DispatchTerminalOverPage.ID, DispatchTerminalOverPage, WorkbenchPhase.AfterRestored);
