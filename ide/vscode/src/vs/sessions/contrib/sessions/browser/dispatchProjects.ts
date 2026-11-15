/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { displayPath, homeOf, middlePath } from '../../dispatchCommon/common/dispatchPaths.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Projects (kanban design/task-model/DECISIONS.md「项目」, design/projects-page/,
 *  design/projects/).
 *
 *  - The entry: a "Projects" row under Automations in the sessions list (sessionsList.ts), a line
 *    icon like Automations. A click shows the Projects page in the middle of the window.
 *  - The Projects page (a custom view, like Waiting for you): every project Dispatch knows, on this
 *    Mac and on the others, as a List (a row per project: name, folder, tasks · sessions · docs, the
 *    Mac, last activity, and under it one line of what is going on) or a Timeline (the last 14 days on
 *    the axis that gets finer towards now, a row per project: sessions as grey dots above its line,
 *    commits on the main branch as squares below it, the end green while running and amber while
 *    waiting, the line of what is going on at the right; rows with nothing in the 14 days fold under
 *    "No activity in 14 days"). Filters Active /
 *    All / <other Mac> / Archived; All includes the folders agents worked in that nobody registered,
 *    each with "Add as project". New Project at the top right picks or creates a folder, git inits it
 *    and registers it.
 *  - A project's page (a second custom view): breadcrumb back to Projects; Now (the project's summary
 *    and the sessions running), its row of the Timeline, Tasks, Docs and Sessions. + Session at
 *    the top right starts a session in the project's folder. A session on another Mac opens there
 *    over ssh (Terminal), since the project lives there.
 *  The data is `dispatch projects-view --json` (and `--project <name>`) through dispatch-bridge's
 *  `dispatch.projects`.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchProjects.css';
import '../../../../workbench/contrib/chat/browser/agentSessions/media/sessionSummaryHover.css';
import * as DOM from '../../../../base/browser/dom.js';
import { ensureDispatchDotStyles } from '../../../../base/browser/dispatchDot.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { dispatchProjectsRegistry, refreshDispatchProjectsRegistry } from './dispatchProjectsModel.js';
import { linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { askTasks, DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, DISPATCH_OPEN_TASK_COMMAND, IDispatchTaskList, setDispatchTaskDone } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { bucketize, bucketWhen, HOUR, hourMinute, ITimeAxis, ITimeBucket, midnight, renderTimeAxis, timeAxis } from '../../dispatchCommon/browser/dispatchTimeAxis.js';
import { isDispatchTextCut, renderDispatchHoverCard, setupDispatchRowDetail, setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { answerWaitingItem } from './dispatchWaiting.js';
import { DispatchWaitingAnswer, dispatchWaitingVisible, IDispatchWaitingItem, renderWaitingItemCard, waitingOptionLabel } from './dispatchWaitingModel.js';
import { openWaitingItem } from './dispatchWaitingQueue.js';

import { detailButton } from '../../dispatchTasks/browser/dispatchHoverDetails.js';
import { openDeliverable } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { onDidChangeDispatchBoard } from '../../dispatchBoard/browser/dispatchBoard.js';

const $ = DOM.$;

export const DISPATCH_PROJECTS_VIEW_ID = 'dispatch.projects';
/** The Projects row's id in the sessions list. */
export const DISPATCH_PROJECTS_SECTION_ID = 'dispatch-projects';
export const DISPATCH_PROJECT_VIEW_ID = 'dispatch.project';
const DispatchProjectsViewMenu = new MenuId('DispatchProjectsView');
/** The project page's buttons (Customize adds itself here: dispatchProjectCustom). */
export const DispatchProjectViewMenu = new MenuId('DispatchProjectView');
export const DispatchProjectRegisteredContext = new RawContextKey<boolean>('dispatchProjectRegistered', true);
const POLL_MS = 30_000;
const DAYS = 14;

// ---- the data -------------------------------------------------------------------------------------

/** A session in the page's days (the Timeline's dots): `at` its last activity, `start` its first message. */
export interface IDispatchProjectEvent {
	readonly id: string;
	readonly at: number;
	readonly start: number | null;
	/** Its title, else the first line of its first prompt. */
	readonly title: string;
	/** It has a title of its own. */
	readonly named: boolean;
	readonly agent: string;
	readonly host: string;
}

/** A commit on the main branch in the page's days (the Timeline's squares): `at` its author time. */
export interface IDispatchProjectCommit {
	readonly at: number;
	readonly hash: string;
	readonly subject: string;
}

export interface IDispatchProjectEvents {
	readonly sessions: readonly IDispatchProjectEvent[];
	readonly commits: readonly IDispatchProjectCommit[];
}

export interface IDispatchProjectSession {
	readonly id: string;
	readonly agent: string;
	readonly title: string;
	readonly at: number;
	readonly cwd: string;
	readonly worktree: boolean;
	readonly branch?: string;
	readonly host: string;
	/** "this Mac", "mini", … */
	readonly host_name?: string;
	readonly state?: string;
	readonly attention?: string | null;
	readonly source?: string;
}

export interface IDispatchProjectRow {
	readonly name: string;
	readonly label: string;
	readonly starred: boolean;
	readonly archived: boolean;
	readonly registered: boolean;
	readonly dir: string;
	readonly host: string;
	readonly host_name: string;
	readonly machine: string;
	readonly git: boolean;
	readonly branch: string;
	readonly tasks_open: number;
	readonly sessions_14d: number;
	readonly all_sessions: number;
	readonly docs: number;
	readonly last_at: number;
	readonly state: 'running' | 'waiting' | 'quiet';
	readonly waiting_phrase?: string;
	readonly now: string;
	/** The session `now` is about (its mark lights when the line is pointed at). */
	readonly now_session?: string;
	readonly summary: string;
	readonly running: readonly IDispatchProjectSession[];
	/** Oldest first; absent from a CLI older than the Timeline v2. */
	readonly events?: IDispatchProjectEvents;
	/** only with --project */
	readonly session_list?: readonly IDispatchProjectSession[];
	readonly tasks?: readonly { id: string; title: string; status: string; priority?: number; updated_at: string }[];
	readonly doc_list?: readonly { id: string; title: string; kind: string; path: string; mtime: number; ext: string }[];
}

export interface IDispatchProjectsPage {
	readonly now: number;
	readonly days: number;
	readonly today: string;
	readonly projects: readonly IDispatchProjectRow[];
	readonly indexing?: { readonly state: 'running' | 'interrupted'; readonly done: number; readonly total: number };
}

const pageData = observableValue<IDispatchProjectsPage | undefined>('dispatchProjectsPage', undefined);
const indexProgress = observableValue<IDispatchProjectsPage['indexing']>('dispatchProjectsIndexProgress', undefined);
const indexBusy = derived(reader => !!indexProgress.read(reader));
const projectData = observableValue<IDispatchProjectRow | undefined>('dispatchProjectDetail', undefined);
/** The project the project page shows (its name). */
const currentProject = observableValue<string | undefined>('dispatchCurrentProject', undefined);
const pageError = observableValue<string | undefined>('dispatchProjectsError', undefined);

async function ask<T>(commandService: ICommandService, op: string, arg?: string, extra?: string): Promise<T | undefined> {
	return commandService.executeCommand<T>('dispatch.projects', op, arg, extra);
}

/** The last page `dispatch projects-view` gave, kept between starts */
const PAGE_DATA_KEY = 'dispatch.projects.lastPage';

/** The page kept from the last start, or undefined when there is none (or it is not one this version draws). */
function keptPage(raw: string | undefined): IDispatchProjectsPage | undefined {
	try {
		const v = raw ? JSON.parse(raw) as IDispatchProjectsPage : undefined;
		return v && typeof v.now === 'number' && Array.isArray(v.projects) ? v : undefined;
	} catch {
		return undefined; // a torn value: the CLI's answer comes anyway
	}
}

let refreshPage: (force?: boolean) => Promise<void> = async () => { };
let refreshProject: (force?: boolean) => Promise<void> = async () => { };

class DispatchProjectsPoller extends Disposable {
	static readonly ID = 'dispatch.contrib.projectsPoller';
	private runningPage: Promise<void> | undefined;
	private runningProject: Promise<void> | undefined;
	private lastPoll = 0;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		// the page as the last start left it, drawn at once; the CLI's answer replaces it (kanban task-mpidn: on a
		// busy Mac `dispatch projects-view` takes from 5 to 45 s)
		const kept = keptPage(storageService.get(PAGE_DATA_KEY, StorageScope.PROFILE));
		if (kept && !pageData.get()) {
			pageData.set(kept, undefined);
		}
		refreshPage = force => this.refreshPage(force);
		refreshProject = force => this.refreshProject(force);
		this._register(customViewService.registerCustomView({
			id: DISPATCH_PROJECTS_VIEW_ID,
			ctor: new SyncDescriptor(DispatchProjectsView),
			actions: { style: 'buttonBar', menuId: DispatchProjectsViewMenu },
		}, { restore: false }));
		this._register(customViewService.registerCustomView({
			id: DISPATCH_PROJECT_VIEW_ID,
			ctor: new SyncDescriptor(DispatchProjectView),
			actions: { style: 'buttonBar', menuId: DispatchProjectViewMenu },
		}, { restore: false }));
		// a board change (pushed, dispatchBoard.ts) refreshes the page on screen at once; the timer stays for sessions and docs
		this._register(onDidChangeDispatchBoard(() => {
			const active = this.customViewService.activeCustomView.get()?.id;
			if (active === DISPATCH_PROJECTS_VIEW_ID) { void this.refreshPage(true); } else if (active === DISPATCH_PROJECT_VIEW_ID) { void this.refreshProject(true); }
		}));
		// only while a projects page is on screen
		const timer = mainWindow.setInterval(() => {
			if (mainWindow.document.visibilityState !== 'visible' || isDispatchWindowIdle()) {
				return;
			}
			const active = this.customViewService.activeCustomView.get()?.id;
			if (active === DISPATCH_PROJECTS_VIEW_ID) {
				if (indexProgress.get() || Date.now() - this.lastPoll >= POLL_MS) { void this.refreshPage(); }
			} else if (active === DISPATCH_PROJECT_VIEW_ID) {
				if (Date.now() - this.lastPoll >= POLL_MS) { void this.refreshProject(); }
			}
		}, 1_000);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
	}

	refreshPage(force = false): Promise<void> {
		if (force && this.runningPage) {
			return this.runningPage.then(() => this.refreshPage());
		}
		this.runningPage ??= (async () => {
			this.lastPoll = Date.now();
			try {
				const answer = await ask<IDispatchProjectsPage>(this.commandService, 'page');
				if (answer && Array.isArray(answer.projects)) {
					indexProgress.set(answer.indexing, undefined);
					const { indexing: _indexing, ...data } = answer;
					// nothing new (the clock aside, for up to five minutes): the page is not drawn again, so a card
					// someone is reading, or on its way to a button in, stays
					const before = pageData.get();
					if (!before || data.now - before.now >= 300 || JSON.stringify({ ...before, now: 0 }) !== JSON.stringify({ ...data, now: 0 })) {
						pageData.set(data, undefined);
						this.storageService.store(PAGE_DATA_KEY, JSON.stringify(data), StorageScope.PROFILE, StorageTarget.MACHINE);
					}
					pageError.set(undefined, undefined);
				}
			} catch (e) {
				this.logService.trace(`[DispatchProjects] ${e}`);
				pageError.set(String((e as Error)?.message ?? e), undefined);
			} finally {
				this.runningPage = undefined;
			}
		})();
		return this.runningPage;
	}

	refreshProject(force = false): Promise<void> {
		if (force && this.runningProject) {
			return this.runningProject.then(() => this.refreshProject());
		}
		const name = currentProject.get();
		if (!name) {
			return Promise.resolve();
		}
		this.runningProject ??= (async () => {
			this.lastPoll = Date.now();
			try {
				const answer = await ask<IDispatchProjectsPage>(this.commandService, 'project', name);
				const row = answer?.projects?.[0];
				if (row && currentProject.get() === name && JSON.stringify(row) !== JSON.stringify(projectData.get())) {
					projectData.set(row, undefined);
				}
			} catch (e) {
				this.logService.trace(`[DispatchProjects] ${e}`);
			} finally {
				this.runningProject = undefined;
			}
		})();
		return this.runningProject;
	}
}

registerWorkbenchContribution2(DispatchProjectsPoller.ID, DispatchProjectsPoller, WorkbenchPhase.AfterRestored);

// ---- actions ----------------------------------------------------------------------------------------

/** Show a project's page. */
/** The project the project page shows: its name, label and where it lives. */
export function currentDispatchProject(): { readonly name: string; readonly label: string; readonly host: string } | undefined {
	return projectData.get();
}

export function showDispatchProject(customViewService: ICustomViewService, name: string): void {
	if (currentProject.get() !== name) {
		projectData.set(pageData.get()?.projects.find(p => p.name === name), undefined);
	}
	currentProject.set(name, undefined);
	void refreshProject();
	customViewService.showCustomView(DISPATCH_PROJECT_VIEW_ID);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.project.rename',
			title: localize2('dispatchProject.rename', "Rename Project"),
			menu: [{ id: DispatchProjectViewMenu, group: 'navigation', order: 3, when: DispatchProjectRegisteredContext }],
		});
	}
	/**
	 * The project's name itself (task-ysxde): its folder stays where it is; its tasks, documents, preferences and notes
	 * move to the new name (`dispatch projects-view rename --key`). What moves is counted first and said before anything
	 * changes. `name`: a project of the sessions list (its right-click menu) or of Settings; none: the project page's.
	 */
	override async run(accessor: ServicesAccessor, name?: string): Promise<void> {
		const row = typeof name === 'string' ? dispatchProjectsRegistry.get()?.find(p => p.name === name && p.host === 'local') : projectData.get();
		if (!row || row.host !== 'local') { return; }
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);
		const next = (await quickInputService.input({
			title: localize('dispatchProject.renameTitle', "Rename {0}", row.label || row.name),
			prompt: localize('dispatchProject.renamePrompt', "Its folder keeps its name. Its tasks, documents, preferences and notes move to the new name."),
			value: row.name,
			validateInput: async value => {
				const v = value.trim();
				if (!v || v.length > 80) { return localize('dispatchProject.renameInvalid', "Use a name with 1 to 80 characters."); }
				if (v.startsWith('-') || v.includes('#')) { return localize('dispatchProject.renameChars', "A name cannot start with - or contain #."); }
				return undefined;
			},
		}))?.trim();
		if (next === undefined || next === row.name) { return; }
		try {
			const check = await ask<IRenameAnswer>(commandService, 'renameKeyCheck', row.name, next);
			if (!check || check.ok === false) {
				notificationService.warn(check?.message || localize('dispatchProject.renameFailed', "Could not rename this project."));
				return;
			}
			const { confirmed } = await dialogService.confirm({
				message: localize('dispatchProject.renameConfirm', "Rename {0} to {1}?", row.name, next),
				detail: renameDetail(check.counts ?? {}, next),
				primaryButton: localize({ key: 'dispatchProject.renameGo', comment: ['&& denotes a mnemonic'] }, "&&Rename"),
			});
			if (!confirmed) { return; }
			const answer = await ask<IRenameAnswer>(commandService, 'renameKey', row.name, next);
			if (!answer || answer.ok === false) {
				notificationService.warn(answer?.message || localize('dispatchProject.renameFailed', "Could not rename this project."));
				return;
			}
			if (currentProject.get() === row.name) {
				currentProject.set(next, undefined);
			}
			await Promise.all([refreshDispatchProjectsRegistry(), refreshPage(true), refreshProject(true)]);
		} catch (e) {
			notificationService.error(String((e as Error)?.message ?? e));
		}
	}
});

