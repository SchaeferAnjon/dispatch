/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the History tab next to Changes, Files, Docs and Tasks (patches/450-history.patch).
 *  Every agent session on this Mac, searchable, grouped by project; nothing is imported by looking.
 *  It opens from the side pane's + menu and from the command palette (Sessions: History).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
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
import { SessionsCategories } from '../../../common/categories.js';
import { DispatchHistoryEditor, DispatchHistoryEditorInput, DispatchHistoryEditorSerializer } from './dispatchHistoryEditor.js';

export const DISPATCH_HISTORY_TAB_COMMAND_ID = 'workbench.action.agentSessions.dispatchHistoryTab';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DispatchHistoryEditor, DispatchHistoryEditor.ID, localize('dispatchHistory.editor', "History")),
	[new SyncDescriptor(DispatchHistoryEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DispatchHistoryEditorInput.ID, DispatchHistoryEditorSerializer);

const historyTabWhen = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated());
/** True while the side pane has no History tab: the + menu offers it only then. */
export const DispatchHistoryTabMissingContext = new RawContextKey<boolean>('dispatchHistoryTabMissing', true, localize('dispatchHistoryTabMissing', "Whether the side pane has no History tab"));

async function openHistoryTab(accessor: ServicesAccessor): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const group = groups.mainPart.activeGroup;
	const existing = group.editors.find(e => e instanceof DispatchHistoryEditorInput);
	await editorService.openEditor(existing ?? instantiationService.createInstance(DispatchHistoryEditorInput), existing ? { pinned: true } : { pinned: true, index: group.count }, group);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_HISTORY_TAB_COMMAND_ID,
			title: localize2('dispatchHistory.tab', "History"),
			category: SessionsCategories.Sessions,
			icon: Codicon.history,
			f1: true,
			precondition: historyTabWhen,
			menu: {
				id: Menus.SessionsEditorTabsBarAddTab,
				group: 'navigation',
				order: 6,
				when: ContextKeyExpr.and(historyTabWhen, IsTopRightEditorGroupContext, DispatchHistoryTabMissingContext),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return openHistoryTab(accessor);
	}
});

class DispatchHistoryTabState extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchHistoryTabState';

	constructor(
		@IEditorGroupsService groups: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const missing = DispatchHistoryTabMissingContext.bindTo(contextKeyService);
		const update = () => missing.set(!groups.mainPart.activeGroup.editors.some(e => e instanceof DispatchHistoryEditorInput));
		this._register(Event.any(editorService.onDidEditorsChange, groups.onDidChangeActiveGroup)(update));
		update();
	}
}

registerWorkbenchContribution2(DispatchHistoryTabState.ID, DispatchHistoryTabState, WorkbenchPhase.AfterRestored);
