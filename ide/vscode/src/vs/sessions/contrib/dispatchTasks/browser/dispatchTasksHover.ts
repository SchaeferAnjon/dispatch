/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the tasks in the sessions list's hovers (kanban design/task-model/DECISIONS.md
 *  「悬停出任务」, patches/430-tasks.patch; sessionsList.ts shows them).
 *
 *  The three hover cards of the left sidebar share one row (dispatchWaitingModel.ts renderHoverRow, the
 *  Waiting for you row's card of design/waiting/redesign): an icon, the title, "· one line of detail".
 *  - A project's row: "kanban · 50 in progress · 9 waiting for you", then what in it waits for the person
 *    (approve, decide, unread: their kind's icon and what they wait on), then its tasks in progress (the
 *    status dot and the step it is on, not the long title cut off), five rows at most; the last line
 *    "and 45 more in progress · Task graph". A waiting row opens its session, a task row its task page,
 *    Task graph the project's graph.
 *  - A session's row: its own hover gets a Tasks section at the bottom with the same rows (this session's
 *    tasks: the dot, the step or what it waits on), then "and N more · Task graph". Nothing is added when
 *    the session has no tasks.
 *
 *  `dispatch task list --project | --session --json` through dispatch-bridge's `dispatch.tasks`,
 *  asked when the pointer enters the row (the hover waits its usual delay, so the answer is
 *  usually there when it shows) and kept for 20 s.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTasks.css';
import '../../../../workbench/contrib/chat/browser/agentSessions/media/sessionSummaryHover.css';
import * as DOM from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { dispatchProjectsRegistry, IDispatchProject, projectOfSession } from '../../sessions/browser/dispatchProjectsModel.js';
import {
	dispatchWaitingVisible, IDispatchWaitingItem, renderHoverFoot, renderHoverRow, waitingDetail, waitingIcon, waitingTitle
} from '../../sessions/browser/dispatchWaitingModel.js';
import { openWaitingItem } from '../../sessions/browser/dispatchWaitingQueue.js';
import {
	ago, askTasks, DISPATCH_OPEN_TASK_COMMAND, DISPATCH_OPEN_TASK_GRAPH_COMMAND, DispatchTaskStatus, IDispatchTask, IDispatchTaskList, shownStatus, STATUS_LABEL, statusMark, waitingItemOfTask
} from './dispatchTasksModel.js';

import { setupDispatchRowDetail } from '../../../../workbench/browser/dispatchHoverCard.js';
import { bindWaitingDetail, prefetchTaskDetails, renderTaskDetail } from './dispatchHoverDetails.js';

const $ = DOM.$;
const TTL_MS = 20_000;
const PROJECT_ROWS = 5;
const SESSION_ROWS = 4;

/** Open the task graph of a session from the sessions list: `_dispatch.openSessionTaskGraph(resource)`. */
export const DISPATCH_OPEN_SESSION_TASK_GRAPH_COMMAND = '_dispatch.openSessionTaskGraph';

/** What the cards need; the sessions list has them at hand. */
export interface ITasksHoverServices {
	readonly commandService: ICommandService;
	readonly management: ISessionsManagementService;
	/** Opening a waiting row from a card goes through Waiting for you's own opener (the queue bar comes with it). */
	readonly instantiationService?: IInstantiationService;
	/** Close the hover (a click on the card leaves it behind otherwise: it stays while the pointer is on it). */
	readonly hideHover: () => void;
}

interface ICached {
	readonly at: number;
	readonly promise: Promise<IDispatchTaskList>;
	value?: IDispatchTaskList;
}
const cache = new Map<string, ICached>();

