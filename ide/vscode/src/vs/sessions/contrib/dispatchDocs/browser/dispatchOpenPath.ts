/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: open a file the way the Agents window's side pane shows it
 *  (patches/435-docs.patch). Used by the Docs tab and by the paths in chat replies
 *  (`_dispatch.openPath`, patches/325-path-links.patch):
 *  Markdown in the Markdown Editor, HTML in the integrated browser, images in the image preview,
 *  anything else in the text editor at the line; a folder in the Files tab (or its README.md).
 *  `_dispatch.pathBases` gives a chat's folders for relative paths: the worktree, then the
 *  repository it came from.
 *--------------------------------------------------------------------------------------------*/

import { extname, joinPath } from '../../../../base/common/resources.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IExplorerService } from '../../../../workbench/contrib/files/browser/files.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../common/sessionCommands.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EditorsOrder, IEditorPane } from '../../../../workbench/common/editor.js';
import { markOpenedFromDocs } from './dispatchDocsBack.js';
import { openDocPath, registerServedDoc } from '../../dispatchTabs/browser/dispatchOpenDocs.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export const DISPATCH_OPEN_PATH_COMMAND = '_dispatch.openPath';

const onDidOpenDocPageEmitter = new Emitter<string>();
/** A page (HTML) opened from Docs, Waiting for you or a delivery, by its file: the Docs list marks its row seen. */
export const onDidOpenDocPage = onDidOpenDocPageEmitter.event;
/** dispatchDocsOpen.ts registers it (and imports this file): by id here. */
const DISPATCH_OPEN_DOC_COMMAND = 'dispatch.openDoc';
export const DISPATCH_PATH_BASES_COMMAND = '_dispatch.pathBases';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx', '.mkd', '.mdown']);
const HTML_EXT = new Set(['.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);

const MARKDOWN_EDITOR_ID = 'vscode.markdown.editor';
const IMAGE_PREVIEW_ID = 'imagePreview.previewEditor';

export interface IDispatchOpenPathOptions {
	readonly line?: number;
	readonly column?: number;
	readonly isDirectory?: boolean;
	/** A folder opens its README.md (the Docs tab); otherwise it is shown in the Files tab. */
	readonly folderReadme?: boolean;
	/**
	 * Opened for the Docs tab or `dispatch ide show`: a Markdown file opens in the Docs tab's reader
	 * (dispatchDocsOpen.ts); anything else, an HTML page too, in a tab with "‹ Docs" above it (dispatchDocsBack.ts).
	 */
	readonly fromDocs?: boolean;
	/** With fromDocs: an editor tab even for Markdown / HTML (the reader's Open in Editor). */
	readonly inEditor?: boolean;
	/** With fromDocs: the task a delivery page or a proposal belongs to (its Choose A / B records the pick for it). */
	readonly task?: string;
	/** With fromDocs: move the keyboard into the page (a click in Docs); else it stays where it was (the chat input). */
	readonly focus?: boolean;
}

export type DispatchOpenKind = 'markdown' | 'html' | 'image' | 'text';

export function dispatchOpenKind(uri: URI): DispatchOpenKind {
	const ext = extname(uri).toLowerCase();
	if (MARKDOWN_EXT.has(ext)) {
		return 'markdown';
	}
	if (HTML_EXT.has(ext)) {
		return 'html';
	}
	if (IMAGE_EXT.has(ext)) {
		return 'image';
	}
	return 'text';
}

/** A page in the middle keeps its place and gets the side pane next to it (instead of the session coming back). */
export function showSidePaneBesidePage(customViewService: ICustomViewService): void {
	if (customViewService.activeCustomView.get()) {
		customViewService.setSidePane(true);
	}
}

export async function dispatchOpenPath(accessor: ServicesAccessor, uri: URI, options: IDispatchOpenPathOptions = {}): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const fileService = accessor.get(IFileService);
	const commandService = accessor.get(ICommandService);
	const explorerService = accessor.get(IExplorerService);
	if (options.fromDocs) {
		// a page in the middle (Waiting for you, Projects, a task) stays where it is: the side pane opens next to it
		showSidePaneBesidePage(accessor.get(ICustomViewService));
	}
	const opened = (pane: IEditorPane | undefined) => {
		if (options.fromDocs) {
			markOpenedFromDocs(pane?.input);
		}
	};

	// a web page (`dispatch ide show https://…`): the integrated browser, like an HTML file
	if (uri.scheme === 'http' || uri.scheme === 'https') {
		opened(await editorService.openEditor({ resource: BrowserViewUri.forId(generateUuid()), options: { pinned: true, viewState: { url: uri.toString(true) } } }));
		return;
	}

	let isDirectory = options.isDirectory;
	if (isDirectory === undefined) {
		try {
			isDirectory = (await fileService.stat(uri)).isDirectory;
		} catch {
			isDirectory = false;
		}
	}
	if (isDirectory) {
		const readme = joinPath(uri, 'README.md');
		if (options.folderReadme && await fileService.exists(readme)) {
			uri = readme;
		} else {
			// the Files tab, then the folder selected and revealed in its tree
			await commandService.executeCommand(NEW_FILE_TAB_COMMAND_ID).catch(() => undefined);
			await explorerService.select(uri, true).catch(() => undefined);
			return;
		}
	}

	const kind = dispatchOpenKind(uri);
	if (options.fromDocs && !options.inEditor && uri.scheme === 'file' && kind === 'markdown') {
		// the Docs tab's reader, in place: no editor tab
		await commandService.executeCommand(DISPATCH_OPEN_DOC_COMMAND, uri.fsPath, { reason: 'list' });
		return;
	}

	switch (kind) {
		case 'markdown':
			opened(await editorService.openEditor({ resource: uri, options: { pinned: true, override: MARKDOWN_EDITOR_ID } }));
			return;
		case 'html': {
			const preserveFocus = options.fromDocs ? !options.focus : undefined;
			if (options.fromDocs && uri.scheme === 'file') {
				// opened is seen: Docs takes its row out of bold (the reader marked what it opened; a page opens here)
				onDidOpenDocPageEmitter.fire(uri.fsPath);
				// a delivery page or a proposal from dispatch-bridge's local page server, so its Choose A / B records the pick
				// for its task (a file:// page can only demonstrate it); any other page from the file
				const served = await commandService.executeCommand<{ url: string }>('dispatch.docsPageUrl', uri.fsPath, options.task ?? '').catch(() => undefined);
				if (served?.url) {
					registerServedDoc(served.url, uri.fsPath);
					// the tab of this page at this address comes to the front; one at another address (a file:// one that
					// only demonstrates Choose A / B, another task's, a dead one from before a restart) gives way to it
					const same = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(id => id.editor instanceof BrowserEditorInput && openDocPath(id.editor) === uri.fsPath);
					const open = same.find(id => (id.editor as BrowserEditorInput).url?.split('#')[0] === served.url.split('#')[0])?.editor;
					const stale = same.filter(id => id.editor !== open);
					if (stale.length) {
						await editorService.closeEditors(stale);
					}
					opened(open
						? await editorService.openEditor(open, { pinned: true, preserveFocus })
						: await editorService.openEditor({ resource: BrowserViewUri.forId(generateUuid()), options: { pinned: true, preserveFocus, viewState: { url: served.url } } }));
					return;
				}
			}
			opened(await editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus, override: BrowserEditorInput.EDITOR_ID } }));
			return;
		}
		case 'image':
			opened(await editorService.openEditor({ resource: uri, options: { pinned: true, override: IMAGE_PREVIEW_ID } }));
			return;
		default:
			opened(await editorService.openEditor({
				resource: uri,
				options: {
					pinned: true,
					selection: options.line ? { startLineNumber: options.line, startColumn: options.column ?? 1 } : undefined,
					revealIfOpened: true,
				}
			}));
	}
}

