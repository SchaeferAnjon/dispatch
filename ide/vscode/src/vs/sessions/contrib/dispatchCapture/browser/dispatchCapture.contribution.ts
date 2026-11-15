/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the person asks for in a chat goes on the board by itself and lines up behind the work
 *  already running (patches/415-next-up.patch; kanban design/chat-capture, direction B, task-tix5).
 *  Every message the person sends in any session goes to `dispatch capture note` with the session's folder; the
 *  line under the message (dispatchCaptureLine.ts) shows what was noted, a project's Tasks tab and a session's Now
 *  show the line (dispatchNextUp.ts). Starting the next one is chatd's (`dispatch nextup tick`).
 *--------------------------------------------------------------------------------------------*/

import { isDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import './media/dispatchCapture.css';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { setDispatchRequestLine } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchRequestHook.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { DispatchCaptureLines } from './dispatchCaptureLine.js';
import { isChatSession } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { captureModel, onDidChangeNextUp } from './dispatchCaptureModel.js';

/** How often the lines read the board again while the window is in front (a thing starts, gets delivered). */
const REFRESH_MS = 20_000;

class DispatchCaptureContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchCapture';

	constructor(
		@ICommandService commandService: ICommandService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@INotificationService notificationService: INotificationService,
		@ISessionsManagementService management: ISessionsManagementService,
	) {
		super();
		const model = captureModel(commandService);
		const lines = this._register(new DispatchCaptureLines(model, commandService, contextMenuService, notificationService));
		setDispatchRequestLine(lines);
		this._register(toDisposable(() => setDispatchRequestLine(undefined)));
		this._register(management.onDidSendRequest(e => {
			const text = e.options?.query ?? '';
			if (!text.trim()) {
				return;
			}
			const folder = e.session.workspace.get()?.folders[0];
			const cwd = (folder?.workingDirectory ?? folder?.root)?.fsPath;
			// a session without a project folder (Chats): nothing of it goes into a project or lines up (task-p0za2)
			void model.note(text, e.session.resource.toString(), cwd, e.session.title.get(), isChatSession(e.session));
		}));
		this._register(onDidChangeNextUp.event(() => {
			void model.refresh();
			if (model.line) {
				void model.refreshLine();
			}
		}));
		const timer = mainWindow.setInterval(() => {
			if (mainWindow.document.visibilityState === 'visible' && !isDispatchWindowIdle() && mainWindow.document.querySelector('.dispatch-capture:not(.empty)')) {
				void model.refresh();
			}
		}, REFRESH_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
	}
}

registerWorkbenchContribution2(DispatchCaptureContribution.ID, DispatchCaptureContribution, WorkbenchPhase.AfterRestored);
