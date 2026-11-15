/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the file list's toggle (upstream "Toggle Details", ⌥⌘L) keeps its place in the side pane's tab
 *  strip (kanban, user 2026-10-10: "why does this icon come and go? what is the logic?"). Upstream shows it only
 *  on a tab with a docked detail (Changes, Files, a file) and drops it on Docs, Tasks or a browser page, so the
 *  buttons beside it jumped. Here it is always there: on a tab without a file list (Docs, Tasks, a browser page) the
 *  twin in its place opens the file list and selects what the tab shows when that is a file (user 2026-10-19:
 *  "click it, the file list comes up at the document I am looking at").
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorResourceAccessor } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IExplorerService } from '../../../../../workbench/contrib/files/browser/files.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { SESSIONS_FILES_VIEW_ID } from '../../../files/browser/filesView.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorContext, IsAuxiliaryWindowContext, IsSessionsWindowContext, IsTopRightEditorGroupContext, MainEditorAreaVisibleContext } from '../../../../../workbench/common/contextkeys.js';
import { HasDockedDetailsContext, SinglePaneLayoutEnabledContext } from '../../../../common/contextkeys.js';

/** The toggle's icon: a list of files (upstream: list-selection, which reads as "a list", not "the file list"). */
export const DISPATCH_FILE_LIST_ICON = Codicon.listTree;
export const DISPATCH_FILE_LIST_TITLE = localize2('dispatch.toggleFileList', "Show or Hide File List");

/**
 * The tab in front has a file list: what upstream's detail mapping says (HasDockedDetailsContext), or at once for the
 * managed Changes and Files tabs, whose mapping can lag a second or more behind the switch (the button stayed greyed
 * on Changes meanwhile). By editor id, so this file does not import those inputs.
 */
export const DISPATCH_HAS_FILE_LIST = ContextKeyExpr.or(
	HasDockedDetailsContext,
	ActiveEditorContext.isEqualTo('workbench.editor.agentSessions.sessionChanges'),
	ActiveEditorContext.isEqualTo('workbench.editor.agentSessions.emptyFile'),
)!;

/** The file a tab shows, when it is a file: a browser page at a file:// address, or an editor on a file. */
function fileOfTab(editor: EditorInput | undefined): URI | undefined {
	if (editor instanceof BrowserEditorInput) {
		return editor.url?.startsWith('file://') ? URI.parse(editor.url.split('#')[0]) : undefined;
	}
	const uri = EditorResourceAccessor.getOriginalUri(editor);
	return uri?.scheme === Schemas.file ? uri : undefined;
}

/** The toggle's twin on a tab without a file list: shows the file list, at the tab's file when it has one. */
export function registerDispatchFileListUnavailable(order: number): IDisposable {
	return registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.agentSessions.dispatchShowInFileList',
				title: localize2('dispatch.showInFileList', "Show in File List"),
				tooltip: localize('dispatch.showInFileListTooltip', "Show in File List: the file list, at this tab's file"),
				icon: DISPATCH_FILE_LIST_ICON,
				f1: false,
				menu: {
					id: MenuId.EditorTitleLayout,
					group: 'navigation',
					order,
					when: ContextKeyExpr.and(
						IsSessionsWindowContext,
						IsAuxiliaryWindowContext.toNegated(),
						IsTopRightEditorGroupContext,
						SinglePaneLayoutEnabledContext,
						MainEditorAreaVisibleContext,
						DISPATCH_HAS_FILE_LIST.negate()),
				},
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const file = fileOfTab(accessor.get(IEditorService).activeEditor);
			const explorer = accessor.get(IExplorerService);
			await accessor.get(IViewsService).openView(SESSIONS_FILES_VIEW_ID, true);
			if (file) {
				await explorer.select(file, true);
			}
		}
	});
}
