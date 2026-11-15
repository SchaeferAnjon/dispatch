/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a project's Archive (patches/430-tasks.patch; kanban design/task-model/DECISIONS.md
 *  「旧任务的呈现」). The Tasks tab and the task graph show the last 30 days; the project's older
 *  tasks are here, read only: `dispatch task list --project … --archived --json` through
 *  dispatch-bridge, newest first, grouped by month. Built from the Waiting for you page's parts
 *  (dispatchWaiting.css): a group head per month, a 32 px row per task with its status dot, the
 *  title, the status in grey and the date. A row opens the task page, whose breadcrumb leads back
 *  here; "‹ project" at the top goes back to the project's page.
 *--------------------------------------------------------------------------------------------*/

import '../../sessions/browser/media/dispatchWaiting.css';
import '../../sessions/browser/media/dispatchProjects.css';
import '../../dispatchTasks/browser/media/dispatchTasks.css';
import './media/dispatchTaskGraph.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import {
	askTasks, DISPATCH_OPEN_TASK_COMMAND, dispatchArchiveProject, IDispatchTask, IDispatchTaskList, IDispatchTaskProject, STATUS_LABEL, statusMark, TASK_WINDOW_DAYS
} from '../../dispatchTasks/browser/dispatchTasksModel.js';

const $ = DOM.$;

export const DISPATCH_TASK_ARCHIVE_VIEW_ID = 'dispatch.taskArchive';

function lastTouched(t: IDispatchTask): number {
	return Math.max(t.updated_at, t.created_at, t.done_at ?? 0);
}

/** "Aug 12" (the year when it is not this one). */
function day(at: number): string {
	const d = new Date(at * 1000);
	return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
		? { month: 'short', day: 'numeric' }
		: { year: 'numeric', month: 'short', day: 'numeric' });
}

function month(at: number): string {
	return new Date(at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

export class DispatchTaskArchiveView extends AbstractCustomView {

	readonly title: IObservable<string> = derived(this, () => localize('dispatchTaskArchive.title', "Archive"));
	override readonly description: IObservable<string | undefined> = derived(this, reader => {
		const project = dispatchArchiveProject.read(reader);
		return project
			? localize('dispatchTaskArchive.description', "Tasks in {0} last touched more than {1} days ago. Read only.", project.label, TASK_WINDOW_DAYS)
			: undefined;
	});
	override readonly maxWidth = 880;

	private readonly data = observableValue<IDispatchTaskList | undefined>(this, undefined);
	private requestId = 0;
	private crumb: HTMLElement | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-waiting-page', 'dispatch-task-archive-page');
		const crumb = this.crumb = DOM.append(container, $('.dispatch-projects-breadcrumb'));
		const list = DOM.append(container, $('.dispatch-waiting-list'));
		const store = this._register(new DisposableStore());
		this._register(autorun(reader => {
			void this.load(dispatchArchiveProject.read(reader));
		}));
		this._register(autorun(reader => {
			const project = dispatchArchiveProject.read(reader);
			const data = this.data.read(reader);
			store.clear();
			this.renderCrumb(crumb, project, store);
			this.renderList(list, project, data, store);
		}));
	}

	private async load(project: IDispatchTaskProject | undefined): Promise<void> {
		const id = ++this.requestId;
		this.data.set(undefined, undefined);
		if (!project) {
			return;
		}
		const ans = await askTasks<IDispatchTaskList>(this.commandService, { op: 'list', project: project.name, archived: true });
		if (id === this.requestId) {
			this.data.set(ans, undefined);
		}
	}

	private renderCrumb(parent: HTMLElement, project: IDispatchTaskProject | undefined, store: DisposableStore): void {
		DOM.clearNode(parent);
		if (!project) {
			return;
		}
		const back = DOM.append(parent, $('button.dispatch-projects-crumb', { type: 'button' }));
		const caret = DOM.append(back, $(`span.dispatch-projects-crumb-sep${ThemeIcon.asCSSSelector(Codicon.chevronLeft)}`));
		caret.setAttribute('aria-hidden', 'true');
		DOM.append(back, $('span', undefined, project.label));
		back.title = localize('dispatchTaskArchive.back', "Back to {0}", project.label);
		store.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => void this.commandService.executeCommand('dispatch.projects.open', project.name)));
	}

	private renderList(parent: HTMLElement, project: IDispatchTaskProject | undefined, data: IDispatchTaskList | undefined, store: DisposableStore): void {
		DOM.clearNode(parent);
		if (!project) {
			DOM.append(parent, $('.dispatch-waiting-empty', undefined, localize('dispatchTaskArchive.none', "Open a project's Archive from its page.")));
			return;
		}
		if (!data) {
			DOM.append(parent, $('.dispatch-waiting-empty', undefined, localize('dispatchTaskArchive.loading', "Looking…")));
			return;
		}
		if (data.error) {
			DOM.append(parent, $('.dispatch-waiting-empty', undefined, data.error));
			return;
		}
		const tasks = [...data.tasks ?? []].sort((a, b) => lastTouched(b) - lastTouched(a));
		if (!tasks.length) {
			DOM.append(parent, $('.dispatch-waiting-empty', undefined, localize('dispatchTaskArchive.empty', "Nothing older than {0} days.", TASK_WINDOW_DAYS)));
			return;
		}
		const groups = new Map<string, IDispatchTask[]>();
		for (const t of tasks) {
			const key = month(lastTouched(t));
			groups.set(key, [...(groups.get(key) ?? []), t]);
		}
		for (const [name, rows] of groups) {
			const group = DOM.append(parent, $('.dispatch-waiting-group'));
			DOM.append(group, $('.dispatch-waiting-group-head', undefined, name));
			for (const t of rows) {
				this.renderRow(group, t, store);
			}
		}
		// a task id in a title reads as that task's title (the person never reads task-xxxx)
		store.add(linkifyDispatchTasksWith(this.commandService, parent));
	}

	private renderRow(parent: HTMLElement, t: IDispatchTask, store: DisposableStore): void {
		const row = DOM.append(parent, $('.dispatch-waiting-row.dispatch-task-archive-row', { role: 'button', tabindex: '0' }));
		const icon = DOM.append(row, $('span.dispatch-waiting-icon.dispatch-task-archive-icon'));
		icon.appendChild(statusMark(t.status));
		const text = DOM.append(row, $('span.dispatch-waiting-text'));
		DOM.append(text, $('span.dispatch-waiting-title', undefined, t.title));
		// what it has: the status, and the plan's size when one was written down (older tasks have neither plan nor deliverables)
		const parts = [STATUS_LABEL[t.status]];
		if (t.plan.length) {
			parts.push(localize('dispatchTaskArchive.plan', "{0} of {1} steps", t.plan.filter(p => p.state === 'done').length, t.plan.length));
		}
		if (t.deliverables.length) {
			parts.push(t.deliverables.length === 1
				? localize('dispatchTaskArchive.deliverable', "1 deliverable")
				: localize('dispatchTaskArchive.deliverables', "{0} deliverables", t.deliverables.length));
		}
		DOM.append(text, $('span.dispatch-waiting-phrase', undefined, ` · ${parts.join(' · ')}`));
		DOM.append(row, $('span.dispatch-waiting-time.dispatch-task-archive-time', undefined, day(lastTouched(t))));
		const open = () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, t.id, 'archive');
		store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, open));
		store.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open();
			}
		}));
	}

	layout(_width: number, _height: number): void { }

	override focus(): void {
		this.crumb?.querySelector<HTMLElement>('.dispatch-projects-crumb')?.focus();
	}
}