function ask(commandService: ICommandService, key: string, req: Record<string, unknown>): ICached {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) {
		return hit;
	}
	const entry: ICached = {
		// the last answer shows at once while a fresh one is asked (the card never waits twice for a project)
		value: hit?.value && !hit.value.error ? hit.value : undefined,
		at: Date.now(),
		promise: askTasks<IDispatchTaskList>(commandService, req).then(ans => {
			entry.value = ans;
			if (ans.error) {
				cache.delete(key); // ask again next time
			}
			return ans;
		}),
	};
	cache.set(key, entry);
	return entry;
}

function askProject(commandService: ICommandService, project: IDispatchProject): ICached {
	return ask(commandService, `p|${project.name}`, { op: 'list', project: project.name });
}

function askSession(commandService: ICommandService, session: ISession): ICached {
	const resource = session.resource.toString();
	return ask(commandService, `s|${resource}`, { op: 'list', session: resource });
}

/** The registered project a sessions-list group stands for (the group is named by the project's label). */
export function projectOfSection(section: { label: string; sessions: readonly ISession[] }): IDispatchProject | undefined {
	const projects = dispatchProjectsRegistry.get();
	for (const s of section.sessions) {
		const p = projectOfSession(s, projects)?.project;
		if (p) {
			return p;
		}
	}
	return projects?.find(p => p.label === section.label) ?? projects?.find(p => p.name === section.label);
}

/** Start asking when the pointer enters the row, so the card has its answer when it shows. */
export function prefetchProjectTasks(commandService: ICommandService, project: IDispatchProject | undefined): void {
	if (project) {
		askProject(commandService, project);
		void prefetchTaskDetails(commandService, project.name);
	}
}

export function prefetchSessionTasks(commandService: ICommandService, session: ISession): void {
	const entry = askSession(commandService, session);
	void entry.promise.then(data => { for (const project of new Set((data.tasks ?? []).map(t => t.project).filter(Boolean))) { void prefetchTaskDetails(commandService, project); } });
}

function lastTouched(t: IDispatchTask): number {
	return Math.max(t.updated_at, t.created_at, t.done_at ?? 0);
}

/** The step a task is on (its plan's active one, else the next to do). */
function currentStep(t: IDispatchTask): string {
	return t.plan.find(p => p.state === 'active')?.text ?? t.plan.find(p => p.state === 'todo')?.text ?? '';
}

/** A task's line of detail in a hover: the step it is on; what its session waits on; To do; when it was done. */
function taskDetail(t: IDispatchTask, status: DispatchTaskStatus, management: ISessionsManagementService): string {
	if (status === 'waiting') {
		// the amber dot already says Waiting for you: only on what
		const waiting = waitingItemOfTask(management, t);
		return waiting ? waitingDetail(waiting) : t.only_you ? localize('dispatchTasksHover.onlyYou', "only you can do this") : '';
	}
	if (status === 'in_progress') {
		return currentStep(t);
	}
	return status === 'done' ? ago(t.done_at) : STATUS_LABEL[status];
}

function taskRow(parent: HTMLElement, services: ITasksHoverServices, t: IDispatchTask, status: DispatchTaskStatus, store: DisposableStore): void {
	const row = renderHoverRow(parent, {
		dot: status,
		title: t.title,
		detail: taskDetail(t, status, services.management),
		onClick: () => {
			services.hideHover();
			void services.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, t.id);
		},
	}, store);
	const instantiation = services.instantiationService;
	if (instantiation) { setupDispatchRowDetail(parent.closest<HTMLElement>('.dispatch-hover-card') ?? parent, row, s => instantiation.invokeFunction(renderTaskDetail, { ...t, status }, s), store); }
}

/** "Task graph" at the end of a card's last line. */
function graphLink(foot: HTMLElement, onClick: () => void, store: DisposableStore): HTMLElement {
	const link = DOM.append(foot, $<HTMLButtonElement>('button.dispatch-hover-link', { type: 'button' }));
	link.appendChild(renderIcon(Codicon.gitMerge));
	DOM.append(link, $('span', undefined, localize('dispatchTasksHover.graph', "Task graph")));
	store.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, e => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	}));
	return link;
}

