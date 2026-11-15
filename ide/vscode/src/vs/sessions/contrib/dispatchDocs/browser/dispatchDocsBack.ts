/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "‹ Docs" above a tab that was opened from the Docs tab or by `dispatch ide show`
 *  (kanban app/cli/ide_show.py, patches/435-docs.patch). The link sits in the side
 *  pane's editor header, where Changes keeps its Versions picker, and brings the Docs tab back.
 *  Only the tabs {@link dispatchOpenPath} opened with `fromDocs` get it; a file opened any other
 *  way does not.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchDocsBack.css';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';

/** The Docs tab's command (dispatchDocs.contribution.ts); by id, so this file does not import that one. */
const DOCS_TAB_COMMAND_ID = 'workbench.action.agentSessions.dispatchDocsTab';

export const DispatchOpenedFromDocsContext = new RawContextKey<boolean>('dispatchOpenedFromDocs', false, localize('dispatchOpenedFromDocs', "Whether the active tab was opened from the Docs tab"));

const fromDocs = new WeakSet<EditorInput>();
const onDidMark = new Emitter<void>();

/** Called by dispatchOpenPath with the tab it opened for the Docs tab or `dispatch ide show`. */
export function markOpenedFromDocs(input: EditorInput | undefined): void {
	if (input) {
		fromDocs.add(input);
		onDidMark.fire();
	}
}

class DispatchDocsBackContext extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchDocsBack';

	constructor(
		@IEditorService editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const key = DispatchOpenedFromDocsContext.bindTo(contextKeyService);
		const update = () => {
			const active = editorService.activeEditor;
			key.set(!!active && fromDocs.has(active));
		};
		this._register(editorService.onDidActiveEditorChange(update));
		this._register(onDidMark.event(update));
		update();
	}
}

registerWorkbenchContribution2(DispatchDocsBackContext.ID, DispatchDocsBackContext, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agentSessions.dispatchBackToDocs',
			// no icon: the header's toolbar then shows the words, like "‹ Projects" on a project's page
			title: localize2('dispatchDocs.back', "‹ Docs"),
			tooltip: localize('dispatchDocs.backTooltip', "Back to Docs"),
			f1: false,
			precondition: IsSessionsWindowContext,
			menu: {
				id: Menus.SessionsEditorHeaderPrimary,
				group: 'navigation',
				order: 0,
				when: ContextKeyExpr.and(IsSessionsWindowContext, DispatchOpenedFromDocsContext),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(DOCS_TAB_COMMAND_ID);
	}
});
