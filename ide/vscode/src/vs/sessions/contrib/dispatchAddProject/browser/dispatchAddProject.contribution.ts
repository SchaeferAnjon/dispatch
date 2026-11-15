/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Add project (patches/440-projects.patch). The commands that open the dialog
 *  (dispatchAddProject.ts): `dispatch.addProject.show` (answers with the project that was added, for the
 *  Projects page's New Project) and `dispatch.addProject.startSession` (the new session's folder menu:
 *  add a project, then start the session in it).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { refreshDispatchProjectsRegistry } from '../../sessions/browser/dispatchProjectsModel.js';
import { AddProjectDialog } from './dispatchAddProject.js';
import { AddProjectWay, IAddProjectAnswer } from './dispatchAddProjectModel.js';

export const DISPATCH_ADD_PROJECT_COMMAND = 'dispatch.addProject.show';
export const DISPATCH_ADD_PROJECT_SESSION_COMMAND = 'dispatch.addProject.startSession';

let open: Promise<IAddProjectAnswer | undefined> | undefined;

function showDialog(accessor: ServicesAccessor, way?: AddProjectWay): Promise<IAddProjectAnswer | undefined> {
	// one dialog at a time: a second request gets the first one's answer
	if (!open) {
		const dialog = accessor.get(IInstantiationService).createInstance(AddProjectDialog, way);
		open = dialog.show().finally(() => { open = undefined; });
	}
	return open;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DISPATCH_ADD_PROJECT_COMMAND, title: localize2('dispatchAddProject.command', "Add Project...") });
	}
	override async run(accessor: ServicesAccessor, way?: AddProjectWay): Promise<IAddProjectAnswer | undefined> {
		return showDialog(accessor, way);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DISPATCH_ADD_PROJECT_SESSION_COMMAND, title: localize2('dispatchAddProject.commandSession', "Add Project and Start a Session...") });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const sessionsPartService = accessor.get(ISessionsPartService);
		const authority = accessor.get(IWorkbenchEnvironmentService).remoteAuthority;
		const added = await showDialog(accessor);
		if (!added?.dir) {
			return;
		}
		await refreshDispatchProjectsRegistry();
		await sessionsService.openNewSession({ folderUri: authority ? URI.from({ scheme: 'vscode-remote', authority, path: added.dir }) : URI.file(added.dir) });
		sessionsPartService.focusSession(sessionsService.activeSession.get());
	}
});
