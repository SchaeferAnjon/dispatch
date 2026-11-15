/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: opening a document in the Docs tab's reader, and going from a document to its
 *  task (patches/435-docs.patch).
 *
 *  `dispatch.openDoc(path, taskId | { task?, reason?, mark?, title? })` (alias `dispatch.docs.open`): the
 *  document opens in a tab of its own in the side pane's strip, after Changes, Files, Docs and Tasks
 *  (DispatchDocTabInput): a Markdown file (or a folder's README.md) as the reading page; an HTML file (a delivery,
 *  a design) in the integrated browser with ‹ Docs above it (user 2026-10-21, preference「文档默认进浏览器」). The same document again brings its tab to the front; the tab's fill flashes. From
 *  outside the keyboard focus stays where it was (the chat input). dispatch-bridge calls it for
 *  `dispatch ide show` / `task deliver --show` (reason "delivered"); the Tasks tab calls it for a task's
 *  deliverable (with the task id); the Docs list for a row.
 *
 *  `dispatch.showTask(taskId, title?)`: the side pane switches to its Tasks tab and that task opens in place and
 *  flashes, from any session or project (the reader's "Delivered … for <task>", the Now tab's task title, a task link
 *  in a reply; task-86t0e).
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { dispatchTaskReveal } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { DispatchDocsEditorInput, DispatchDocTabInput, type IDispatchDocTabContext } from './dispatchDocsInput.js';
import { dispatchOpenPath } from './dispatchOpenPath.js';

export const DISPATCH_OPEN_DOC_COMMAND = 'dispatch.openDoc';
export const DISPATCH_SHOW_TASK_COMMAND = 'dispatch.showTask';
/** The Tasks tab's command (430-tasks.patch); by id, so this file does not import it. */
const TASKS_TAB_COMMAND_ID = 'workbench.action.agentSessions.dispatchTasksTab';

export interface IDispatchDocOpenOptions extends IDispatchDocTabContext {
	/** The name the list gives it (else the reader finds one). */
	readonly title?: string;
	/** Move the keyboard into the document (a click in the Docs list); else it stays where it was. */
	readonly focus?: boolean;
}

/** Brings the Docs tab (the list) to the front of the active group. */
export async function revealDispatchDocsTab(accessor: ServicesAccessor, preserveFocus = true): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const instantiationService = accessor.get(IInstantiationService);
	const group = groups.mainPart.activeGroup;
	const existing = group.editors.find(e => e instanceof DispatchDocsEditorInput);
	await editorService.openEditor(existing ?? instantiationService.createInstance(DispatchDocsEditorInput), {
		pinned: true,
		preserveFocus,
		index: existing ? undefined : group.count,
	}, group);
}

/** The document's own tab: the one already open for this path, else a new one at the end of the strip. */
export async function openDispatchDocTab(accessor: ServicesAccessor, path: string, options: IDispatchDocOpenOptions = {}): Promise<DispatchDocTabInput> {
	const editorService = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const group = groups.mainPart.activeGroup;
	const context: IDispatchDocTabContext = { task: options.task, reason: options.reason, mark: options.mark };
	const existing = group.editors.find((e): e is DispatchDocTabInput => e instanceof DispatchDocTabInput && e.path === path);
	const input = existing ?? new DispatchDocTabInput(path, options.title, context);
	if (existing) {
		// asked again (a delivery, a task): the reader says why this time
		existing.context = options.task || options.reason || options.mark !== undefined ? context : undefined;
	}
	await editorService.openEditor(input, { pinned: true, preserveFocus: !options.focus, index: existing ? undefined : group.count }, group);
	return input;
}

