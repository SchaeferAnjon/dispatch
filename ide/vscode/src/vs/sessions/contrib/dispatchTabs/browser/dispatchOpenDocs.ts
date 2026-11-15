/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which of the side pane's open documents keep a tab (task-fif4i, direction B of
 *  design/right-tabs/redesign: "Open list in Docs").
 *
 *  The fixed tabs (Now, Changes, Files, Docs, Tasks, History) always keep theirs. Of everything else opened
 *  next to them (a document of Docs, a page in the integrated browser, a file from Files) the strip shows only
 *  the one in front and the one looked at before it; every open document is a row of the Open group at the top
 *  of the Docs list, under its project, and the Docs tab says how many are open ("Docs 12").
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { DockedEditorInput } from '../../../common/dockedEditorInput.js';
import { DispatchDocsEditorInput, DispatchDocTabInput } from '../../dispatchDocs/browser/dispatchDocsInput.js';

/** How many documents keep a tab: the one in front and the one before it. */
export const STRIP_DOCS = 2;

/** The side pane's own tabs, by type (Now, Tasks and History are not imported here). */
const FIXED_TYPES = new Set([
	DispatchDocsEditorInput.ID,
	'workbench.editors.dispatch.now',
	'workbench.editors.dispatch.tasks',
	'workbench.editors.dispatch.history',
]);

/** A document opened next to the fixed tabs (they are Now, Changes, Files, Docs, Tasks and History). */
export function isOpenDoc(editor: EditorInput): boolean {
	return !(editor instanceof DockedEditorInput) && !FIXED_TYPES.has(editor.typeId);
}

/** The documents that keep a tab: the most recently looked at, the one in front first. */
export function stripDocs(group: IEditorGroup, max = STRIP_DOCS): EditorInput[] {
	return group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).filter(isOpenDoc).slice(0, max);
}

/** Every open document, in the order of the strip. */
export function openDocs(group: IEditorGroup): EditorInput[] {
	return group.getEditors(EditorsOrder.SEQUENTIAL).filter(isOpenDoc);
}

/**
 * Delivery pages and proposals are served by dispatch-bridge's local page server (its Choose A / B records the pick):
 * the page's address there and its file, so its tab and its row in Docs still know which file it is.
 */
const SERVED_KEY = 'dispatch.servedDocs';
const SERVED_MAX = 200;
/** Kept in the window's storage: a tab restored after a reload still knows its file (its icon, name, Open row). */
const servedDocs = new Map<string, string>(readServed());

function readServed(): [string, string][] {
	try {
		const v = JSON.parse(mainWindow.localStorage.getItem(SERVED_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [];
	} catch {
		return []; // no storage (a private window) or a bad value: the map starts empty
	}
}

export function registerServedDoc(url: string, path: string): void {
	const key = url.split('#')[0];
	servedDocs.delete(key);
	servedDocs.set(key, path);
	while (servedDocs.size > SERVED_MAX) {
		servedDocs.delete(servedDocs.keys().next().value!);
	}
	try {
		mainWindow.localStorage.setItem(SERVED_KEY, JSON.stringify([...servedDocs]));
	} catch {
		// storage full or off: this window still knows it
	}
}

/** The file behind an open document, when it is one (a web page is not). */
export function openDocPath(editor: EditorInput): string | undefined {
	if (editor instanceof DispatchDocTabInput) {
		return editor.path;
	}
	if (editor instanceof BrowserEditorInput) {
		const url = editor.url;
		return url?.startsWith('file:') ? URI.parse(url).fsPath : url ? servedDocs.get(url.split('#')[0]) : undefined;
	}
	return editor.resource?.scheme === 'file' ? editor.resource.fsPath : undefined;
}

/** A page from the web (not a file shown in the integrated browser). */
export function isWebDoc(editor: EditorInput): boolean {
	return editor instanceof BrowserEditorInput && !openDocPath(editor);
}

/** The whole name of an open document: its title (a page's <title>, a document's heading), else the file. */
export function openDocTitle(editor: EditorInput): string {
	if (editor instanceof BrowserEditorInput) {
		return editor.title || editor.url || editor.getName();
	}
	return editor instanceof DispatchDocTabInput ? editor.fullTitle : editor.getName();
}

/**
 * The project an open document belongs to, by its path: the session's folder is `project`; another folder
 * under a Projects folder is named after it; a context handoff is in Handoffs; anything else is named after the
 * folder it is in.
 */
export function openDocProject(path: string, folder: string | undefined, project: string | undefined): string {
	if (folder && (path === folder || path.startsWith(folder.endsWith('/') ? folder : folder + '/'))) {
		return project || folder.split('/').filter(Boolean).pop() || folder;
	}
	if (/\/handoffs\//.test(path)) {
		return 'Handoffs';
	}
	const m = /\/projects\/([^/]+)\//i.exec(path);
	if (m) {
		return m[1];
	}
	const parts = path.split('/').filter(Boolean);
	return parts.length > 1 ? parts[parts.length - 2] : path;
}