/** "and 45 more in progress · Task graph" (or just Task graph). */
function foot(parent: HTMLElement, rest: string, onGraph: () => void, store: DisposableStore): HTMLElement {
	const line = renderHoverFoot(parent, '');
	if (rest) {
		DOM.append(line, $('span', undefined, rest));
		DOM.append(line, $('span', undefined, '·'));
	}
	graphLink(line, onGraph, store);
	return line;
}

/** "3 in progress · 1 waiting for you", or what there is instead. `waitingCount`: the project card's own count. */
function counts(tasks: readonly IDispatchTask[], statusOf: (t: IDispatchTask) => DispatchTaskStatus, waitingCount?: number): string {
	const running = tasks.filter(t => statusOf(t) === 'in_progress').length;
	const waiting = waitingCount ?? tasks.filter(t => statusOf(t) === 'waiting').length;
	const parts: string[] = [];
	if (running) {
		parts.push(localize('dispatchTasksHover.running', "{0} in progress", running));
	}
	if (waiting) {
		parts.push(localize('dispatchTasksHover.waiting', "{0} waiting for you", waiting));
	}
	if (!parts.length) {
		const todo = tasks.filter(t => statusOf(t) === 'todo').length;
		parts.push(todo
			? localize('dispatchTasksHover.todo', "{0} to do", todo)
			: tasks.length ? localize('dispatchTasksHover.allDone', "All done") : localize('dispatchTasksHover.none', "No tasks"));
	}
	return parts.join(' · ');
}