interface IRenameAnswer {
	readonly ok?: boolean;
	readonly message?: string;
	readonly counts?: Readonly<Record<string, number>>;
}

/** "Moves 42 tasks, 3 preferences and 1 document to Quillbench." plus what stays. */
function renameDetail(counts: Readonly<Record<string, number>>, next: string): string {
	const n = (k: string) => counts[k] ?? 0;
	const parts = [
		[n('tasks'), localize('dispatchProject.renameTask', "1 task"), localize('dispatchProject.renameTasks', "{0} tasks", n('tasks'))],
		[n('docs'), localize('dispatchProject.renameDoc', "1 document"), localize('dispatchProject.renameDocs', "{0} documents", n('docs'))],
		[n('prefs'), localize('dispatchProject.renamePref', "1 preference"), localize('dispatchProject.renamePrefs', "{0} preferences", n('prefs'))],
		[n('wiki'), localize('dispatchProject.renameNote', "1 note"), localize('dispatchProject.renameNotes', "{0} notes", n('wiki'))],
		[n('env'), localize('dispatchProject.renameKey', "1 key"), localize('dispatchProject.renameKeys', "{0} keys", n('env'))],
		[n('capture'), localize('dispatchProject.renameCapture', "1 item noted from a chat"), localize('dispatchProject.renameCaptures', "{0} items noted from chats", n('capture'))],
	].filter(([c]) => (c as number) > 0).map(([c, one, many]) => (c === 1 ? one : many) as string);
	const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ${localize('dispatchProject.renameAnd', "and")} ${parts[parts.length - 1]}` : parts[0];
	const moves = what
		? localize('dispatchProject.renameMoves', "Moves {0} to {1}.", what, next)
		: localize('dispatchProject.renameNothing', "Nothing is filed under the old name besides the project itself.");
	return `${moves} ${localize('dispatchProject.renameStays', "The folder keeps its name. Another Mac with this project needs the same rename there.")}`;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.projects.show', title: localize2('dispatchProjects.show', "Projects"), f1: true });
	}
	override run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(DISPATCH_PROJECTS_VIEW_ID);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.projects.open', title: localize2('dispatchProjects.open', "Open Project") });
	}
	override run(accessor: ServicesAccessor, name?: string): void {
		if (typeof name === 'string' && name) {
			showDispatchProject(accessor.get(ICustomViewService), name);
		}
	}
});

async function addProject(accessor: ServicesAccessor, dir: string, name?: string, create = false): Promise<string | undefined> {
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);
	try {
		const answer = await ask<{ ok?: boolean; name?: string; message?: string; retry?: boolean }>(commandService, create ? 'new' : 'add', dir, name);
		if (!answer || answer.ok === false) {
			const message = answer?.message || localize('dispatchProjects.addFailed', "Could not add {0} as a project.", dir);
			if (answer?.retry) {
				notificationService.prompt(Severity.Warning, message, [{
					label: localize('dispatchProjects.retry', "Try Again"),
					run: () => instantiationService.invokeFunction(a => addProject(a, dir, name, create)),
				}]);
			} else {
				notificationService.warn(message);
			}
			return undefined;
		}
		await Promise.all([refreshDispatchProjectsRegistry(), refreshPage(true)]);
		return answer.name;
	} catch (e) {
		notificationService.error(localize('dispatchProjects.error', "Projects: {0}", String((e as Error)?.message ?? e)));
		return undefined;
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.projects.new',
			title: localize2('dispatchProjects.new', "Add Project"),
			menu: [{ id: DispatchProjectsViewMenu, group: 'navigation', order: 1 }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const customViewService = accessor.get(ICustomViewService);
		// the Add a project dialog (dispatchAddProject): a folder, a new project by name, or a copy from the internet
		const added = await commandService.executeCommand<{ name?: string } | undefined>('dispatch.addProject.show');
		if (added?.name) {
			await Promise.all([refreshDispatchProjectsRegistry(), refreshPage(true)]);
			showDispatchProject(customViewService, added.name);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.project.newSession',
			title: localize2('dispatchProject.newSession', "New Session"),
			icon: Codicon.add,
			menu: [{ id: DispatchProjectViewMenu, group: 'navigation', order: 2, when: DispatchProjectRegisteredContext }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const row = projectData.get();
		const sessionsService = accessor.get(ISessionsService);
		const sessionsPartService = accessor.get(ISessionsPartService);
		const customViewService = accessor.get(ICustomViewService);
		const notificationService = accessor.get(INotificationService);
		if (!row?.dir) {
			return;
		}
		if (row.host !== 'local') {
			notificationService.info(localize('dispatchProject.elsewhere', "{0} lives on {1}: start its sessions there.", row.label, row.machine));
			return;
		}
		customViewService.hideCustomView();
		const authority = accessor.get(IWorkbenchEnvironmentService).remoteAuthority;
		await sessionsService.openNewSession({ folderUri: authority ? URI.from({ scheme: 'vscode-remote', authority, path: row.dir }) : URI.file(row.dir) });
		sessionsPartService.focusSession(sessionsService.activeSession.get());
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.project.add',
			title: localize2('dispatchProject.add', "Add as Project"),
			menu: [{ id: DispatchProjectViewMenu, group: 'navigation', order: 1, when: DispatchProjectRegisteredContext.negate() }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const row = projectData.get();
		if (!row?.dir) {
			return;
		}
		const instantiationService = accessor.get(IInstantiationService);
		const name = await instantiationService.invokeFunction(a => addProject(a, row.dir, row.name));
		if (name) {
			showDispatchProject(accessor.get(ICustomViewService), name);
		}
	}
});

/** An engine's name as people write it: `claude-code` → Claude Code, `opencode` → OpenCode. */
function engineName(agent: string): string {
	return ({ 'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode', pi: 'Pi', gemini: 'Gemini' } as Record<string, string>)[agent] || agent;
}

/** `claude:/abc`, `agent-host-claude:/abc`, `vscode-agent-host-claude://local/abc` → `abc`. */
function sessionIdOf(resource: URI): string {
	return decodeURIComponent(resource.path.split('/').filter(Boolean).pop() ?? '');
}

function findLocalSession(sessionsManagementService: ISessionsManagementService, id: string): ISession | undefined {
	return sessionsManagementService.getSessions().find(s => sessionIdOf(s.resource) === id || s.sessionId === id || s.sessionId.endsWith(`/${id}`));
}

async function openProjectSession(accessor: ServicesAccessor, session: IDispatchProjectSession): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	const commandService = accessor.get(ICommandService);
	if (session.host && session.host !== 'local') {
		// the project lives on that Mac: its sessions run there
		try {
			const answer = await ask<{ ok?: boolean; message?: string }>(commandService, 'open', session.id, session.host);
			if (answer?.ok === false) {
				notificationService.warn(answer.message || localize('dispatchProject.sshFailed', "Could not open the session over ssh."));
			}
		} catch (e) {
			notificationService.error(localize('dispatchProjects.error', "Projects: {0}", String((e as Error)?.message ?? e)));
		}
		return;
	}
	const found = findLocalSession(accessor.get(ISessionsManagementService), session.id);
	if (!found) {
		notificationService.info(localize('dispatchProject.notHere', "This session is not in the Agents window (it ran in {0}).", session.source || session.agent || localize('dispatchProject.aTerminal', "a terminal")));
		return;
	}
	accessor.get(ICustomViewService).hideCustomView();
	await accessor.get(ISessionsService).openSession(found.resource);
}