CommandsRegistry.registerCommand(DISPATCH_OPEN_PATH_COMMAND, (accessor, uri: UriComponents | string, options?: IDispatchOpenPathOptions) => {
	const resource = typeof uri === 'string' ? (uri.startsWith('/') ? URI.file(uri) : URI.parse(uri)) : URI.revive(uri);
	return dispatchOpenPath(accessor, resource, options);
});

/** The folders a chat's relative paths start from: its worktree, then the repository it was made from. */
export function dispatchPathBases(accessor: ServicesAccessor, chatResource?: UriComponents): URI[] {
	const management = accessor.get(ISessionsManagementService);
	const sessions = accessor.get(ISessionsService);
	const session = (chatResource && management.getSessionForChatResource(URI.revive(chatResource))?.session) ?? sessions.activeSession.get();
	const out: URI[] = [];
	for (const folder of session?.workspace.get()?.folders ?? []) {
		for (const uri of [folder.workingDirectory, folder.root]) {
			if (uri && !out.some(u => u.toString() === uri.toString())) {
				out.push(uri);
			}
		}
	}
	return out;
}

CommandsRegistry.registerCommand(DISPATCH_PATH_BASES_COMMAND, (accessor, chatResource?: UriComponents) => dispatchPathBases(accessor, chatResource));
