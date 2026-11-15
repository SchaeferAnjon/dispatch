/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../../base/common/network.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { DiffEditorInput } from '../../../../../workbench/common/editor/diffEditorInput.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { CustomEditorInput } from '../../../../../workbench/contrib/customEditor/browser/customEditorInput.js';
import { FileEditorInput } from '../../../../../workbench/contrib/files/browser/editors/fileEditorInput.js';
import { MultiDiffEditorInput } from '../../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { WebviewInput } from '../../../../../workbench/contrib/webviewPanel/browser/webviewEditorInput.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { ISessionChangesService } from '../../../changes/browser/sessionChangesService.js';
import { EmptyFileEditorInput } from '../../../editor/browser/emptyFileEditorInput.js';

const MARKDOWN_EDITOR_VIEW_TYPES = new Set([
	'markdown.preview',
	'vscode.markdown.editor',
	'vscode.markdown.preview.editor',
]);
const PULL_REQUEST_OVERVIEW_VIEW_TYPE = 'PullRequestOverview';
const ISSUE_OVERVIEW_VIEW_TYPE = 'IssueOverview';

/** Dispatch IDE: the Docs, Tasks and Now tabs that join every workspace session's tab strip (dispatchDocs / dispatchTasks / dispatchNow). */
const DISPATCH_DEFAULT_TAB_TYPE_IDS = new Set(['workbench.editors.dispatch.docs', 'workbench.editors.dispatch.tasks', 'workbench.editors.dispatch.now']);

/** Dispatch IDE: whether `editor` is the default Docs or Tasks tab. They stay in the strip like Changes and Files (a Details-only pane keeps them) and never count as something the user opened. */
export function isDispatchDefaultTab(editor: EditorInput): boolean {
	return DISPATCH_DEFAULT_TAB_TYPE_IDS.has(editor.typeId);
}

/** Whether every group in the main editor part is empty (used by both the detail-panel and side-pane-visibility logic to detect an empty side pane). */
export function isMainPartEmpty(editorGroupsService: IEditorGroupsService): boolean {
	for (const group of editorGroupsService.mainPart.groups) {
		if (!group.isEmpty) {
			return false;
		}
	}
	return true;
}

/** Whether `editor` is (or shows) a managed Changes multi-diff for some session. Shared by the New/Existing detail-panel mapping. */
export function isChangesEditorInput(editor: EditorInput, sessionChangesService: ISessionChangesService): boolean {
	if (editor instanceof DiffEditorInput || editor instanceof MultiDiffEditorInput) {
		return true;
	}
	const resource = editor.resource;
	return !!resource && sessionChangesService.getSessionResource(resource) !== undefined;
}

/** Whether `editor` is a file-like editor (the empty Files placeholder, a real file, or a markdown preview). Shared by the New/Existing detail-panel mapping. */
export function isFileEditorInput(editor: EditorInput): boolean {
	if (editor instanceof WebviewInput) {
		return MARKDOWN_EDITOR_VIEW_TYPES.has(editor.viewType)
			|| MARKDOWN_EDITOR_VIEW_TYPES.has(editor.providerId ?? '')
			|| (editor instanceof CustomEditorInput && editor.resource?.scheme === Schemas.untitled);
	}
	return editor instanceof EmptyFileEditorInput || editor instanceof FileEditorInput || editor.resource?.scheme === Schemas.untitled;
}

/** Whether `editor` owns its full presentation and must hide the docked Details panel. */
export function isEditorWithoutDockedDetails(editor: EditorInput): boolean {
	return editor instanceof BrowserEditorInput
		|| (editor instanceof CustomEditorInput && editor.resource?.scheme !== Schemas.untitled)
		|| (editor instanceof WebviewInput
			&& (editor.viewType === PULL_REQUEST_OVERVIEW_VIEW_TYPE
				|| editor.providerId === PULL_REQUEST_OVERVIEW_VIEW_TYPE
				|| editor.viewType === ISSUE_OVERVIEW_VIEW_TYPE
				|| editor.providerId === ISSUE_OVERVIEW_VIEW_TYPE))
		// Dispatch IDE: the Docs tab takes the whole side pane (its list and reader), never half of it
		// with Changes or Files docked beside it (435-docs.patch)
		|| editor.typeId === 'workbench.editors.dispatch.docs'
		// Dispatch IDE: a document's own tab too (dispatchDocsInput.ts)
		|| editor.typeId === 'workbench.editors.dispatch.doc'
		// Dispatch IDE: Now and Tasks have no file list either; leaving Changes for them must not leave its list as a
		// column beside them (task-e1qsa, 「切到 Now/Tasks，右边残留一栏 Changes / No changed files」)
		|| editor.typeId === 'workbench.editors.dispatch.now'
		|| editor.typeId === 'workbench.editors.dispatch.tasks';
}

/** Dispatch IDE: a document opened from Docs in a tab of its own; it stays in the strip while the editor area is folded away. */
export function isDispatchDocTab(editor: EditorInput): boolean {
	return editor.typeId === 'workbench.editors.dispatch.doc';
}