// ---- small helpers -----------------------------------------------------------------------------------

function ago(at: number, now = Date.now() / 1000): string {
	const s = Math.max(0, Math.round(now - at));
	if (!at) {
		return '';
	}
	if (s < 120) {
		return localize('dispatchProjects.justNow', "just now");
	}
	if (s < 3600) {
		return localize('dispatchProjects.minutes', "{0}m", Math.floor(s / 60));
	}
	if (s < 86400) {
		return localize('dispatchProjects.hours', "{0}h", Math.floor(s / 3600));
	}
	if (s < 7 * 86400) {
		return localize('dispatchProjects.days', "{0}d", Math.floor(s / 86400));
	}
	return shortDate(new Date(at * 1000));
}

function shortDate(d: Date): string {
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The folder the way Settings › Projects and the rest of the window write it (dispatchPaths.ts): `~/…` in a home
 *  folder, `iCloud Drive/…` in iCloud Drive, long ones cut in the middle; another Mac's with its name. */
function homeRelative(path: string, row: IDispatchProjectRow): string {
	const rel = middlePath(displayPath(path, homeOf(path)));
	return row.host === 'local' ? rel : `${row.machine}:${rel}`;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

function counts(row: IDispatchProjectRow): string {
	return [
		plural(row.tasks_open, localize('dispatchProjects.task', "task"), localize('dispatchProjects.tasks', "tasks")),
		plural(row.sessions_14d, localize('dispatchProjects.session', "session"), localize('dispatchProjects.sessions', "sessions")),
		plural(row.docs, localize('dispatchProjects.doc', "doc"), localize('dispatchProjects.docs', "docs")),
	].join(' · ');
}

/** The row's state as the dot the rest of the window uses (green running, amber waiting, grey quiet). */
const STATE_WORDS: Record<IDispatchProjectRow['state'], string> = {
	running: localize('dispatchProjects.stateRunning', "Running"),
	waiting: localize('dispatchProjects.stateWaiting', "Waiting for you"),
	quiet: '',
};

/**
 * The state dot. The line beside it no longer says "Waiting for you" (the amber says it); pointing at the
 * dot does, on our card, for whoever does not know the colours yet.
 */
function stateDot(state: IDispatchProjectRow['state'], hover?: { readonly hoverService: IHoverService; readonly store: DisposableStore }): HTMLElement {
	ensureDispatchDotStyles();
	const slot = $('span.dispatch-projects-state');
	slot.setAttribute('aria-hidden', 'true');
	if (state === 'running' || state === 'waiting') {
		DOM.append(slot, $(state === 'running' ? 'span.dispatch-dot.breathing' : 'span.dispatch-dot.amber'));
		if (hover) {
			hover.store.add(setupDispatchTextHover(hover.hoverService, slot, () => ({ text: STATE_WORDS[state] }), { when: () => true }));
		}
	}
	return slot;
}

/** A project's line without the words its dot already says ("Waiting for you: "). */
function nowWords(row: IDispatchProjectRow): string {
	return row.state === 'waiting' ? row.now.replace(/^Waiting for you: /, '') : row.now;
}

// ---- the timeline (kanban design/projects-page/timeline-v2/README.md) ---------------------------------
//
// One row per project on the shared axis that gets finer towards now (dispatchTimeAxis.ts: by day, by
// half day for the two days before today, by hour for today). Sessions are grey dots above the row's
// line, commits on main dark squares below it; what happened in the same hour, half day or day is one
// mark, 4, 6 or 8 px by how many. The only colour is the row's end while something runs (green) or
// waits (amber). Pointing at a mark lights its row and the row's one line at the right, and after
// 250 ms a card lists the sessions or commits behind it; pointing at the line rings the mark of the
// session it names (kanban DESIGN.md「联动悬停」).

const HOVER_DELAY = 250;
const TL_GAP = 12;
const TL_FOLD_KEY = 'dispatch.projects.timelineQuietOpen';
const CARD_SESSIONS = 8;
const CARD_COMMITS = 6;

interface ITimelineColumns {
	readonly name: number;
	readonly status: number;
	readonly track: number;
}

function timelineColumns(width: number, withName: boolean, withStatus: boolean): ITimelineColumns {
	const inner = Math.max(0, width - 20);   // the page's own padding
	const name = withName ? (inner >= 760 ? 140 : 120) : 0;
	const status = withStatus && inner >= 640 ? (inner >= 820 ? 240 : 200) : 0;
	const track = Math.max(200, inner - name - status - (name ? TL_GAP : 0) - (status ? TL_GAP : 0));
	return { name, status, track };
}

function isLive(row: IDispatchProjectRow): boolean {
	return row.state === 'running' || row.state === 'waiting';
}

function hasActivity(row: IDispatchProjectRow): boolean {
	const ev = row.events;
	return isLive(row) || !!ev && (ev.sessions.length > 0 || ev.commits.length > 0);
}

function markSize(n: number): string {
	return n >= 5 ? 's3' : n >= 2 ? 's2' : 's1';
}

interface ITimelineOptions {
	readonly now: number;
	readonly width: number;
	/** The name column (the Projects page); a project's own page draws its one row without it. */
	readonly names: boolean;
	/** The one line of what is going on, at the right. */
	readonly status: boolean;
	readonly hoverService: IHoverService;
	readonly instantiationService: IInstantiationService;
	/** A click on a row (the Projects page opens the project). */
	readonly open?: (row: IDispatchProjectRow) => void;
	/** "No activity in 14 days" (rows with nothing in them fold under it), open or not. */
	readonly fold?: { readonly open: boolean; set(open: boolean): void };
}

interface ITimelineMark {
	readonly el: HTMLElement;
	readonly kind: 'session' | 'commit';
	readonly bucket: ITimeBucket<IDispatchProjectEvent> | ITimeBucket<IDispatchProjectCommit>;
}

interface ITimelineRow {
	readonly data: IDispatchProjectRow;
	readonly el: HTMLElement;
	readonly marks: ITimelineMark[];
	status?: HTMLElement;
}

/**
 * The chart: the axis head, a row per project with something in the window or running, and under it
 * the rows with nothing (folded under "No activity in 14 days" when `o.fold` is given).
 */
function renderProjectsTimeline(parent: HTMLElement, rows: readonly IDispatchProjectRow[], o: ITimelineOptions, store: DisposableStore): void {
	const busy = o.fold ? rows.filter(hasActivity) : [...rows];
	const quiet = o.fold ? rows.filter(r => !hasActivity(r)) : [];
	const cols = timelineColumns(o.width, o.names, o.status);
	const times: number[] = [];
	for (const r of busy) {
		for (const s of r.events?.sessions ?? []) {
			times.push(s.at);
		}
		for (const c of r.events?.commits ?? []) {
			times.push(c.at);
		}
		if (isLive(r)) {
			times.push(o.now);
		}
	}
	// today gets 16 px an hour so far, up to the axis's 288 (at 2 in the morning today is not 288 px of nothing)
	const minToday = Math.min(288, Math.max(0, (o.now - midnight(o.now)) / HOUR) * 16);
	const axis = timeAxis({ times, now: o.now, width: cols.track, start: midnight(o.now, DAYS - 1), days: DAYS, minToday });
	const left = cols.name ? cols.name + TL_GAP : 0;

	// nothing to draw (another Mac's projects, the archived ones): no axis, no grid, only the group below
	const chart = busy.length ? DOM.append(parent, $('.dispatch-projects-tl')) : $('.dispatch-projects-tl');

	// what the rows are drawn over: today's stretch a shade darker, the zones' edges, Now
	const zones = DOM.append(chart, $('.dispatch-projects-tl-zones'));
	zones.style.left = `${left}px`;
	zones.style.width = `${cols.track}px`;
	const [A, B, C] = axis.zones;
	if (C.x1 - C.x0 > 0) {
		const band = DOM.append(zones, $('.dispatch-projects-tl-today'));
		band.style.left = `${Math.round(C.x0)}px`;
		band.style.width = `${Math.round(cols.track - C.x0)}px`;
	}
	for (const x of [A.x1 > 0 ? A.x1 : -1, B.x1 > B.x0 ? B.x1 : -1]) {
		if (x > 0 && x < cols.track) {
			DOM.append(zones, $('.dispatch-projects-tl-bound')).style.left = `${Math.round(x)}px`;
		}
	}
	DOM.append(zones, $('.dispatch-projects-tl-nowline'));

	const head = DOM.append(chart, $('.dispatch-projects-tl-axis'));
	head.style.paddingLeft = `${left}px`;
	renderTimeAxis(head, axis);

	const body = DOM.append(chart, $('.dispatch-projects-tl-rows'));
	const drawn: ITimelineRow[] = [];
	busy.forEach(row => drawn.push(renderTimelineRow(body, row, axis, cols, o, store)));
	for (const r of drawn) {
		wireTimelineRow(r, axis, o, store);
	}

	if (quiet.length && o.fold) {
		const fold = o.fold;
		// with nothing above it (another Mac's projects, the archived ones) the group is open
		const open = fold.open || !busy.length;
		const group = DOM.append(parent, $('.dispatch-projects-tl-quiet'));
		group.classList.toggle('open', open);
		const btn = DOM.append(group, $('button.dispatch-projects-tl-fold', { type: 'button' })) as HTMLButtonElement;
		btn.setAttribute('aria-expanded', String(open));
		const caret = DOM.append(btn, $(`span.dispatch-projects-tl-caret${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
		caret.setAttribute('aria-hidden', 'true');
		DOM.append(btn, $('span', undefined, localize('dispatchProjects.quiet', "No activity in {0} days", DAYS)));
		DOM.append(btn, $('span.dispatch-projects-tl-fold-count', undefined, String(quiet.length)));
		btn.disabled = !busy.length;
		const inner = DOM.append(DOM.append(group, $('.dispatch-projects-tl-quiet-body')), $('.dispatch-projects-tl-quiet-rows'));
		// folded rows are out of the tab order
		inner.inert = !open;
		store.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => {
			const now = !group.classList.contains('open');
			group.classList.toggle('open', now);
			btn.setAttribute('aria-expanded', String(now));
			inner.inert = !now;
			fold.set(now);
		}));
		for (const row of quiet) {
			renderTimelineRow(inner, row, axis, cols, o, store);
		}
	}

	if (o.names && busy.length) {
		const legend = DOM.append(parent, $('.dispatch-projects-legend'));
		for (const [cls, label] of [
			['session', localize('dispatchProjects.legendSessions', "Sessions, above the line")],
			['commit', localize('dispatchProjects.legendCommits', "Commits on main, below")],
			['running', localize('dispatchProjects.legendRunning', "Running")],
			['waiting', localize('dispatchProjects.legendWaiting', "Waiting for you")],
		] as const) {
			const item = DOM.append(legend, $('span.dispatch-projects-legend-item'));
			DOM.append(item, $(`span.dispatch-projects-legend-mark.${cls}`));
			DOM.append(item, $('span', undefined, label));
		}
	}
}

function renderTimelineRow(parent: HTMLElement, row: IDispatchProjectRow, axis: ITimeAxis, cols: ITimelineColumns, o: ITimelineOptions, store: DisposableStore): ITimelineRow {
	const el = DOM.append(parent, $('.dispatch-projects-tl-row'));
	el.style.gridTemplateColumns = [cols.name, cols.track, cols.status].filter(w => w > 0).map(w => `${w}px`).join(' ');
	el.classList.toggle('archived', row.archived);
	el.classList.toggle('unregistered', !row.registered);
	if (cols.name) {
		const name = DOM.append(el, $('.dispatch-projects-tl-name'));
		DOM.append(name, $('span.dispatch-projects-tl-label', undefined, row.label));
		if (row.host !== 'local') {
			DOM.append(name, $('span.dispatch-projects-machine', undefined, row.machine));
		}
	}
	const track = DOM.append(el, $('.dispatch-projects-tl-track'));
	const r: ITimelineRow = { data: row, el, marks: [] };
	const ev = row.events ?? { sessions: [], commits: [] };
	const sessions = bucketize(axis, ev.sessions.filter(s => s.at >= axis.start));
	const commits = bucketize(axis, ev.commits.filter(c => c.at >= axis.start));
	const live = isLive(row);
	const xs = [...sessions, ...commits].map(b => b.x);
	if (xs.length || live) {
		const x0 = xs.length ? Math.min(...xs) : cols.track;
		const x1 = live ? cols.track : Math.max(...xs);
		const line = DOM.append(track, $('.dispatch-projects-tl-line'));
		line.style.left = `${Math.round(x0)}px`;
		line.style.width = `${Math.max(0, Math.round(x1 - x0))}px`;
	}
	for (const [kind, buckets] of [['session', sessions], ['commit', commits]] as const) {
		for (const b of buckets) {
			const mk = DOM.append(track, $(`span.dispatch-projects-tl-mk.${kind === 'session' ? 'dot' : 'sq'}.${markSize(b.items.length)}`));
			mk.style.left = `${Math.round(b.x)}px`;
			r.marks.push({ el: mk, kind, bucket: b });
		}
	}
	if (live) {
		const end = DOM.append(track, $(`span.dispatch-projects-tl-end.${row.state}`));
		end.setAttribute('aria-hidden', 'true');
		// its colour is the state: the words on our card
		store.add(setupDispatchTextHover(o.hoverService, end, () => ({ text: STATE_WORDS[row.state] }), { when: () => !!STATE_WORDS[row.state] }));
	}
	if (cols.status) {
		r.status = DOM.append(el, $('.dispatch-projects-tl-status', undefined, statusLine(row)));
		// the whole line and, when it waits for the person, the buttons that answer it: our card (wireTimelineRow)
	}
	el.setAttribute('aria-label', [row.label, row.now].filter(Boolean).join(', '));
	if (o.open) {
		const open = o.open;
		el.tabIndex = 0;
		el.setAttribute('role', 'button');
		store.add(DOM.addDisposableListener(el, DOM.EventType.CLICK, () => {
			o.hoverService.hideHover(true);
			open(row);
		}));
		store.add(DOM.addDisposableListener(el, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open(row);
			}
		}));
	}
	return r;
}

/**
 * The row's one line, without what the chart already says: the end's colour says it runs ("Running: ",
 * "2 sessions running: "), where the marks stop says since when it is quiet ("Quiet since Sep 26. ").
 * A project with commits and no session names its last commit.
 */
function statusLine(row: IDispatchProjectRow): string {
	const line = nowWords(row).replace(/^(Running: |\d+ sessions running: )/, '').replace(/^Quiet since [^.]*\.\s*/, '');
	const last = row.events?.commits.at(-1);
	return line || (last ? localize('dispatchProjects.lastCommit', "Last commit: {0}", last.subject) : '');
}

function wireTimelineRow(r: ITimelineRow, axis: ITimeAxis, o: ITimelineOptions, store: DisposableStore): void {
	const cardStore = store.add(new DisposableStore());
	let timer: ReturnType<typeof setTimeout> | undefined;
	store.add(toDisposable(() => clearTimeout(timer)));
	const id = r.data.now_session;
	const names = (m: ITimelineMark | undefined) => !!id && m?.kind === 'session' && (m.bucket as ITimeBucket<IDispatchProjectEvent>).items.some(s => s.id === id);
	const light = (m: ITimelineMark | undefined, on: boolean) => {
		r.el.classList.toggle('hot', on);
		// the line at the right lights with the mark of the session it names, and with nothing else
		r.status?.classList.toggle('lit', on && names(m));
		m?.el.classList.toggle('ring', on);
	};
	const card = (m: ITimelineMark) => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (m.el.isConnected) {
				cardStore.clear();
				o.hoverService.showInstantHover({
					content: timelineCard(axis, m, r.data, o, cardStore),
					target: m.el,
					// beside the mark, towards the middle of the chart: the row and its line at the right stay in sight
					position: { hoverPosition: m.bucket.x > axis.width / 2 ? HoverPosition.LEFT : HoverPosition.RIGHT },
					appearance: { showPointer: false },
					persistence: { hideOnHover: false },
					additionalClasses: ['dispatch-projects-hover'],
				});
			}
		}, HOVER_DELAY);
	};
	const off = (m: ITimelineMark | undefined) => {
		clearTimeout(timer);
		light(m, false);
	};
	for (const m of r.marks) {
		store.add(DOM.addDisposableListener(m.el, DOM.EventType.MOUSE_ENTER, () => {
			light(m, true);
			card(m);
		}));
		store.add(DOM.addDisposableListener(m.el, DOM.EventType.MOUSE_LEAVE, () => off(m)));
	}
	// the line at the right names a session: its mark gets the ring and its card
	// the line at the right: the mark of the session it names gets the ring and its card, the end (the same
	// running or waiting) its ring
	const status = r.status;
	const end = r.el.querySelector<HTMLElement>('.dispatch-projects-tl-end');
	if (status) {
		const named = () => r.marks.find(names);
		store.add(DOM.addDisposableListener(status, DOM.EventType.MOUSE_ENTER, () => {
			light(named(), true);
			status.classList.add('lit');
			end?.classList.add('ring');
		}));
		store.add(DOM.addDisposableListener(status, DOM.EventType.MOUSE_LEAVE, () => {
			clearTimeout(timer);
			light(named(), false);
			status.classList.remove('lit');
			end?.classList.remove('ring');
		}));
		// the line's own card, not the mark's: the whole line, and what answers it when it waits for the person
		setupStatusHover(status, r.data, o.hoverService, o.instantiationService, store);
	}
}

/**
 * The waiting item a project's line is about (`dispatch projects` picks the first approve or decide of the
 * project, `dispatch waiting`'s order): the one with the line's words, else the session's, else the first.
 */
function waitingItemOf(row: IDispatchProjectRow): IDispatchWaitingItem | undefined {
	if (row.state !== 'waiting') {
		return undefined;
	}
	const name = row.name.toLowerCase();
	const items = (dispatchWaitingVisible.get()?.items ?? []).filter(i => (i.kind === 'approve' || i.kind === 'decide') && i.project.toLowerCase() === name);
	const phrase = row.waiting_phrase ?? row.now.replace(/^Waiting for you: /, '');
	return items.find(i => i.phrase === phrase)
		?? (row.now_session ? items.find(i => i.session?.split(':').pop() === row.now_session) : undefined)
		?? items[0];
}

const ANSWERED: Record<DispatchWaitingAnswer['act'], string> = {
	allow: localize('dispatchProjects.allowed', "Allowed"),
	deny: localize('dispatchProjects.denied', "Denied"),
	pick: localize('dispatchProjects.answered', "Answered"),
};

/**
 * Our card on a project's one line (the Timeline's column at the right, the List's second line, a project's
 * Now), where the system's title tooltip was: the whole line when it is cut off; when the project waits for
 * the person, the waiting item's row and the buttons that answer it (Allow / Deny, a direction's A / B),
 * whether the line is cut off or not.
 */
function setupStatusHover(el: HTMLElement, row: IDispatchProjectRow, hoverService: IHoverService, instantiationService: IInstantiationService, store: DisposableStore, text: HTMLElement = el): void {
	const cardStore = store.add(new DisposableStore());
	const open = (item: IDispatchWaitingItem) => {
		hoverService.hideHover(true);
		instantiationService.invokeFunction(a => openWaitingItem(a, item)).catch(onUnexpectedError);
	};
	const answer = (card: HTMLElement, item: IDispatchWaitingItem, a: DispatchWaitingAnswer) => {
		const buttons = [...card.querySelectorAll<HTMLButtonElement>('.dispatch-hover-actions button')];
		buttons.forEach(b => b.disabled = true);
		instantiationService.invokeFunction(acc => answerWaitingItem(acc, item, a, card)).then(ok => {
			if (!ok) {
				buttons.forEach(b => b.disabled = false);
				return;
			}
			// the card says what happened; the line catches up with the next read
			const bar = card.querySelector('.dispatch-hover-actions');
			const done = DOM.$('.dispatch-hover-note.dispatch-hover-answered', undefined, a.act === 'pick' ? localize('dispatchProjects.picked', "Picked {0}", waitingOptionLabel(a.option)) : ANSWERED[a.act]);
			bar?.replaceWith(done);
			void refreshPage();
			void refreshProject();
		}, onUnexpectedError);
	};
	store.add(setupDispatchTextHover(hoverService, el, () => {
		cardStore.clear();
		const item = waitingItemOf(row);
		if (!item) {
			return { text: nowWords(row) };
		}
		const card: HTMLElement = renderWaitingItemCard(item, nowWords(row), a => answer(card, item, a), () => open(item), cardStore);
		return card;
	}, {
		when: () => !!row.now && (isDispatchTextCut(text) || !!waitingItemOf(row)),
		interactive: true,
	}));
}

/** The card on a mark: when and how many, then the sessions (oldest first) or the commits (newest first). */
function timelineCard(axis: ITimeAxis, m: ITimelineMark, project: IDispatchProjectRow, o: ITimelineOptions, store: DisposableStore): HTMLElement {
	const card = $('.session-summary-hover.dispatch-projects-card');
	const n = m.bucket.items.length;
	const when = bucketWhen(axis, m.bucket);
	const head = m.kind === 'session'
		? (n === 1 ? localize('dispatchProjects.cardSession', "{0} · 1 session", when) : localize('dispatchProjects.cardSessions', "{0} · {1} sessions", when, n))
		: (n === 1 ? localize('dispatchProjects.cardCommit', "{0} · 1 commit on main", when) : localize('dispatchProjects.cardCommits', "{0} · {1} commits on main", when, n));
	DOM.append(card, $('.dispatch-projects-card-head', undefined, head));
	const list = DOM.append(card, $('.dispatch-projects-card-list'));
	let more = 0;
	if (m.kind === 'session') {
		const items = m.bucket.items as IDispatchProjectEvent[];
		for (const s of items.slice(0, CARD_SESSIONS)) {
			const li = DOM.append(list, $('.dispatch-projects-card-row'));
			const t = DOM.append(li, $('span.dispatch-projects-card-title', undefined, s.title || localize('dispatchProject.untitled', "Untitled session")));
			t.classList.toggle('muted', !s.named);
			DOM.append(li, $('span.dispatch-projects-card-at', undefined, hourMinute(s.at)));
			setupDispatchRowDetail(card, li, detailStore => {
				const detail = renderDispatchHoverCard({ head: s.title || 'Untitled session', notes: [project.label, engineName(s.agent)] });
				const bar = DOM.append(detail, $('.dispatch-hover-actions'));
				detailButton(bar, 'Open session', 'primary', () => { o.hoverService.hideHover(true); void o.instantiationService.invokeFunction(a => openProjectSession(a, { ...s, cwd: project.dir, worktree: false })); }, detailStore);
				const commands = o.instantiationService.invokeFunction(a => a.get(ICommandService));
				const local = o.instantiationService.invokeFunction(a => findLocalSession(a.get(ISessionsManagementService), s.id));
				void askTasks<IDispatchTaskList>(commands, { op: 'list', session: local ? sessionIdOf(local.resource) : s.id }).then(ans => {
					if (detailStore.isDisposed) { return; }
					// the session stays the head; under it every task of this session, each opening its task page
					const tasks = ans.tasks ?? [];
					if (!tasks.length) { detail.insertBefore($('.dispatch-hover-note', undefined, ans.error || 'No tasks recorded'), bar); return; }
					const sec = $('.dispatch-projects-session-tasks');
					DOM.append(sec, $('.dispatch-hover-note', undefined, tasks.length === 1 ? 'Tasks · 1' : `Tasks · ${tasks.length}`));
					for (const t of tasks.slice(0, 6)) {
						const b = detailButton(sec, t.title, 'ghost', () => { o.hoverService.hideHover(true); void commands.executeCommand(DISPATCH_OPEN_TASK_COMMAND, t.id, 'project'); }, detailStore);
						b.className = 'dispatch-detail-link dispatch-projects-session-task';
						b.dataset.status = t.status;
					}
					if (tasks.length > 6) { DOM.append(sec, $('.dispatch-hover-note', undefined, `and ${tasks.length - 6} more`)); }
					detail.insertBefore(sec, bar);
				});
				return detail;
			}, store);

		}
		more = items.length - CARD_SESSIONS;
	} else {
		const items = (m.bucket.items as IDispatchProjectCommit[]).slice().reverse();
		for (const c of items.slice(0, CARD_COMMITS)) {
			const li = DOM.append(list, $('.dispatch-projects-card-row'));
			DOM.append(li, $('span.dispatch-projects-card-hash', undefined, c.hash));
			DOM.append(li, $('span.dispatch-projects-card-title', undefined, c.subject));
			DOM.append(li, $('span.dispatch-projects-card-at', undefined, hourMinute(c.at)));
			setupDispatchRowDetail(card, li, detailStore => {
				const detail = renderDispatchHoverCard({ head: c.subject, notes: [c.hash, project.label] });
				const bar = DOM.append(detail, $('.dispatch-hover-actions'));
				detailButton(bar, 'Open commit', 'primary', () => { o.hoverService.hideHover(true); void o.instantiationService.invokeFunction(openDeliverable, { kind: 'commit', ref: c.hash, label: c.subject, repo: project.dir }); }, detailStore);
				return detail;
			}, store);

		}
		more = items.length - CARD_COMMITS;
	}
	if (more > 0) {
		DOM.append(card, $('.dispatch-projects-card-more', undefined, localize('dispatchProjects.andMore', "and {0} more", more)));
	}
	return card;
}

// ---- the Projects page -------------------------------------------------------------------------------

type Mode = 'list' | 'timeline';
const pageMode = observableValue<Mode>('dispatchProjectsMode', 'list');
type Filter = 'active' | 'all' | 'elsewhere' | 'archived';

function matches(row: IDispatchProjectRow, filter: Filter): boolean {
	switch (filter) {
		case 'active': return row.registered && !row.archived;
		case 'all': return true;
		case 'elsewhere': return row.host !== 'local';
		case 'archived': return row.archived;
	}
}

class DispatchProjectsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchProjects.title', "Projects"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('dispatchProjects.description', "Every folder Dispatch knows about, on this Mac and on your other Macs. The sidebar only lists the registered ones."));
	override readonly maxWidth = 880;

	/** List or Timeline: kept for the window, so "‹ Projects" from a project comes back to the one it left. */
	private readonly mode = pageMode;
	private readonly filter = observableValue<Filter>(this, 'active');
	private readonly width = observableValue<number>(this, 880);
	private readonly busy = new Set<string>();
	private toolbarElement: HTMLElement | undefined;
	/** "No activity in 14 days" open (remembered). */
	private quietOpen: boolean;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.quietOpen = storageService.getBoolean(TL_FOLD_KEY, StorageScope.PROFILE, false);
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-projects-page');
		const toolbar = this.toolbarElement = DOM.append(container, $('.dispatch-projects-toolbar'));
		const progress = DOM.append(container, $('.dispatch-projects-index'));
		progress.setAttribute('role', 'status');
		progress.setAttribute('aria-live', 'polite');
		this._register(autorun(reader => {
			const state = indexProgress.read(reader);
			DOM.clearNode(progress);
			progress.classList.toggle('visible', !!state);
			if (!state) { return; }
			DOM.append(progress, $('span', undefined, state.state === 'interrupted'
				? localize('dispatchProjects.indexInterrupted', "Reading sessions stopped. Retrying shortly.")
				: state.total > 0
					? localize('dispatchProjects.indexProgress', "Reading your sessions · {0} of {1}", state.done.toLocaleString('en-US'), state.total.toLocaleString('en-US'))
					: localize('dispatchProjects.indexStarting', "Reading your sessions…")));
			if (state.state === 'running') {
				const track = DOM.append(progress, $('.dispatch-projects-index-track'));
				track.setAttribute('role', 'progressbar');
				track.setAttribute('aria-label', localize('dispatchProjects.indexLabel', "Reading your sessions"));
				const fill = DOM.append(track, $('span'));
				if (state.total > 0) {
					track.setAttribute('aria-valuemin', '0');
					track.setAttribute('aria-valuemax', String(state.total));
					track.setAttribute('aria-valuenow', String(state.done));
					fill.style.width = `${Math.min(100, state.done / state.total * 100)}%`;
				} else { track.classList.add('indeterminate'); }
			}
		}));
		const body = DOM.append(container, $('.dispatch-projects-body'));
		const store = this._register(new DisposableStore());
		void refreshPage();

		this._register(autorun(reader => {
			const data = pageData.read(reader);
			const indexing = indexBusy.read(reader);
			const error = pageError.read(reader);
			const mode = this.mode.read(reader);
			const filter = this.filter.read(reader);
			const width = this.width.read(reader);
			store.clear();
			const rows = data?.projects ?? [];
			this.renderToolbar(toolbar, rows, mode, filter, store);
			const shown = rows.filter(r => matches(r, filter));
			DOM.clearNode(body);
			if (!data) {
				DOM.append(body, $('.dispatch-projects-empty', undefined, error
					? localize('dispatchProjects.failed', "Could not read the projects: {0}", error)
					: localize('dispatchProjects.loading', "Looking…")));
				return;
			}
			if (!shown.length) {
				if (indexing) {
					const skeleton = DOM.append(body, $('.dispatch-projects-index-skeleton'));
					skeleton.setAttribute('aria-hidden', 'true');
					for (let i = 0; i < 3; i++) { DOM.append(skeleton, $('span')); }
					return;
				}
				if (!rows.length) {
					// nothing registered yet: the empty state points at the one thing to do (Add a project dialog)
					const empty = DOM.append(body, $('.dispatch-projects-empty.dispatch-ap-empty'));
					DOM.append(empty, $(`span.dispatch-ap-empty-icon${ThemeIcon.asCSSSelector(Codicon.folderLibrary)}`));
					DOM.append(empty, $('.dispatch-ap-empty-title', undefined, localize('dispatchProjects.noneYet', "No projects yet")));
					DOM.append(empty, $('.dispatch-ap-empty-text', undefined, localize('dispatchProjects.noneYetText', "A project is a folder your agents work in. Use one you have, start a new one, or copy one from the internet.")));
					const add = DOM.append(empty, $('button.dispatch-ap-empty-btn', { type: 'button' }, localize('dispatchProjects.addFirst', "Add a project")));
					store.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => void this.instantiationService.invokeFunction(a => a.get(ICommandService).executeCommand('dispatch.projects.new'))));
					return;
				}
				DOM.append(body, $('.dispatch-projects-empty', undefined, localize('dispatchProjects.none', "No projects here.")));
				return;
			}
			if (mode === 'list') {
				this.renderList(body, shown, filter, store);
			} else {
				this.renderTimeline(body, shown, data.now, width, store);
			}
		}));
	}

	private renderToolbar(parent: HTMLElement, rows: readonly IDispatchProjectRow[], mode: Mode, filter: Filter, store: DisposableStore): void {
		DOM.clearNode(parent);
		const modes = DOM.append(parent, $('.dispatch-projects-modes'));
		modes.setAttribute('role', 'tablist');
		for (const [m, label] of [['list', localize('dispatchProjects.list', "List")], ['timeline', localize('dispatchProjects.timeline', "Timeline")]] as const) {
			const b = DOM.append(modes, $('button.dispatch-projects-chip', undefined, label));
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', String(m === mode));
			b.classList.toggle('selected', m === mode);
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => this.mode.set(m, undefined)));
		}
		DOM.append(parent, $('span.dispatch-projects-spacer'));
		const filters = DOM.append(parent, $('.dispatch-projects-filters'));
		filters.setAttribute('role', 'tablist');
		const elsewhere = rows.find(r => r.host !== 'local');
		const list: [Filter, string][] = [
			['active', localize('dispatchProjects.active', "Active")],
			['all', localize('dispatchProjects.all', "All")],
		];
		if (elsewhere) {
			list.push(['elsewhere', elsewhere.machine]);
		}
		list.push(['archived', localize('dispatchProjects.archived', "Archived")]);
		for (const [f, label] of list) {
			const chip = DOM.append(filters, $('button.dispatch-projects-chip'));
			chip.setAttribute('role', 'tab');
			chip.setAttribute('aria-selected', String(f === filter));
			chip.classList.toggle('selected', f === filter);
			DOM.append(chip, $('span', undefined, label));
			DOM.append(chip, $('span.dispatch-projects-chip-count', undefined, String(rows.filter(r => matches(r, f)).length)));
			store.add(DOM.addDisposableListener(chip, DOM.EventType.CLICK, () => this.filter.set(f, undefined)));
		}
	}

	private renderList(parent: HTMLElement, rows: readonly IDispatchProjectRow[], filter: Filter, store: DisposableStore): void {
		// groups: this Mac's, the other Macs', the folders nobody registered (All), the archived ones
		const groups: [string | undefined, IDispatchProjectRow[]][] = [];
		const add = (head: string | undefined, list: IDispatchProjectRow[]) => { if (list.length) { groups.push([head, list]); } };
		const live = rows.filter(r => !r.archived);
		add(undefined, live.filter(r => r.registered && r.host === 'local'));
		const machines = [...new Set(live.filter(r => r.host !== 'local').map(r => r.machine))];
		for (const m of machines) {
			add(filter === 'elsewhere' ? undefined : localize('dispatchProjects.onMachine', "On {0}", m), live.filter(r => r.host !== 'local' && r.machine === m));
		}
		add(localize('dispatchProjects.notRegistered', "Not registered"), live.filter(r => !r.registered));
		const archived = rows.filter(r => r.archived);
		add(filter === 'archived' ? undefined : localize('dispatchProjects.archivedHead', "Archived · {0}", archived.length), archived);
		for (const [head, list] of groups) {
			const group = DOM.append(parent, $('.dispatch-projects-group'));
			if (head) {
				DOM.append(group, $('.dispatch-projects-group-head', undefined, head));
			}
			for (const row of list) {
				this.renderRow(group, row, store);
			}
		}
	}

	private renderRow(parent: HTMLElement, row: IDispatchProjectRow, store: DisposableStore): void {
		const el = DOM.append(parent, $('.dispatch-projects-row'));
		el.classList.toggle('archived', row.archived);
		el.classList.toggle('unregistered', !row.registered);
		el.tabIndex = 0;
		el.setAttribute('role', 'button');
		const line = DOM.append(el, $('.dispatch-projects-row-line'));
		line.appendChild(stateDot(row.state, { hoverService: this.hoverService, store }));
		const name = DOM.append(line, $('span.dispatch-projects-name', undefined, row.label));
		const path = DOM.append(line, $('span.dispatch-projects-path', undefined, row.dir ? homeRelative(row.dir, row) : localize('dispatchProjects.noFolder', "no folder")));
		// the name and the folder whole, where the line cuts them off
		store.add(setupDispatchTextHover(this.hoverService, line, () => ({ head: row.label, notes: [row.dir] }), { when: [name, path] }));
		DOM.append(line, $('span.dispatch-projects-spacer'));
		DOM.append(line, $('span.dispatch-projects-counts', undefined, counts(row)));
		if (row.host !== 'local') {
			DOM.append(line, $('span.dispatch-projects-machine', undefined, row.machine));
		}
		DOM.append(line, $('span.dispatch-projects-time', undefined, ago(row.last_at)));
		if (!row.registered) {
			const b = DOM.append(line, $('button.dispatch-projects-btn', undefined, localize('dispatchProjects.addAs', "Add as project"))) as HTMLButtonElement;
			b.disabled = this.busy.has(row.dir);
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, e => {
				e.stopPropagation();
				this.busy.add(row.dir);
				b.disabled = true;
				this.instantiationService.invokeFunction(a => addProject(a, row.dir, row.name))
					.catch(onUnexpectedError)
					.finally(() => { this.busy.delete(row.dir); b.disabled = false; });
			}));
		}
		if (row.now) {
			const now = DOM.append(el, $('.dispatch-projects-now', undefined, nowWords(row)));
			setupStatusHover(now, row, this.hoverService, this.instantiationService, store);
		} else {
			el.classList.add('single');
		}
		const open = () => showDispatchProject(this.customViewService, row.name);
		store.add(DOM.addDisposableListener(el, DOM.EventType.CLICK, open));
		store.add(DOM.addDisposableListener(el, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open();
			}
		}));
	}

	private renderTimeline(parent: HTMLElement, rows: readonly IDispatchProjectRow[], now: number, width: number, store: DisposableStore): void {
		renderProjectsTimeline(parent, rows, {
			now, width, names: true, status: true, hoverService: this.hoverService, instantiationService: this.instantiationService,
			open: row => showDispatchProject(this.customViewService, row.name),
			fold: {
				open: this.quietOpen,
				set: open => {
					// remembered, without drawing the page again (the group opens by itself)
					this.storageService.store(TL_FOLD_KEY, open, StorageScope.PROFILE, StorageTarget.USER);
					this.quietOpen = open;
				},
			},
		}, store);
	}

	layout(width: number, _height: number): void {
		this.width.set(Math.round(width), undefined);
	}

	override focus(): void {
		this.toolbarElement?.querySelector<HTMLElement>('.dispatch-projects-chip.selected')?.focus();
	}
}

// ---- a project's page --------------------------------------------------------------------------------

const TASKS_SHOWN = 6;
const DOCS_SHOWN = 6;
const SESSIONS_SHOWN = 12;

class DispatchProjectView extends AbstractCustomView {

	readonly title: IObservable<string>;
	override readonly description: IObservable<string | undefined>;
	override readonly maxWidth = 880;

	private readonly width = observableValue<number>(this, 880);
	private readonly showAllTasks = observableValue<boolean>(this, false);
	private readonly showAllDocs = observableValue<boolean>(this, false);
	private readonly showAllSessions = observableValue<boolean>(this, false);
	/** How many of the project's tasks are older than the Tasks tab's 30 days (its Archive). */
	private readonly archived = observableValue<{ name: string; count: number } | undefined>(this, undefined);
	private archivedFor: string | undefined;
	private breadcrumb: HTMLElement | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.title = derived(this, reader => projectData.read(reader)?.label ?? currentProject.read(reader) ?? '');
		this.description = derived(this, reader => {
			const row = projectData.read(reader);
			if (!row) {
				return undefined;
			}
			return [
				row.dir ? homeRelative(row.dir, row) : undefined,
				row.machine,
				row.branch || undefined,
				plural(row.sessions_14d, localize('dispatchProjects.session', "session"), localize('dispatchProjects.sessions', "sessions")),
				plural(row.tasks_open, localize('dispatchProject.openTask', "open task"), localize('dispatchProject.openTasks', "open tasks")),
				plural(row.docs, localize('dispatchProjects.doc', "doc"), localize('dispatchProjects.docs', "docs")),
			].filter(Boolean).join(' · ');
		});
		const registered = DispatchProjectRegisteredContext.bindTo(contextKeyService);
		this._register(autorun(reader => registered.set(projectData.read(reader)?.registered ?? true)));
		this._register(toDisposable(() => registered.reset()));
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-projects-page', 'dispatch-project-page');
		const crumb = this.breadcrumb = DOM.append(container, $('.dispatch-projects-breadcrumb'));
		const body = DOM.append(container, $('.dispatch-project-body'));
		const store = this._register(new DisposableStore());
		void refreshProject();
		// the Archive's size, asked once each time the page shows a project
		this._register(autorun(reader => {
			const name = projectData.read(reader)?.name;
			if (name && name !== this.archivedFor) {
				this.archivedFor = name;
				void askTasks<IDispatchTaskList>(this.commandService, { op: 'list', project: name, archived: true }).then(ans => {
					if (this.archivedFor === name) {
						this.archived.set({ name, count: ans.error ? 0 : ans.tasks?.length ?? 0 }, undefined);
					}
				});
			}
		}));

		this._register(autorun(reader => {
			const row = projectData.read(reader);
			const name = currentProject.read(reader);
			const width = this.width.read(reader);
			const allTasks = this.showAllTasks.read(reader);
			const allDocs = this.showAllDocs.read(reader);
			const allSessions = this.showAllSessions.read(reader);
			const archive = this.archived.read(reader);
			const archived = archive && row && archive.name === row.name ? archive.count : 0;
			const now = pageData.read(reader)?.now ?? Date.now() / 1000;
			store.clear();
			this.renderBreadcrumb(crumb, row?.label ?? name ?? '', store);
			DOM.clearNode(body);
			if (!row) {
				DOM.append(body, $('.dispatch-projects-empty', undefined, localize('dispatchProjects.loading', "Looking…")));
				return;
			}
			this.renderNow(body, row, store);
			this.renderChart(body, row, now, width, store);
			const columns = DOM.append(body, $('.dispatch-project-columns'));
			this.renderTasks(columns, row, allTasks, archived, store);
			this.renderDocs(columns, row, allDocs, store);
			this.renderSessions(body, row, allSessions, store);
		}));
	}

	private renderBreadcrumb(parent: HTMLElement, label: string, store: DisposableStore): void {
		// the page's title already names the project: the breadcrumb is only the way back
		DOM.clearNode(parent);
		const back = DOM.append(parent, $('button.dispatch-projects-crumb'));
		const caret = DOM.append(back, $(`span.dispatch-projects-crumb-sep${ThemeIcon.asCSSSelector(Codicon.chevronLeft)}`));
		caret.setAttribute('aria-hidden', 'true');
		DOM.append(back, $('span', undefined, localize('dispatchProjects.title', "Projects")));
		back.title = localize('dispatchProjects.backTo', "Back to Projects ({0})", label);
		store.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => this.customViewService.showCustomView(DISPATCH_PROJECTS_VIEW_ID)));
	}

	private section(parent: HTMLElement, head: string, count?: string): HTMLElement {
		const section = DOM.append(parent, $('.dispatch-project-section'));
		const h = DOM.append(section, $('.dispatch-projects-group-head'));
		DOM.append(h, $('span', undefined, head));
		if (count) {
			DOM.append(h, $('span.dispatch-projects-head-count', undefined, count));
		}
		return section;
	}

	private moreButton(parent: HTMLElement, label: string, onClick: () => void, store: DisposableStore): void {
		const b = DOM.append(parent, $('button.dispatch-projects-more', undefined, label));
		store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, onClick));
	}

	private renderNow(parent: HTMLElement, row: IDispatchProjectRow, store: DisposableStore): void {
		const section = this.section(parent, localize('dispatchProject.now', "Now"));
		if (row.state === 'waiting' || !row.summary) {
			const line = DOM.append(section, $('.dispatch-project-nowline'));
			line.appendChild(stateDot(row.state, { hoverService: this.hoverService, store }));
			const text = DOM.append(line, $('span', undefined, nowWords(row) || localize('dispatchProject.nothingYet', "Nothing yet.")));
			setupStatusHover(line, row, this.hoverService, this.instantiationService, store, text);
		}
		if (row.summary) {
			const text = DOM.append(section, $('.dispatch-project-summary', undefined, row.summary));
			store.add(setupDispatchTextHover(this.hoverService, text, () => ({ text: row.summary })));
		}
	}

	private renderChart(parent: HTMLElement, row: IDispatchProjectRow, now: number, width: number, store: DisposableStore): void {
		const section = this.section(parent, localize('dispatchProject.last14', "Last 14 days"));
		if (!hasActivity(row)) {
			DOM.append(section, $('.dispatch-projects-empty.small', undefined, localize('dispatchProject.nothing14', "Nothing in the last 14 days.")));
			return;
		}
		// lined up with the section's head (12 px in on each side)
		renderProjectsTimeline(DOM.append(section, $('.dispatch-project-chart')), [row], { now, width: width - 24, names: false, status: false, hoverService: this.hoverService, instantiationService: this.instantiationService }, store);
	}

	private renderTasks(parent: HTMLElement, row: IDispatchProjectRow, all: boolean, archived: number, store: DisposableStore): void {
		if (!row.tasks) {
			this.section(parent, localize('dispatchProject.tasks', "Tasks"), localize('dispatchProject.open', "{0} open", row.tasks_open));
			return;
		}
		const tasks = row.tasks;
		const section = this.section(parent, localize('dispatchProject.tasks', "Tasks"), localize('dispatchProject.open', "{0} open", row.tasks_open));
		if (!tasks.length) {
			DOM.append(section, $('.dispatch-projects-empty.small', undefined, localize('dispatchProject.noTasks', "No open tasks.")));
			if (archived) {
				this.moreButton(DOM.append(section, $('.dispatch-project-more-row')), localize('dispatchProject.archive', "Archive {0}", archived), () => {
					void this.commandService.executeCommand(DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, { name: row.name, label: row.label });
				}, store);
			}
			return;
		}
		for (const t of all ? tasks : tasks.slice(0, TASKS_SHOWN)) {
			// a row opens the task page (the person never reads task-xxxx: no id, not even in the tooltip)
			const r = DOM.append(section, $('.dispatch-project-item.clickable'));
			r.tabIndex = 0;
			// the circle is a checkbox: a click closes the task, the way a to-do list does
			const check = DOM.append(r, $<HTMLButtonElement>('button.dispatch-project-item-check', { type: 'button', 'aria-label': localize('dispatchProject.markDone', "Mark done") }));
			DOM.append(check, $(`span.dispatch-project-item-icon${ThemeIcon.asCSSSelector(t.status === 'in_progress' ? Codicon.circleLargeFilled : Codicon.circleLarge)}`));
			DOM.append(check, $(`span.dispatch-project-item-icon.hover${ThemeIcon.asCSSSelector(Codicon.passFilled)}`));
			store.add(DOM.addDisposableListener(check, DOM.EventType.CLICK, async e => {
				e.stopPropagation();
				check.disabled = true;
				if (await setDispatchTaskDone(this.commandService, t.id, true)) {
					r.classList.add('done');
					void refreshProject(true);
				} else {
					check.disabled = false;
				}
			}));
			DOM.append(r, $('span.dispatch-project-item-title', undefined, t.title));
			if (t.status === 'blocked') {
				DOM.append(r, $('span.dispatch-project-item-meta', undefined, localize('dispatchProject.blocked', "Blocked")));
			}
			const open = () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, t.id, 'project');
			store.add(DOM.addDisposableListener(r, DOM.EventType.CLICK, open));
			store.add(DOM.addDisposableListener(r, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter') { open(); } }));
		}
		store.add(linkifyDispatchTasksWith(this.commandService, section));
		const more = !all && tasks.length > TASKS_SHOWN;
		if (more || archived) {
			const buttons = DOM.append(section, $('.dispatch-project-more-row'));
			if (more) {
				this.moreButton(buttons, localize('dispatchProject.all', "All {0}", tasks.length), () => this.showAllTasks.set(true, undefined), store);
			}
			if (archived) {
				// the tasks before the last 30 days, read only (the Tasks tab and the graph show the rest)
				this.moreButton(buttons, localize('dispatchProject.archive', "Archive {0}", archived), () => {
					void this.commandService.executeCommand(DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, { name: row.name, label: row.label });
				}, store);
			}
		}
	}

	private renderDocs(parent: HTMLElement, row: IDispatchProjectRow, all: boolean, store: DisposableStore): void {
		if (!row.doc_list) {
			this.section(parent, localize('dispatchProject.docs', "Docs"), String(row.docs));
			return;
		}
		const docs = row.doc_list;
		const section = this.section(parent, localize('dispatchProject.docs', "Docs"), String(row.docs));
		if (!docs.length) {
			DOM.append(section, $('.dispatch-projects-empty.small', undefined, localize('dispatchProject.noDocs', "No documents yet.")));
			return;
		}
		for (const d of all ? docs : docs.slice(0, DOCS_SHOWN)) {
			const r = DOM.append(section, $('.dispatch-project-item.clickable'));
			r.tabIndex = 0;
			const iconId = d.ext === 'html' || d.ext === 'htm' ? Codicon.globe : /^(png|jpe?g|gif|webp|svg)$/.test(d.ext) ? Codicon.fileMedia : Codicon.markdown;
			const icon = DOM.append(r, $(`span.dispatch-project-item-icon${ThemeIcon.asCSSSelector(iconId)}`));
			icon.setAttribute('aria-hidden', 'true');
			DOM.append(r, $('span.dispatch-project-item-title', undefined, d.title));
			DOM.append(r, $('span.dispatch-project-item-meta', undefined, ago(d.mtime)));
			// where it is: the row does not say
			store.add(setupDispatchTextHover(this.hoverService, r, () => ({ head: d.title, notes: [d.path] }), { when: () => true }));
			const open = () => {
				if (row.host === 'local' && d.path.startsWith('/')) {
					void this.commandService.executeCommand('_dispatch.openPath', d.path);
				}
			};
			store.add(DOM.addDisposableListener(r, DOM.EventType.CLICK, open));
			store.add(DOM.addDisposableListener(r, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter') { open(); } }));
		}
		if (!all && docs.length > DOCS_SHOWN) {
			this.moreButton(section, localize('dispatchProject.all', "All {0}", docs.length), () => this.showAllDocs.set(true, undefined), store);
		}
	}

	private renderSessions(parent: HTMLElement, row: IDispatchProjectRow, all: boolean, store: DisposableStore): void {
		const section = this.section(parent, localize('dispatchProject.sessions', "Sessions"), localize('dispatchProject.last14count', "{0} in 14 days", row.sessions_14d));
		if (!row.session_list) {
			DOM.append(section, $('.dispatch-projects-empty.small', undefined, localize('dispatchProjects.loading', "Looking…")));
			return;
		}
		const sessions = row.session_list;
		if (!sessions.length && !row.running.length) {
			DOM.append(section, $('.dispatch-projects-empty.small', undefined, localize('dispatchProject.noSessions', "No sessions in the last 14 days.")));
			return;
		}
		// every session open right now (running, waiting, idle in a terminal, here or on another Mac) first
		const open = [...row.running].sort((x, y) => Number(y.state === 'working') - Number(x.state === 'working') || y.at - x.at);
		const openIds = new Set(open.map(s => s.id));
		for (const s of open) {
			this.renderSessionRow(section, s, store, true);
		}
		const rest = sessions.filter(s => !openIds.has(s.id));
		for (const s of all ? rest : rest.slice(0, SESSIONS_SHOWN)) {
			this.renderSessionRow(section, s, store, false);
		}
		if (!all && rest.length > SESSIONS_SHOWN) {
			this.moreButton(section, localize('dispatchProject.all', "All {0}", sessions.length), () => this.showAllSessions.set(true, undefined), store);
		}
	}

	private renderSessionRow(parent: HTMLElement, s: IDispatchProjectSession, store: DisposableStore, _open: boolean): void {
		const r = DOM.append(parent, $('.dispatch-project-item.clickable'));
		r.tabIndex = 0;
		if (s.state === 'working') {
			r.appendChild(stateDot('running', { hoverService: this.hoverService, store }));
		} else if (s.attention) {
			r.appendChild(stateDot('waiting', { hoverService: this.hoverService, store }));
		} else {
			r.appendChild(stateDot('quiet'));
		}
		DOM.append(r, $('span.dispatch-project-item-title', undefined, s.title || localize('dispatchProject.untitled', "Untitled session")));
		const meta = [engineName(s.agent), s.worktree ? localize('dispatchWorktreeTag', "own copy") : undefined, s.host !== 'local' ? localize('dispatchProject.onHost', "on {0}", s.host_name || s.host) : undefined].filter(Boolean).join(' · ');
		DOM.append(r, $('span.dispatch-project-item-meta', undefined, meta));
		DOM.append(r, $('span.dispatch-project-item-time', undefined, ago(s.at)));
		// the whole title and where it runs: the row does not say
		store.add(setupDispatchTextHover(this.hoverService, r, () => ({ head: s.title || localize('dispatchProject.untitled', "Untitled session"), notes: [s.cwd] }), { when: () => true }));
		const open = () => this.instantiationService.invokeFunction(a => openProjectSession(a, s)).catch(onUnexpectedError);
		store.add(DOM.addDisposableListener(r, DOM.EventType.CLICK, open));
		store.add(DOM.addDisposableListener(r, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter') { void open(); } }));
	}

	layout(width: number, _height: number): void {
		this.width.set(Math.round(width), undefined);
	}

	override focus(): void {
		this.breadcrumb?.querySelector<HTMLElement>('.dispatch-projects-crumb')?.focus();
	}
}

/** The registered projects whose label or name contains `query` (the sessions picker lists them first). */
export function dispatchProjectsMatching(query: string): { name: string; label: string; machine: string }[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return [];
	}
	return (dispatchProjectsRegistry.get() ?? [])
		.filter(p => !p.archived && (p.label.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
		.sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)) || a.label.localeCompare(b.label))
		.slice(0, 5)
		.map(p => ({ name: p.name, label: p.label, machine: p.machine }));
}

/**
 * The + that shows while the pointer is on the Projects row: Add Project, the Projects page's flow (preference
 * "Projects 悬停加项目"; it was Mark All as Done, which did nothing on a row without sessions). sessionsList.ts calls
 * this with its toolbar menu and section type key: it imports this file, so this file cannot import it.
 */
export function registerProjectsRowActions(menu: MenuId, sectionType: RawContextKey<string>): void {
	MenuRegistry.appendMenuItem(menu, {
		command: { id: 'dispatch.projects.new', title: localize2('dispatchProjects.new', "Add Project"), icon: Codicon.add },
		group: 'navigation',
		order: 0,
		when: ContextKeyExpr.equals(sectionType.key, DISPATCH_PROJECTS_SECTION_ID),
	});
}

/**
 * The Projects row under Automations in the sessions list: a line icon and the label like Automations, no count,
 * + (Add Project) on hover; lit while the Projects page or a project's page is shown. A click shows the Projects page.
 */
export function renderProjectsSectionRow(template: { readonly container: HTMLElement; readonly icon: HTMLElement; readonly label: HTMLElement; readonly count: HTMLElement; readonly newBadge: HTMLElement; readonly elementDisposables: DisposableStore }, label: string, customViewService: ICustomViewService): void {
	template.container.classList.add('session-section-shortcut', 'dispatch-projects-section');
	template.count.textContent = '';
	template.count.style.display = 'none';
	template.newBadge.style.display = 'none';
	DOM.clearNode(template.icon);
	template.icon.style.display = '';
	template.icon.className = `session-section-icon ${ThemeIcon.asClassName(Codicon.folderLibrary)}`;
	template.label.textContent = label;
	template.elementDisposables.add(autorun(reader => {
		const active = customViewService.activeCustomView.read(reader)?.id;
		template.container.classList.toggle('active', active === DISPATCH_PROJECTS_VIEW_ID || active === DISPATCH_PROJECT_VIEW_ID);
	}));
	template.elementDisposables.add(toDisposable(() => template.container.classList.remove('dispatch-projects-section', 'active')));
}
