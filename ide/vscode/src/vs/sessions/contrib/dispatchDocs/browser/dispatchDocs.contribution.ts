/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Docs tab next to Changes and Files, and the open-path commands
 *  (patches/435-docs.patch).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Event } from '../../../../base/common/event.js';
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
import { DispatchDocsEditor, DispatchDocsEditorInput, DispatchDocsEditorSerializer, DispatchDocTabEditor, DispatchDocTabInput, DispatchDocTabSerializer } from './dispatchDocsEditor.js';
import './dispatchOpenPath.js';

export const DISPATCH_DOCS_TAB_COMMAND_ID = 'workbench.action.agentSessions.dispatchDocsTab';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DispatchDocsEditor, DispatchDocsEditor.ID, localize('dispatchDocs.editor', "Docs")),
	[new SyncDescriptor(DispatchDocsEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DispatchDocsEditorInput.ID, DispatchDocsEditorSerializer);
// a document opened from Docs, in a tab of its own (kept with the session's tabs)
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DispatchDocTabEditor, DispatchDocTabEditor.ID, localize('dispatchDocs.document', "Document")),
	[new SyncDescriptor(DispatchDocTabInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(DispatchDocTabInput.ID, DispatchDocTabSerializer);

const docsTabWhen = ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated());
/** True while the session's editor group has no Docs tab: the + menu offers Docs only then (like Files). */
export const DispatchDocsTabMissingContext = new RawContextKey<boolean>('dispatchDocsTabMissing', true, localize('dispatchDocsTabMissing', "Whether the session's editor group has no Docs tab"));

async function openDocsTab(accessor: ServicesAccessor, background = false): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const group = groups.mainPart.activeGroup;
	const existing = group.editors.find(e => e instanceof DispatchDocsEditorInput);
	if (existing) {
		if (!background) {
			await editorService.openEditor(existing, { pinned: true }, group);
		}
		return;
	}
	await editorService.openEditor(instantiationService.createInstance(DispatchDocsEditorInput), {
		pinned: true,
		index: group.count,
		inactive: background,
		preserveFocus: background,
	}, group);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_DOCS_TAB_COMMAND_ID,
			title: localize2('dispatchDocs.tab', "Docs"),
			category: SessionsCategories.Sessions,
			icon: Codicon.book,
			f1: true,
			precondition: docsTabWhen,
			menu: {
				id: Menus.SessionsEditorTabsBarAddTab,
				group: 'navigation',
				order: 4,
				when: ContextKeyExpr.and(docsTabWhen, IsTopRightEditorGroupContext, DispatchDocsTabMissingContext),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return openDocsTab(accessor);
	}
});

/**
 * The Docs tab is there by default: when a session with a folder becomes the active one and the
 * side pane's tab strip has tabs, a Docs tab joins them in the background (it never takes focus
 * or the active tab). Like Changes and Files it has no close button.
 */
class DispatchDocsTabByDefault extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchDocsTabByDefault';

	constructor(
		@IAgentWorkbenchLayoutService layoutService: IAgentWorkbenchLayoutService,
		@ISessionsService sessionsService: ISessionsService,
		@IEditorGroupsService groups: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		// the + menu's Docs entry: only while the tab is not there
		const missing = DispatchDocsTabMissingContext.bindTo(contextKeyService);
		const updateMissing = () => missing.set(!groups.mainPart.activeGroup.editors.some(e => e instanceof DispatchDocsEditorInput));
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
			if (!group.editors.some(e => e instanceof DispatchDocsEditorInput)) {
				// Dispatch IDE: a default tab joining the strip never reveals the editor (a closed side pane stays closed)
				const suppression = layoutService.suppressEditorPartAutoVisibility();
				void instantiationService.invokeFunction(openDocsTab, true).finally(() => suppression.dispose());
			}
		};
		this._register(autorun(reader => {
			const session = sessionsService.activeSession.read(reader);
			const workspace = session?.workspace.read(reader);
			const key = `${session?.resource.toString()}|${workspace?.uri.toString()}`;
			// after the session's tabs have been restored into the group
			for (const ms of [300, 1200]) {
				setTimeout(() => ensure(key), ms);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchDocsTabByDefault.ID, DispatchDocsTabByDefault, WorkbenchPhase.AfterRestored);
