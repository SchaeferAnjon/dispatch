/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the task model (kanban design/task-model/DECISIONS.md) as the Agents window sees it
 *  (patches/430-tasks.patch). A task is one request the person made in a session; its plan
 *  is a few short directions, its deliverables are what to open to see the result. The data is
 *  `dispatch task list | graph | show --json` through dispatch-bridge's `dispatch.tasks`.
 *  Shared by the Tasks tab, the task graph page and the task page.
 *--------------------------------------------------------------------------------------------*/

import '../../sessions/browser/media/dispatchProjects.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { browserViewUrlMatches, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { dispatchWaitingData, dispatchWaitingVisible, findWaitingItem, IDispatchWaitingItem } from '../../sessions/browser/dispatchWaitingModel.js';
import { dispatchProjectsRegistry, projectOfSession } from '../../sessions/browser/dispatchProjectsModel.js';
import { stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';
import { DispatchWhereCard, setupDispatchPictureDetail, dispatchPictureUrl, IDispatchMarks, parseDispatchMarks } from '../../dispatchCommon/browser/dispatchWhere.js';

export type DispatchTaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export type DispatchPlanState = 'todo' | 'active' | 'done';
export type DispatchDeliverableKind = 'url' | 'file' | 'draft' | 'commit' | 'build';

export interface IDispatchPlanItem {
	readonly text: string;
	readonly state: DispatchPlanState;
}

export interface IDispatchDeliverable {
	readonly kind: DispatchDeliverableKind;
	readonly ref: string;
	readonly label: string;
	/** commit: the repository it is in. */
	readonly repo?: string;
	/** build (`dispatch build`): ok | failed, its log, and the page that sums it up (commit pair, log tail, e2e screenshots). */
	readonly status?: string;
	readonly log?: string;
	readonly summary?: string;
	readonly at?: number;
	/**
	 * file: the note's Where to look (00-where.json next to it, `task list --json` reads it each time):
	 * `{ json, image, size, items, drawn, count }`, read with {@link deliverableWhere}.
	 */
	readonly where?: unknown;
}

export interface IDispatchTask {
	readonly handoffs?: readonly import('../../dispatchLife/browser/dispatchLife.js').Handoff[];
	readonly id: string;
	readonly title: string;
	readonly status: DispatchTaskStatus;
	readonly project: string;
	/** The session the request was made in (its id). */
	readonly session: string;
	/** That session's id in this window when the task names it by the agent's own id (Claude's session, Codex's thread, OpenCode's ses_…); '' when the window does not run it. */
	readonly session_window?: string;
	readonly sessions: readonly string[];
	readonly agent: string;
	readonly plan: readonly IDispatchPlanItem[];
	readonly deliverables: readonly IDispatchDeliverable[];
	readonly follows: string;
	readonly only_you: boolean;
	readonly thing?: string;
	readonly from?: string;
	readonly last?: { readonly at: number; readonly text: string } | null;
	/** Epoch seconds. */
	readonly created_at: number;
	readonly updated_at: number;
	readonly done_at: number | null;
	/** show: the request as it was made. */
	readonly description?: string;
	readonly commits?: readonly { short: string; subject: string; date: string }[];
}

export interface IDispatchTaskList {
	readonly project?: string;
	readonly tasks?: readonly IDispatchTask[];
	readonly error?: string;
}

export interface IDispatchGraphNode {
	readonly id: string;
	readonly title: string;
	readonly status: DispatchTaskStatus;
	readonly lane: string;
	readonly at: number;
	readonly done_at: number | null;
	readonly session: string;
	/** As on {@link IDispatchTask}. */
	readonly session_window?: string;
	readonly agent: string;
	readonly deliverables: readonly IDispatchDeliverable[];
	readonly plan_done: number;
	readonly plan_total: number;
	/** session graph: a task outside the session that one of its tasks carries on. */
	readonly context?: boolean;
}

export const DISPATCH_TASKS_COMMAND = 'dispatch.tasks';
/** Open the task page: `_dispatch.openTask(taskId)`. Registered by patches/430-tasks.patch. */
export const DISPATCH_OPEN_TASK_COMMAND = '_dispatch.openTask';
/**
 * Open the task graph page: `_dispatch.openTaskGraph(scope?: 'project' | 'session', project?: { name, label })`.
 * With a project it draws that one; with only a scope, the active session's; with nothing, as it was.
 */
export const DISPATCH_OPEN_TASK_GRAPH_COMMAND = '_dispatch.openTaskGraph';

export const STATUS_LABEL: Record<DispatchTaskStatus, string> = {
	todo: localize('dispatchTasks.todo', "To do"),
	in_progress: localize('dispatchTasks.inProgress', "In progress"),
	waiting: localize('dispatchTasks.waiting', "Waiting for you"),
	done: localize('dispatchTasks.done', "Done"),
};

export const DELIVERABLE_ICON: Record<DispatchDeliverableKind, ThemeIcon> = {
	url: Codicon.globe,
	file: Codicon.file,
	draft: Codicon.note,
	commit: Codicon.gitCommit,
	build: Codicon.package,
};

/** The folder the active session works in (a worktree counts: the CLI maps it to its repository). */
export function activeSessionFolder(sessionsService: ISessionsService): string | undefined {
	const folder = sessionsService.activeSession.get()?.workspace.get()?.folders[0];
	const uri = folder?.workingDirectory ?? folder?.root;
	return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/**
 * Whether a session works without a project folder (the sidebar's Chats): its tasks belong to no project, so the
 * task views show This session only. A quick chat, or a folder that is a chat's own scratch folder.
 */
export function isChatSession(session: ISession | undefined): boolean {
	if (!session) {
		return false;
	}
	if (session.isQuickChat?.get()) {
		return true;
	}
	const folder = session.workspace.get()?.folders[0];
	const uri = folder?.workingDirectory ?? folder?.root;
	return !!uri && uri.scheme === 'file' && /\/\.(?:copilot|dispatch)\/chats(?:\/|$)/.test(uri.path);
}

/** What the sidebar calls the active session's project (its group name), known before any task list has answered. */
export function activeProjectLabel(sessionsService: ISessionsService): string | undefined {
	const session = sessionsService.activeSession.get();
	return session ? projectOfSession(session, dispatchProjectsRegistry.get())?.project.label : undefined;
}

/** The last path segment of a session resource: the id the board's `session:` labels carry. */
export function sessionIdOf(resource: URI | string | undefined): string {
	if (!resource) {
		return '';
	}
	const text = typeof resource === 'string' ? resource : resource.path;
	return decodeURIComponent(text.split(/[?#]/)[0]).split('/').filter(Boolean).pop() ?? '';
}

/**
 * The Agents window session a task belongs to, if the window has it. A task names its session by the agent's own id
 * (what `dispatch begin` sees: Claude's session, Codex's thread, OpenCode's ses_…), which is not the window's id of
 * it; the CLI adds the window's (`session_window`), so that one is tried first (task-wwi8s).
 */
export function sessionForTask(management: ISessionsManagementService, sid: string, windowSid?: string): ISession | undefined {
	const sessions = management.getSessions();
	for (const want of [windowSid, sid]) {
		if (!want) {
			continue;
		}
		const found = sessions.find(s => {
			const id = sessionIdOf(s.resource);
			return id === want || (want.length >= 8 && id.startsWith(want));
		});
		if (found) {
			return found;
		}
	}
	return undefined;
}

/**
 * A task's status as the window shows it: the board's, except that an unfinished task of a session
 * that stopped for an approval or a decision is Waiting for you (the Waiting for you poll knows).
 */
/**
 * What a task waits on in Waiting for you: its session's row (an approval, a question), or its own (a
 * design direction to pick, `dispatch flow design`).
 */
export function waitingItemOfTask(management: ISessionsManagementService, task: { id: string; session: string; session_window?: string }): IDispatchWaitingItem | undefined {
	const value = dispatchWaitingVisible.get();
	const session = sessionForTask(management, task.session, task.session_window);
	return (session && findWaitingItem(value, session.resource)) || value?.items.find(i => i.task === task.id && i.kind !== 'only_you');
}

export function shownStatus(task: { status: DispatchTaskStatus; session: string; session_window?: string }, management: ISessionsManagementService): DispatchTaskStatus {
	if (task.status !== 'in_progress') {
		return task.status;
	}
	const session = sessionForTask(management, task.session, task.session_window);
	const waiting = session && findWaitingItem(dispatchWaitingData.get(), session.resource);
	return waiting && (waiting.kind === 'approve' || waiting.kind === 'decide') ? 'waiting' : task.status;
}

export async function askTasks<T>(commandService: ICommandService, req: Record<string, unknown>): Promise<T & { error?: string }> {
	try {
		const ans = await commandService.executeCommand<T & { error?: string }>(DISPATCH_TASKS_COMMAND, req);
		return ans ?? ({ error: localize('dispatchTasks.noBridge', "Dispatch is not answering.") } as T & { error?: string });
	} catch (e) {
		return { error: String((e as Error)?.message ?? e) } as T & { error?: string };
	}
}

/**
 * A task's state mark, the only colour on a task row (DESIGN.md「符号表」, task-o01fh): in progress the green filled
 * circle (breathing while its agent is at it: `live`), waiting the amber one, done the filled check in the done colour,
 * to do the large ring. `data-status` says which, for the CSS and the tests.
 */
export function statusMark(status: DispatchTaskStatus, live = false): HTMLElement {
	const el = stateMark(status === 'in_progress' ? 'now' : status, { live });
	el.classList.add('dispatch-task-mark');
	el.dataset.status = status;
	return el;
}

/**
 * A plan step's circle (kanban task-p6mh: "is this circle done or not?"; DESIGN.md「符号表」): done the grey filled
 * check, the step it is on the green filled circle while its agent is at it (`live`) and the large ring with strong
 * words where it stopped, a step not started the large ring; all the same size.
 */
export function planMark(state: DispatchPlanState, live = false): HTMLElement {
	return stateMark(state === 'done' ? 'seen' : state === 'active' ? (live ? 'now' : 'stop') : 'todo', { live });
}

/** The plan in words: "2 of 4 steps done". */
export function planProgress(plan: readonly IDispatchPlanItem[]): string {
	return localize('dispatchPlan.progress', "{0} of {1} steps done", plan.filter(p => p.state === 'done').length, plan.length);
}

/**
 * What a step's circle means, for the card on it. A finished task's step that was never ticked says so
 * ("Not done"), it does not pretend to be in progress or waiting to start.
 */
export function planStepTip(state: DispatchPlanState, taskDone = false): { head: string; notes: string[] } {
	if (state === 'done') {
		return { head: localize('dispatchPlan.done', "Done"), notes: [localize('dispatchPlan.doneNote', "This step is finished.")] };
	}
	if (taskDone) {
		return { head: localize('dispatchPlan.notDone', "Not done"), notes: [localize('dispatchPlan.notDoneNote', "The task was finished without ticking this step.")] };
	}
	return state === 'active'
		? { head: localize('dispatchPlan.active', "In progress"), notes: [localize('dispatchPlan.activeNote', "The agent is working on this step now.")] }
		: { head: localize('dispatchPlan.todo', "Not started"), notes: [localize('dispatchPlan.todoNote', "The agent has not started this step yet.")] };
}

/** A label without the task id a commit subject carries (`… (task-abc)`): the person never reads ids. */
export function withoutTaskId(text: string): string {
	return text.replace(/\s*[（(]\s*task-[a-z0-9]{2,8}\s*[）)]/g, '').trim();
}

export function deliverableLabel(d: IDispatchDeliverable): string {
	if (d.kind === 'commit') {
		return d.label ? `${d.ref} ${withoutTaskId(d.label)}` : d.ref;
	}
	if (d.label) {
		return withoutTaskId(d.label);
	}
	if (d.kind === 'file' || (d.kind === 'draft' && d.ref.startsWith('/'))) {
		return d.ref.split('/').filter(Boolean).pop() ?? d.ref;
	}
	return d.ref.replace(/^https?:\/\//, '');
}

/** A deliverable the Docs tab's reader opens in place: a Markdown or HTML file, or a folder (its README.md). */
export function isDocDeliverable(d: IDispatchDeliverable): boolean {
	const path = d.ref.startsWith('file:') ? URI.parse(d.ref).fsPath : d.ref;
	return (d.kind === 'file' || d.kind === 'draft') && path.startsWith('/') && (/\.(md|markdown|html?)$/i.test(path) || !/\.[A-Za-z0-9]{1,6}$/.test(path));
}

export function deliverableTooltip(d: IDispatchDeliverable): string {
	switch (d.kind) {
		case 'url': return localize('dispatchTasks.openUrl', "Open {0} in the browser", d.ref);
		// a document says its own title (the label `task deliver` gives it), and where it opens
		case 'file': return isDocDeliverable(d) && d.label ? localize('dispatchTasks.openDoc', "{0} · opens in Docs", withoutTaskId(d.label)) : d.ref;
		case 'draft': return isDocDeliverable(d) && d.label ? localize('dispatchTasks.openDoc', "{0} · opens in Docs", withoutTaskId(d.label)) : d.ref;
		case 'commit': return localize('dispatchTasks.openCommit', "Show commit {0}", d.ref);
		case 'build': return d.summary || d.log || d.ref;
	}
}

/**
 * Runs an opener that puts its tab next to the active one (the side pane's openPath, dispatch-bridge's commit
 * diff), then moves the tabs it newly opened to the end of their row: a deliverable never lands between the
 * side pane's own tabs (Changes, Files, Docs, Tasks) or in front of the deliverables opened before it. A tab
 * that was already open only comes to the front and keeps its place.
 */
async function openAtEnd(groupsService: IEditorGroupsService, open: () => Promise<unknown>): Promise<void> {
	const before = new Map(groupsService.groups.map(g => [g.id, new Set(g.editors)]));
	await open();
	for (const group of groupsService.groups) {
		const had = before.get(group.id);
		if (!had) {
			continue;
		}
		for (const editor of group.editors.filter(e => !had.has(e))) {
			group.moveEditor(editor, group, { index: group.count - 1, preserveFocus: true });
		}
	}
}

/**
 * Open what a task delivered: a document in the Docs tab's reader (`dispatch.openDoc`, the second line names
 * the task), a page in the integrated browser, another file the way the side pane shows it, a commit's changes.
 */
export async function openDeliverable(accessor: ServicesAccessor, d: IDispatchDeliverable, taskId?: string, mark?: number): Promise<void> {
	const commandService = accessor.get(ICommandService);
	if (isDocDeliverable(d)) {
		// with a Where to look: the reader opens on the spot the snippet showed (`mark`)
		await commandService.executeCommand('dispatch.openDoc', d.ref.startsWith('file:') ? URI.parse(d.ref).fsPath : d.ref, { task: taskId, reason: 'task', mark });
		return;
	}
	const notificationService = accessor.get(INotificationService);
	const groupsService = accessor.get(IEditorGroupsService);
	const openPath = (path: string) => openAtEnd(groupsService, () => commandService.executeCommand('_dispatch.openPath', path));
	if (d.kind === 'url') {
		if (/^https?:\/\//i.test(d.ref)) {
			// the page already open in a tab comes to the front; a new one opens at the end of the tab row, after the
			// side pane's own tabs (Changes, Files, Docs, Tasks)
			const editorService = accessor.get(IEditorService);
			const browsers = accessor.get(IBrowserViewWorkbenchService);
			const open = [...browsers.getKnownBrowserViews().values()].find(b => browserViewUrlMatches(b.url, d.ref));
			if (open) {
				await editorService.openEditor(open, { pinned: true });
				return;
			}
			const group = groupsService.activeGroup;
			const browser = browsers.getOrCreateLazy({ id: generateUuid(), url: d.ref });
			await editorService.openEditor(browser, { pinned: true, index: group.count }, group);
		} else if (d.ref.startsWith('/') || d.ref.startsWith('file:')) {
			await openPath(d.ref.startsWith('file:') ? URI.parse(d.ref).fsPath : d.ref);
		}
		return;
	}
	if (d.kind === 'file' || (d.kind === 'draft' && d.ref.startsWith('/'))) {
		await openPath(d.ref);
		return;
	}
	if (d.kind === 'build') {
		const page = d.summary || d.log;
		if (page) {
			await openPath(page);
		} else {
			notificationService.info(d.label || d.ref);
		}
		return;
	}
	if (d.kind === 'draft') {
		notificationService.info(d.ref);
		return;
	}
	// a commit: its diff under "<hash> <subject>" without the task id (dispatch-bridge's dispatch.openCommit),
	// else the git extension's own view, else the session's Changes
	if (d.repo) {
		const repo = d.repo;
		let shown = false;
		try {
			await openAtEnd(groupsService, async () => shown = !!await commandService.executeCommand<boolean>('dispatch.openCommit', repo, d.ref));
			if (shown) {
				return;
			}
		} catch {
			// an older bridge
		}
		try {
			await openAtEnd(groupsService, () => commandService.executeCommand('git.viewCommit', URI.file(repo), d.ref));
			return;
		} catch {
			// no git extension in this window
		}
	}
	await commandService.executeCommand('workbench.action.agentSessions.newChangesTab').catch(() => undefined);
}

/** "now", "5m", "3h", "2d" ago. */
/** A deliverable's Where to look picture and its marks (a file with 00-where.json beside it), else undefined. */
export function deliverableWhere(d: IDispatchDeliverable): IDispatchMarks | undefined {
	const w = d.kind === 'file' ? parseDispatchMarks(d.where) : undefined;
	return w?.marks.length ? w : undefined;
}

/** "3 places" / "1 place": how many spots a Where to look points at. */
export function wherePlaces(count: number): string {
	return count === 1 ? localize('dispatchTasks.onePlace', "1 place") : localize('dispatchTasks.places', "{0} places", count);
}

/**
 * 「带框的图」's snippet (kanban design/annotations/redesign 触点 1): hovering `target` 500 ms shows the
 * note's title, "Delivered … · N places", the picture zoomed to spot 1, the first three lines and
 * Open in Docs (which opens the reader on the spot the snippet shows). `onOpen` runs before opening.
 */
export function setupDeliverableWhereHover(accessor: ServicesAccessor, target: HTMLElement, d: IDispatchDeliverable, picture: IDispatchMarks, taskId: string | undefined, store: DisposableStore): void {
	const hoverService = accessor.get(IHoverService);
	const fileService = accessor.get(IFileService);
	const instantiationService = accessor.get(IInstantiationService);
	const cardStore = store.add(new DisposableStore());
	const pictureUrl = (image: string) => dispatchPictureUrl(fileService, image);
	store.add(hoverService.setupDelayedHover(target, () => {
		cardStore.clear();
		const holder = DOM.$('.dispatch-where-snippet');
		const secs = d.at ? Date.now() / 1000 - d.at : undefined;
		const delivered = secs === undefined ? '' : secs < 60 ? localize('dispatchTasks.deliveredNow', "Delivered just now") : localize('dispatchTasks.deliveredAgo', "Delivered {0} ago", ago(d.at));
		const subtitle = [delivered, wherePlaces(picture.marks.length)].filter(Boolean).join(' · ');
		const card = cardStore.add(new DispatchWhereCard(picture, undefined, {
			title: deliverableLabel(d),
			subtitle,
			order: 'text',
			mark: picture.marks[0].n,
			lines: 3,
			bare: true,
			pictureUrl,
			actions: [{
				label: localize('dispatchTasks.openInDocs', "Open in Docs"), icon: 'arrow-right', run: () => {
					const mark = card.viewer.selected ?? picture.marks[0].n;
					hoverService.hideHover(true);
					void instantiationService.invokeFunction(openDeliverable, d, taskId, mark);
				}
			}],
		}));
		holder.appendChild(card.element);
		for (const row of card.element.querySelectorAll<HTMLElement>('.dispatch-where-leg li')) {
			const n = Number(row.dataset.n);
			setupDispatchPictureDetail(holder, row, picture, n, deliverableLabel(d), pictureUrl, cardStore, {
				label: 'Open in Docs', run: () => { hoverService.hideHover(true); void instantiationService.invokeFunction(openDeliverable, d, taskId, n); }
			});
		}

		void pictureUrl(picture.image).then(url => {
			const img = card.viewer.viewport.querySelector('img');
			if (url && img && !cardStore.isDisposed && !img.src) {
				img.src = url;
			}
		});
		return {
			content: holder,
			additionalClasses: ['dispatch-where-hover'],
			appearance: { showPointer: true },
			position: { hoverPosition: HoverPosition.BELOW },
			persistence: { hideOnHover: false },
		};
	}, { groupId: 'dispatch-deliverable' }));
}

export function ago(at: number | null | undefined): string {
	if (!at) {
		return '';
	}
	const s = Math.max(0, Math.round(Date.now() / 1000 - at));
	if (s < 60) {
		return localize('dispatchTasks.now', "now");
	}
	if (s < 3600) {
		return localize('dispatchTasks.minutes', "{0}m", Math.floor(s / 60));
	}
	if (s < 86400) {
		return localize('dispatchTasks.hours', "{0}h", Math.floor(s / 3600));
	}
	return localize('dispatchTasks.days', "{0}d", Math.floor(s / 86400));
}

/** "Sep 27, 14:05" (the year when it is not this one). */
export function when(at: number | null | undefined): string {
	if (!at) {
		return '';
	}
	const d = new Date(at * 1000);
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleString('en-US', sameYear
		? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
		: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Which task the task page shows, and which scope the graph page draws (the pages are created without arguments). */
export const dispatchTaskPageTarget = observableValue<string | undefined>('dispatchTaskPageTarget', undefined);
export const dispatchGraphScope = observableValue<'project' | 'session'>('dispatchGraphScope', 'project');

/** A registered project as the task views name it: `name` is the board's `project:` label, `label` what the person calls it. */
export interface IDispatchTaskProject {
	readonly name: string;
	readonly label: string;
}

/**
 * The project the graph page draws instead of the active session's (the sidebar's hover card and the
 * task icon on a project's row). It holds until another session becomes active.
 */
export const dispatchGraphProject = observableValue<(IDispatchTaskProject & { readonly activeSession?: string }) | undefined>('dispatchGraphProject', undefined);

/**
 * Where the task page's "‹ …" leads back to: `_dispatch.openTask(id, from)` with 'graph' (a dot on the
 * graph), 'archive' (a project's Archive), 'project' (a project's page), 'waiting' (an Only-you task on
 * Waiting for you); anything else is 'session', the session the page was opened over (a reply's link,
 * the Tasks tab).
 */
export type DispatchTaskPageFrom = 'graph' | 'archive' | 'project' | 'waiting' | 'session';
export const dispatchTaskPageBack = observableValue<DispatchTaskPageFrom>('dispatchTaskPageBack', 'session');

/**
 * A task to open in place in the side pane's Tasks tab (`dispatch.showTask(id, title?)`: a task link in a reply, the
 * Now tab's task title, the Docs reader's "Delivered … for <task>"; task-86t0e). `title` is what the caller already
 * shows (the link's words), `at` tells one ask from the next.
 */
export const dispatchTaskReveal = observableValue<{ readonly id: string; readonly title: string; readonly at: number } | undefined>('dispatchTaskReveal', undefined);

/** "‹ label" at the top of a page, the way back (the project page's breadcrumb, dispatchProjects.css). */
export function renderBackCrumb(container: HTMLElement, label: string, onClick: () => void, store: DisposableStore): HTMLElement {
	const row = DOM.append(container, DOM.$('.dispatch-projects-breadcrumb.dispatch-back-crumb'));
	const back = DOM.append(row, DOM.$<HTMLButtonElement>('button.dispatch-projects-crumb', { type: 'button' }));
	const caret = DOM.append(back, DOM.$(`span.dispatch-projects-crumb-sep${ThemeIcon.asCSSSelector(Codicon.chevronLeft)}`));
	caret.setAttribute('aria-hidden', 'true');
	DOM.append(back, DOM.$('span.dispatch-back-crumb-label', undefined, label));
	back.title = localize('dispatchTasks.backTo', "Back to {0}", label);
	store.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, onClick));
	return row;
}

/** Which project's Archive the archive page lists. */
export const dispatchArchiveProject = observableValue<IDispatchTaskProject | undefined>('dispatchArchiveProject', undefined);

/** Open a project's Archive: `_dispatch.openTaskArchive({ name, label })`. Registered by patches/430-tasks.patch. */
export const DISPATCH_OPEN_TASK_ARCHIVE_COMMAND = '_dispatch.openTaskArchive';

/** The tasks the views show: the last 30 days (the CLI's window); older ones are the project's Archive. */
export const TASK_WINDOW_DAYS = 30;

/** The agent's name as the person knows it. */
export function agentName(agent: string): string {
	const a = (agent || '').toLowerCase();
	if (a.startsWith('claude')) {
		return 'Claude Code';
	}
	if (a.startsWith('codex')) {
		return 'Codex';
	}
	return agent || localize('dispatchTasks.unknownAgent', "Unknown");
}

export async function openTaskSession(accessor: ServicesAccessor, sid: string, windowSid?: string): Promise<boolean> {
	const management = accessor.get(ISessionsManagementService);
	const sessionsService = accessor.get(ISessionsService);
	const session = sessionForTask(management, sid, windowSid);
	if (!session) {
		accessor.get(INotificationService).info(localize('dispatchTasks.noSession', "This session is not in the Agents window."));
		return false;
	}
	await sessionsService.openSession(session.resource);
	return true;
}

/** Close a task from a list (the board's own `dispatch done`), or open it again; true when the board took it. */
export async function setDispatchTaskDone(commands: ICommandService, taskId: string, done: boolean): Promise<boolean> {
	const result = await commands.executeCommand<{ ok?: boolean }>('dispatch.waiting', done ? 'done' : 'reopen', taskId).catch(() => undefined);
	return !!result && result.ok !== false;
}