/** The side pane's tab with this name (aria-label) flashes its fill once (2s). */
export function flashSidePaneTab(name: string, retry = true): void {
	const doc = mainWindow.document;
	const tab = [...doc.querySelectorAll<HTMLElement>('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') ?? '').split(',')[0].trim() === name);
	if (!tab) {
		// a tab just opened is drawn a moment later (the strip lays itself out again): look once more
		if (retry) {
			setTimeout(() => flashSidePaneTab(name, false), 300);
		}
		return;
	}
	tab.classList.remove('dispatch-docs-flash');
	void tab.offsetWidth; // restart the animation
	tab.classList.add('dispatch-docs-flash');
	setTimeout(() => tab.classList.remove('dispatch-docs-flash'), 2100);
}

type OpenDocArg = string | { task?: string; reason?: IDispatchDocTabContext['reason']; mark?: number; title?: string };

export async function dispatchOpenDoc(accessor: ServicesAccessor, path: string, options?: OpenDocArg): Promise<void> {
	// every service first: the accessor is gone after the first await
	const fileService = accessor.get(IFileService);
	const customViews = accessor.get(ICustomViewService);
	const instantiationService = accessor.get(IInstantiationService);
	const opts = typeof options === 'string' ? { task: options } : (options ?? {});
	let target = path.startsWith('file:') ? URI.parse(path).fsPath : path;
	try {
		const stat = await fileService.stat(URI.file(target));
		if (stat.isDirectory) {
			target = URI.joinPath(URI.file(target), 'README.md').fsPath;
		}
	} catch {
		// the reader says the file is not there
	}
	if (/\.html?$/i.test(target)) {
		// a page (a delivery, a design) opens in the integrated browser with ‹ Docs above it: its own address bar and
		// Draw and ask over the whole page (kanban preference「文档默认进浏览器」)
		await instantiationService.invokeFunction(dispatchOpenPath, URI.file(target), { fromDocs: true, inEditor: true, task: opts.task || undefined });
		return;
	}
	// a page in the middle (Waiting for you, Projects, a task) stays where it is: the side pane opens next to it
	if (customViews.activeCustomView.get()) {
		customViews.setSidePane(true);
	}
	const input = await instantiationService.invokeFunction(openDispatchDocTab, target, {
		task: opts.task || undefined,
		reason: opts.reason ?? (opts.task ? 'task' : undefined),
		mark: typeof opts.mark === 'number' ? opts.mark : undefined,
		title: typeof opts.title === 'string' ? opts.title : undefined,
	});
	flashSidePaneTab(input.getName());
}

CommandsRegistry.registerCommand(DISPATCH_OPEN_DOC_COMMAND, (accessor, path: string, options?: OpenDocArg) => {
	if (typeof path !== 'string' || !path) {
		return;
	}
	return dispatchOpenDoc(accessor, path, options);
});
CommandsRegistry.registerCommand('dispatch.docs.open', (accessor, path: string, options?: OpenDocArg) => {
	if (typeof path !== 'string' || !path) {
		return;
	}
	return dispatchOpenDoc(accessor, path, options);
});

/**
 * The side pane opens (when it was closed) on its Tasks tab, and the tab opens that task in place: its card when the
 * list shows it, else the task on its own above the list, whichever session or project it belongs to (task-86t0e).
 * What the window knows about the task shows at once; the tab asks the board again behind it.
 */
export async function dispatchShowTask(accessor: ServicesAccessor, id: string, title = ''): Promise<boolean> {
	const commandService = accessor.get(ICommandService);
	const customViews = accessor.get(ICustomViewService);
	dispatchTaskReveal.set({ id, title, at: Date.now() }, undefined);
	// a page in the middle (Waiting for you, Projects) stays where it is: the side pane opens next to it
	if (customViews.activeCustomView.get()) {
		customViews.setSidePane(true);
	}
	await commandService.executeCommand(TASKS_TAB_COMMAND_ID).catch(() => undefined);
	flashSidePaneTab('Tasks');
	return true;
}

CommandsRegistry.registerCommand(DISPATCH_SHOW_TASK_COMMAND, (accessor, id: string, title?: string) => {
	if (typeof id !== 'string' || !id) {
		return false;
	}
	return dispatchShowTask(accessor, id, typeof title === 'string' ? title : '');
});
