/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Tasks tab next to Changes, Files and Docs (patches/430-tasks.patch).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext, IsTopRightEditorGroupContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { SessionsCategories } from '../../../common/categories.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { DispatchTasksEditor, DispatchTasksEditorInput, DispatchTasksEditorSerializer } from './dispatchTasksEditor.js';

export const DISPATCH_TASKS_TAB_COMMAND_ID = 'workbench.action.agentSessions.dispatchTasksTab';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DispatchTasksEditor, DispatchTasksEditor.ID, localize('dispatchTasks.editor', "Tasks")),
	[new SyncDescriptor(DispatchTasksEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DispatchTasksEditorInput.ID, DispatchTasksEditorSerializer);

const tasksTabWhen = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated());
/** True while the session's editor group has no Tasks tab: the + menu offers Tasks only then. */
export const DispatchTasksTabMissingContext = new RawContextKey<boolean>('dispatchTasksTabMissing', true, localize('dispatchTasksTabMissing', "Whether the session's editor group has no Tasks tab"));

async function openTasksTab(accessor: ServicesAccessor, background = false): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const group = groups.mainPart.activeGroup;
	const existing = group.editors.find(e => e instanceof DispatchTasksEditorInput);
	if (existing) {
		if (!background) {
			await editorService.openEditor(existing, { pinned: true }, group);
		}
		return;
	}
	await editorService.openEditor(instantiationService.createInstance(DispatchTasksEditorInput), {
		pinned: true,
		index: group.count,
		inactive: background,
		preserveFocus: background,
	}, group);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_TASKS_TAB_COMMAND_ID,
			title: localize2('dispatchTasks.tab', "Tasks"),
			category: SessionsCategories.Sessions,
			icon: Codicon.checklist,
			f1: true,
			precondition: tasksTabWhen,
			menu: {
				id: Menus.SessionsEditorTabsBarAddTab,
				group: 'navigation',
				order: 5,
				when: ContextKeyExpr.and(tasksTabWhen, IsTopRightEditorGroupContext, DispatchTasksTabMissingContext),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return openTasksTab(accessor);
	}
});

/**
 * The Tasks tab is there by default, like Docs: when a session with a folder becomes the active one
 * and the side pane's tab strip has tabs, a Tasks tab joins them in the background.
 */
class DispatchTasksTabByDefault extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchTasksTabByDefault';

	constructor(
		@IAgentWorkbenchLayoutService layoutService: IAgentWorkbenchLayoutService,
		@ISessionsService sessionsService: ISessionsService,
		@IEditorGroupsService groups: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const missing = DispatchTasksTabMissingContext.bindTo(contextKeyService);
		const updateMissing = () => missing.set(!groups.mainPart.activeGroup.editors.some(e => e instanceof DispatchTasksEditorInput));
		this._register(Event.any(editorService.onDidEditorsChange, groups.onDidChangeActiveGroup)(updateMissing));
		updateMissing();
		if (!layoutService.isSinglePaneLayoutEnabled) {
			return;
		}
		let shown: string | undefined;
		const ensure = (key: string) => {
			const session = sessionsService.activeSession.get();
			const group = groups.mainPart.activeGroup;
			if (shown === key || !session?.workspace.get()?.folders.length || group.count === 0) {
				return;
			}
			shown = key;
			if (!group.editors.some(e => e instanceof DispatchTasksEditorInput)) {
				// Dispatch IDE: a default tab joining the strip never reveals the editor (a closed side pane stays closed)
				const suppression = layoutService.suppressEditorPartAutoVisibility();
				void instantiationService.invokeFunction(openTasksTab, true).finally(() => suppression.dispose());
			}
		};
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			const workspace = session?.workspace.read(reader);
			const key = `${session?.resource.toString()}|${workspace?.uri.toString()}`;
			// after the session's tabs (and the Docs tab) are in the group
			for (const ms of [500, 1500]) {
				setTimeout(() => ensure(key), ms);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchTasksTabByDefault.ID, DispatchTasksTabByDefault, WorkbenchPhase.AfterRestored);