function trimSlash(p: string): string {
	return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** The sessions of this project that wait for the person (approve, decide, unread), most pressing first. */
function waitingIn(project: IDispatchProject): IDispatchWaitingItem[] {
	const dir = project.dir ? trimSlash(project.dir) : '';
	const base = dir.split('/').pop() ?? '';
	return (dispatchWaitingVisible.get()?.items ?? []).filter(i => i.kind !== 'only_you' && (
		(dir && i.project_dir && trimSlash(i.project_dir) === dir) || (!!i.project && (i.project === project.name || i.project === base))));
}

function openWaiting(services: ITasksHoverServices, item: IDispatchWaitingItem): void {
	services.hideHover();
	void services.instantiationService?.invokeFunction(accessor => openWaitingItem(accessor, item));
}

/**
 * The card of a project's row (the Waiting for you card's rows): what waits, then what is in progress.
 * Task ids in the titles become task links (the person never reads task-xxxx). `store` holds this
 * showing's listeners.
 */
export function renderProjectTasksHover(services: ITasksHoverServices, project: IDispatchProject, store: DisposableStore): HTMLElement {
	const { commandService, management, hideHover } = services;
	const card = $('.dispatch-hover-card.dispatch-tasks-hover');
	card.setAttribute('aria-label', localize('dispatchTasksHover.aria', "{0}: tasks", project.label));
	const head = DOM.append(card, $('.dispatch-hover-head'));
	DOM.append(head, $('span.dispatch-hover-head-name', undefined, project.label));
	const headCounts = DOM.append(head, $('span.dispatch-hover-head-counts'));
	const rows = DOM.append(card, $('.dispatch-hover-rows'));
	// while the list is on its way: five placeholder rows as tall as real ones (DESIGN.md: skeleton rows with the
	// status line's shimmer), so the card has its final height from the first frame and does not jump
	rows.setAttribute('aria-busy', 'true');
	rows.setAttribute('aria-label', localize('dispatchTasksHover.loading', "Loading tasks…"));
	for (let i = 0; i < PROJECT_ROWS; i++) {
		const row = DOM.append(rows, $('.dispatch-hover-row.dispatch-tasks-hover-skeleton'));
		DOM.append(row, $('span.dispatch-hover-lead')).appendChild(statusMark('todo'));
		const bar = DOM.append(row, $('span.dispatch-tasks-hover-bar'));
		bar.style.width = `${[78, 64, 86, 58, 72][i]}%`;
	}
	const openGraph = () => {
		hideHover();
		void commandService.executeCommand(DISPATCH_OPEN_TASK_GRAPH_COMMAND, 'project', { name: project.name, label: project.label });
	};
	const footLine = foot(card, '', openGraph, store);

	const fill = (ans: IDispatchTaskList) => {
		DOM.clearNode(rows);
		rows.removeAttribute('aria-busy');
		rows.removeAttribute('aria-label');
		rows.classList.add('dispatch-tasks-hover-arrived');
		if (ans.error) {
			renderHoverFoot(rows, localize('dispatchTasksHover.error', "Tasks are not available"));
			return;
		}
		const tasks = ans.tasks ?? [];
		const statusOf = (t: IDispatchTask) => shownStatus(t, management);
		// "N waiting for you" is what Waiting for you lists for this project: its sessions that wait, and the
		// tasks only the person can do (no session waits on them, so no row: the last line counts them)
		const waiting = waitingIn(project);
		const onlyYou = tasks.filter(t => t.only_you && statusOf(t) === 'waiting').length;
		headCounts.textContent = ` · ${counts(tasks, statusOf, waiting.length + onlyYou)}`;
		// what waits first (its session's kind icon and what it waits on), then the tasks in progress, five in all
		const running = tasks.filter(t => statusOf(t) === 'in_progress').sort((a, b) => lastTouched(b) - lastTouched(a));
		let shown = 0;
		for (const item of waiting.slice(0, PROJECT_ROWS)) {
			const row = renderHoverRow(rows, { id: item.id, icon: waitingIcon(item), title: waitingTitle(item), detail: waitingDetail(item), onClick: () => openWaiting(services, item) }, store);
			services.instantiationService?.invokeFunction(bindWaitingDetail, card, row, item, store);
			shown++;
		}
		const runningShown = running.slice(0, Math.max(0, PROJECT_ROWS - shown));
		for (const t of runningShown) {
			taskRow(rows, services, t, 'in_progress', store);
		}
		if (!waiting.length && !running.length) {
			renderHoverFoot(rows, tasks.length
				? localize('dispatchTasksHover.nothingRunning', "Nothing in progress")
				: localize('dispatchTasksHover.empty', "Tasks appear when the agent plans something."));
		}
		const rest: string[] = [];
		const moreWaiting = waiting.length - Math.min(waiting.length, PROJECT_ROWS);
		const moreRunning = running.length - runningShown.length;
		if (moreWaiting > 0) {
			rest.push(localize('dispatchTasksHover.moreWaiting', "{0} more waiting", moreWaiting));
		}
		if (onlyYou > 0) {
			rest.push(localize('dispatchTasksHover.onlyYouCount', "{0} only you can do", onlyYou));
		}
		if (moreRunning > 0) {
			rest.push(localize('dispatchTasksHover.moreRunning', "{0} more in progress", moreRunning));
		}
		DOM.clearNode(footLine);
		if (rest.length) {
			DOM.append(footLine, $('span', undefined, localize('dispatchTasksHover.and', "and {0}", rest.join(' · '))));
			DOM.append(footLine, $('span', undefined, '·'));
		}
		graphLink(footLine, openGraph, store);
		store.add(linkifyDispatchTasksWith(commandService, rows));
	};
	const entry = askProject(commandService, project);
	if (entry.value) {
		fill(entry.value);
	} else {
		void entry.promise.then(ans => {
			if (!store.isDisposed) {
				fill(ans);
			}
		});
	}
	return card;
}

/** A session's own hover (SessionSummaryHoverWidget) with its tasks added at the bottom, in the card rows. */
export function appendSessionTasks(services: ITasksHoverServices, hover: HTMLElement, session: ISession, store: DisposableStore): HTMLElement {
	const { commandService, management, hideHover } = services;
	const section = DOM.append(hover, $('.session-summary-hover-section.dispatch-tasks-hover-session.hidden'));
	const fill = (ans: IDispatchTaskList) => {
		const tasks = ans.error ? [] : ans.tasks ?? [];
		if (!tasks.length) {
			return;
		}
		const statusOf = (t: IDispatchTask) => shownStatus(t, management);
		const card = DOM.append(section, $('.dispatch-hover-card.dispatch-hover-card-inline'));
		const head = DOM.append(card, $('.dispatch-hover-head'));
		DOM.append(head, $('span.dispatch-hover-head-name', undefined, localize('dispatchTasksHover.tasks', "Tasks")));
		DOM.append(head, $('span.dispatch-hover-head-counts', undefined, ` · ${counts(tasks, statusOf)}`));
		// the list's own order: waiting, in progress, to do, then the latest done
		const list = DOM.append(card, $('.dispatch-hover-rows'));
		for (const t of tasks.slice(0, SESSION_ROWS)) {
			taskRow(list, services, t, statusOf(t), store);
		}
		const more = tasks.length - Math.min(tasks.length, SESSION_ROWS);
		foot(card, more > 0 ? localize('dispatchTasksHover.more', "and {0} more", more) : '', () => {
			hideHover();
			void commandService.executeCommand(DISPATCH_OPEN_SESSION_TASK_GRAPH_COMMAND, session.resource.toString());
		}, store);
		section.classList.remove('hidden');
		store.add(linkifyDispatchTasksWith(commandService, list));
	};
	const entry = askSession(commandService, session);
	if (entry.value) {
		fill(entry.value);
	} else {
		void entry.promise.then(ans => {
			if (!store.isDisposed) {
				fill(ans);
			}
		});
	}
	return hover;
}

/**
 * The sessions list: a project's row (a `workspace:` section) shows its tasks on hover (in progress, waiting for
 * you, the latest few); a click on the card opens the project's task graph.
 */
export function bindProjectTasksHover(container: HTMLElement, section: { readonly id: string; readonly label: string; readonly sessions: readonly ISession[] }, instantiationService: IInstantiationService, store: DisposableStore): void {
	const project = section.id.startsWith('workspace:') ? projectOfSection(section) : undefined;
	if (!project) {
		return;
	}
	const services = instantiationService.invokeFunction(accessor => {
		const hoverService = accessor.get(IHoverService);
		return {
			commandService: accessor.get(ICommandService),
			management: accessor.get(ISessionsManagementService),
			instantiationService: accessor.get(IInstantiationService),
			hoverService,
			hideHover: () => hoverService.hideHover(true),
		};
	});
	const cardStore = store.add(new DisposableStore());
	store.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_ENTER, () => prefetchProjectTasks(services.commandService, project)));
	// The row's buttons (New Session, Task Graph …) have hovers of their own: over them the card steps aside. Every
	// element the pointer enters in the row asks for the card again (mouseover bubbles): the card on screen is kept
	// (same id, same element) instead of a new one each time, which made it flicker across the row (task-fz0fn).
	let overButtons = false;
	store.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_OVER, e => {
		overButtons = !!(e.target as HTMLElement | null)?.closest?.('.session-section-toolbar');
	}, true));
	let card: HTMLElement | undefined;
	const id = `dispatch-project-tasks:${project.name}`;
	store.add(services.hoverService.setupDelayedHover(container, () => {
		if (overButtons) {
			return { content: '' };
		}
		if (!card?.isConnected) {
			cardStore.clear();
			card = renderProjectTasksHover(services, project, cardStore);
		}
		return {
			id,
			content: card,
			appearance: { showPointer: true },
			position: { hoverPosition: HoverPosition.RIGHT },
			persistence: { hideOnHover: false },
		};
	}, { groupId: 'sessions-list' }));
}
