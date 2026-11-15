/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the task graph, the task page and a project's Archive (patches/430-tasks.patch),
 *  custom views in the middle of the Agents window like Waiting for you. `_dispatch.openTaskGraph(scope?,
 *  project?)`, `_dispatch.openSessionTaskGraph(resource)`, `_dispatch.openTask(taskId)` and
 *  `_dispatch.openTaskArchive(project)` show them (the Tasks tab, the sidebar's hovers and the task
 *  icon on a project's row, a task link in a reply, a node on the graph, the project page); "Task
 *  Graph" is in the command palette.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { CustomViewVisibleContext } from '../../../common/contextkeys.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionSection, SessionSectionToolbarMenuId, SessionSectionTypeContext } from '../../sessions/browser/views/sessionsList.js';
import { DISPATCH_OPEN_SESSION_TASK_GRAPH_COMMAND, projectOfSection } from '../../dispatchTasks/browser/dispatchTasksHover.js';
import {
	DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, DISPATCH_OPEN_TASK_COMMAND, DISPATCH_OPEN_TASK_GRAPH_COMMAND, dispatchArchiveProject, dispatchGraphProject, dispatchGraphScope,
	dispatchTaskPageBack, dispatchTaskPageTarget, DispatchTaskPageFrom, IDispatchTaskProject
} from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { DISPATCH_TASK_ARCHIVE_VIEW_ID, DispatchTaskArchiveView } from './dispatchTaskArchive.js';
import { DISPATCH_TASK_GRAPH_VIEW_ID, DispatchTaskGraphView } from './dispatchTaskGraphView.js';
import { DISPATCH_TASK_PAGE_VIEW_ID, DispatchTaskPageFromGraphContext, DispatchTaskPageView } from './dispatchTaskPage.js';

class DispatchTaskViews extends Disposable {
	static readonly ID = 'dispatch.contrib.taskViews';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
		@ISessionsService sessionsService: ISessionsService,
	) {
		super();
		this._register(customViewService.registerCustomView({ id: DISPATCH_TASK_GRAPH_VIEW_ID, ctor: new SyncDescriptor(DispatchTaskGraphView) }, { restore: false }));
		this._register(customViewService.registerCustomView({ id: DISPATCH_TASK_PAGE_VIEW_ID, ctor: new SyncDescriptor(DispatchTaskPageView) }, { restore: false }));
		this._register(customViewService.registerCustomView({ id: DISPATCH_TASK_ARCHIVE_VIEW_ID, ctor: new SyncDescriptor(DispatchTaskArchiveView) }, { restore: false }));
		// a project chosen from the sidebar holds until another session becomes active
		this._register(autorun(reader => {
			const id = sessionsService.activeSession.read(reader)?.sessionId;
			const chosen = dispatchGraphProject.get();
			if (chosen && chosen.activeSession !== id) {
				dispatchGraphProject.set(undefined, undefined);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchTaskViews.ID, DispatchTaskViews, WorkbenchPhase.AfterRestored);

function isProject(v: unknown): v is IDispatchTaskProject {
	return !!v && typeof v === 'object' && typeof (v as IDispatchTaskProject).name === 'string' && !!(v as IDispatchTaskProject).name;
}

/**
 * The graph page. A project draws that project; a scope alone goes back to the active session's
 * project (the Tasks tab); nothing keeps what it drew (the task page's way back).
 */
function openGraph(accessor: ServicesAccessor, scope?: unknown, project?: unknown): void {
	if (scope === 'project' || scope === 'session') {
		dispatchGraphScope.set(scope, undefined);
		const active = accessor.get(ISessionsService).activeSession.get()?.sessionId;
		dispatchGraphProject.set(scope === 'project' && isProject(project)
			? { name: project.name, label: project.label || project.name, activeSession: active }
			: undefined, undefined);
	}
	accessor.get(ICustomViewService).showCustomView(DISPATCH_TASK_GRAPH_VIEW_ID);
}

CommandsRegistry.registerCommand(DISPATCH_OPEN_TASK_GRAPH_COMMAND, openGraph);

// a session's row in the sidebar: that session, then its line of the graph
CommandsRegistry.registerCommand(DISPATCH_OPEN_SESSION_TASK_GRAPH_COMMAND, async (accessor, resource: unknown) => {
	if (typeof resource !== 'string' || !resource) {
		return;
	}
	const sessionsService = accessor.get(ISessionsService);
	const customViewService = accessor.get(ICustomViewService);
	if (sessionsService.activeSession.get()?.resource.toString() !== resource) {
		await sessionsService.openSession(URI.parse(resource));
	}
	dispatchGraphScope.set('session', undefined);
	dispatchGraphProject.set(undefined, undefined);
	customViewService.showCustomView(DISPATCH_TASK_GRAPH_VIEW_ID);
});

CommandsRegistry.registerCommand(DISPATCH_OPEN_TASK_COMMAND, (accessor, taskId: unknown, from?: unknown) => {
	if (typeof taskId !== 'string' || !/^[a-z][a-z0-9]*-[a-z0-9]{2,8}$/.test(taskId)) {
		return;
	}
	// 'waiting': opened from Waiting for you (its page leads back there)
	const back = from === 'archive' || from === 'graph' || from === 'project' || from === 'waiting' ? from : 'session';
	dispatchTaskPageBack.set(back as DispatchTaskPageFrom, undefined);
	dispatchTaskPageTarget.set(taskId, undefined);
	accessor.get(ICustomViewService).showCustomView(DISPATCH_TASK_PAGE_VIEW_ID);
});

CommandsRegistry.registerCommand(DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, (accessor, project: unknown) => {
	if (!isProject(project)) {
		return;
	}
	dispatchArchiveProject.set({ name: project.name, label: project.label || project.name }, undefined);
	accessor.get(ICustomViewService).showCustomView(DISPATCH_TASK_ARCHIVE_VIEW_ID);
});

// Esc on a task page opened from the graph goes back to the graph, scrolled as it was (else Esc goes
// back to the session, dispatchCustomViewBack.ts); the page's "‹ Task graph" does the same
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.tasks.backToGraph',
			title: localize2('dispatchTaskGraph.back', "Back to the Task Graph"),
			precondition: DispatchTaskPageFromGraphContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(IsSessionsWindowContext, CustomViewVisibleContext, DispatchTaskPageFromGraphContext, InputFocusedContext.negate()),
			},
		});
	}
	override run(accessor: ServicesAccessor): void {
		openGraph(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.tasks.showGraph', title: localize2('dispatchTaskGraph.show', "Task Graph"), f1: true });
	}
	override run(accessor: ServicesAccessor): void {
		openGraph(accessor, 'project');
	}
});

// the task icon on a project's row in the sidebar, beside + (New Session) and Mark All Done
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.tasks.showProjectGraph',
			title: localize2('dispatchTaskGraph.showProject', "Task Graph"),
			// the icon the cards' "Task graph" and the Tasks tab's Graph use
			icon: Codicon.gitMerge,
			menu: [{
				id: SessionSectionToolbarMenuId,
				group: 'navigation',
				order: 0.5,
				when: ContextKeyExpr.equals(SessionSectionTypeContext.key, 'workspace'),
			}],
		});
	}
	override run(accessor: ServicesAccessor, section?: ISessionSection): void {
		const project = section && projectOfSection(section);
		if (project) {
			openGraph(accessor, 'project', { name: project.name, label: project.label });
		} else {
			openGraph(accessor, 'project');
		}
	}
});
