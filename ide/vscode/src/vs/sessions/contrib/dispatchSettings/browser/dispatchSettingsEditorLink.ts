/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings' "Editor window settings" (patches/530-editor-settings.patch). Tab completion
 *  and ⌘K act only in the editor window, so they are in its own Settings now (workbench/contrib/dispatchEditorSettings);
 *  this row, and a search here for "tab completion", bring the editor window forward with them shown. dispatch-bridge
 *  carries the request across (`dispatch.editorSettings showInEditor` leaves ide/settings-request; the editor window
 *  that takes it opens its Settings on them).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSettingsEditorLink.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { OPEN_VSCODE_WINDOW_COMMAND_ID } from '../../../common/sessionCommands.js';
import { settingsElsewhere } from './dispatchSettingsState.js';

class DispatchSettingsEditorLink extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchSettingsEditorLink';

	constructor(
		@ICommandService commandService: ICommandService,
		@ILogService logService: ILogService,
	) {
		super();
		settingsElsewhere.editor = async () => {
			try {
				// the request first, so a window that opens now finds it
				await commandService.executeCommand('dispatch.editorSettings', 'showInEditor');
				await commandService.executeCommand(OPEN_VSCODE_WINDOW_COMMAND_ID);
			} catch (e) {
				logService.warn(`[dispatch settings] editor window settings: ${e}`);
			}
		};
		this._register({ dispose: () => { settingsElsewhere.editor = undefined; } });
	}
}

registerWorkbenchContribution2(DispatchSettingsEditorLink.ID, DispatchSettingsEditorLink, WorkbenchPhase.AfterRestored);
