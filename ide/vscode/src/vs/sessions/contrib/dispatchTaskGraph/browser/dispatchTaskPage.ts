/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the task page (patches/430-tasks.patch; kanban design/task-model/DECISIONS.md).
 *
 *  One task from `dispatch task show --json`: a breadcrumb back to the task graph, then its status
 *  (the status dot is the only colour), the thing it is about, who did it and when; the request as it was made; the plan;
 *  what it delivered (a click opens it: a page in the browser, a file in the side pane, a commit's
 *  changes); the session it was asked in (a click switches to it); its commits.
 *--------------------------------------------------------------------------------------------*/

import '../../dispatchTasks/browser/media/dispatchTasks.css';
import './media/dispatchTaskGraph.css';
import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DispatchWhereViewer, dispatchPictureUrl, renderDispatchWhereIcon } from '../../dispatchCommon/browser/dispatchWhere.js';
import { setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { DISPATCH_CUSTOM_VIEW_BACK_COMMAND, dispatchCustomViewOrigin } from '../../sessions/browser/dispatchCustomViewBack.js';
import { linkifyDispatchTasksWith, plainDispatchTaskRefs } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import {
	agentName, askTasks, DELIVERABLE_ICON, deliverableLabel, deliverableTooltip, deliverableWhere, wherePlaces, DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, DISPATCH_OPEN_TASK_GRAPH_COMMAND, dispatchArchiveProject,
	dispatchTaskPageBack, dispatchTaskPageTarget, IDispatchTask, openDeliverable, openTaskSession, planMark, planStepTip, renderBackCrumb, sessionForTask, shownStatus, STATUS_LABEL, statusMark, when, withoutTaskId
} from '../../dispatchTasks/browser/dispatchTasksModel.js';

const $ = DOM.$;

export const DISPATCH_TASK_PAGE_VIEW_ID = 'dispatch.taskPage';

/** The task page is up and its way back is the task graph (Esc goes there instead of to the session). */
export const DispatchTaskPageFromGraphContext = new RawContextKey<boolean>('dispatchTaskPageFromGraph', false);

const KIND_LABEL = {
	url: localize('dispatchTaskPage.kind.url', "Page"),
	file: localize('dispatchTaskPage.kind.file', "File"),
	draft: localize('dispatchTaskPage.kind.draft', "Draft"),
	commit: localize('dispatchTaskPage.kind.commit', "Commit"),
	build: localize('dispatchTaskPage.kind.build', "Build"),
};

export class DispatchTaskPageView extends AbstractCustomView {

	private readonly task = observableValue<(IDispatchTask & { error?: string }) | undefined>(this, undefined);

	readonly title: IObservable<string> = derived(this, reader => this.task.read(reader)?.title || localize('dispatchTaskPage.title', "Task"));
	override readonly description: IObservable<string | undefined> = derived(this, reader => {
		const t = this.task.read(reader);
		return t && !t.error ? t.project || undefined : undefined;
	});
	override readonly maxWidth = 880;
	private requestId = 0;
	private readonly fromGraph: IContextKey<boolean>;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IFileService private readonly fileService: IFileService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.fromGraph = DispatchTaskPageFromGraphContext.bindTo(contextKeyService);
		this._register({ dispose: () => this.fromGraph.reset() });
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-task-page');
		const store = this._register(new DisposableStore());
		this._register(autorun(reader => {
			const id = dispatchTaskPageTarget.read(reader);
			void this.load(id);
		}));
		this._register(autorun(reader => {
			this.fromGraph.set(dispatchTaskPageBack.read(reader) === 'graph');
		}));
		this._register(autorun(reader => {
			const task = this.task.read(reader);
			store.clear();
			DOM.clearNode(container);
			this.renderPage(container, task, store);
		}));
	}

	private async load(id: string | undefined): Promise<void> {
		const rid = ++this.requestId;
		if (!id) {
			this.task.set({ error: localize('dispatchTaskPage.none', "No task chosen.") } as IDispatchTask & { error: string }, undefined);
			return;
		}
		this.task.set(undefined, undefined);
		const ans = await askTasks<IDispatchTask>(this.commandService, { op: 'show', id });
		// the page's title holds no link: a task id in it reads as that task's title
		const title = ans.title ? await plainDispatchTaskRefs(this.commandService, ans.title) : ans.title;
		if (rid === this.requestId) {
			this.task.set({ ...ans, title }, undefined);
		}
	}

	private renderPage(container: HTMLElement, task: (IDispatchTask & { error?: string }) | undefined, store: DisposableStore): void {
		// back where the task was opened from, like a project's page leads back to Projects: the session
		// (a reply's link, the Tasks tab, Waiting for you), the task graph, the project's page or its Archive
		this.renderBack(container, task, store);

		if (!task) {
			DOM.append(container, $('.dispatch-graph-empty', undefined, localize('dispatchTaskPage.loading', "Loading…")));
			return;
		}
		if (task.error) {
			DOM.append(container, $('.dispatch-graph-empty', undefined, task.error));
			return;
		}
		const status = shownStatus(task, this.management);

		// status · who · when
		const meta = DOM.append(container, $('.dispatch-task-meta'));
		const st = DOM.append(meta, $('span.dispatch-task-meta-status'));
		st.appendChild(statusMark(status));
		DOM.append(st, $('span', undefined, STATUS_LABEL[status]));
		const rows: [string, string][] = [
			[localize('dispatchTaskPage.agent', "Agent"), agentName(task.agent)],
			[localize('dispatchTaskPage.asked', "Asked"), when(task.created_at)],
		];
		// the thing it is about: its row on the task graph (kanban app/cli/things.py)
		const thing = (task as IDispatchTask & { readonly thing?: string }).thing;
		if (thing) {
			rows.unshift([localize('dispatchTaskPage.thing', "Thing"), thing]);
		}
		if (task.done_at) {
			rows.push([localize('dispatchTaskPage.doneAt', "Done"), when(task.done_at)]);
		}
		for (const [key, value] of rows) {
			const row = DOM.append(meta, $('.dispatch-task-meta-row'));
			DOM.append(row, $('span.dispatch-task-meta-key', undefined, key));
			DOM.append(row, $('span', undefined, value));
		}

		if (task.description?.trim()) {
			const sec = this.section(container, localize('dispatchTaskPage.request', "Request"));
			DOM.append(sec, $('.dispatch-task-request', undefined, task.description.trim()));
		}

		const planSec = this.section(container, localize('dispatchTaskPage.plan', "Plan"));
		if (task.plan.length) {
			for (const step of task.plan) {
				// what the plan says (`dispatch done` ticks what is left); a finished task's open step reads "Not done"
				const tip = planStepTip(step.state, status === 'done');
				const line = DOM.append(planSec, $(`.dispatch-task-page-row.step.${step.state}`));
				const circle = DOM.append(line, $('span.dispatch-plan-circle', { 'aria-label': tip.head }));
				circle.appendChild(planMark(step.state));
				store.add(setupDispatchTextHover(this.hoverService, circle, () => tip, { when: () => true }));
				DOM.append(line, $('span.text', undefined, step.text));
			}
		} else {
			DOM.append(planSec, $('.dispatch-task-page-none', undefined, localize('dispatchTaskPage.noPlan', "No plan written down.")));
		}

		const delSec = this.section(container, localize('dispatchTaskPage.deliverables', "Deliverables"));
		if (task.deliverables.length) {
			for (const d of task.deliverables) {
				const where = deliverableWhere(d);
				const row = DOM.append(delSec, $('.dispatch-task-page-row.link', { role: 'button', tabindex: '0' }));
				// the whole name and where it opens: our card
				store.add(setupDispatchTextHover(this.hoverService, row, () => ({ text: deliverableTooltip(d) }), { when: () => true }));
				row.appendChild(where ? renderDispatchWhereIcon() : renderIcon(DELIVERABLE_ICON[d.kind]));
				DOM.append(row, $('span.text', undefined, deliverableLabel(d)));
				DOM.append(row, $('span.kind', undefined, where ? `${localize('dispatchTaskPage.kind.notes', "Notes")} · ${wherePlaces(where.marks.length)}` : KIND_LABEL[d.kind]));
				let viewer: DispatchWhereViewer | undefined;
				const open = () => void this.instantiationService.invokeFunction(openDeliverable, d, task.id, viewer?.selected);
				if (where) {
					// the page is wide: the whole Where to look under the row, the picture left and its lines right;
					// a line zooms there, Open in Docs reads the note on that spot
					const pictureUrl = (image: string) => dispatchPictureUrl(this.fileService, image);
					viewer = store.add(new DispatchWhereViewer(DOM.append(delSec, $('.dispatch-task-page-where')), where, undefined, { height: 280, side: 'auto', pictureUrl }));
					viewer.addHeadAction(localize('dispatchTaskPage.openInDocs', "Open in Docs"), 'arrow-right', open);
					const v = viewer;
					void pictureUrl(where.image).then(url => {
						const img = v.viewport.querySelector('img');
						if (url && img && !img.src) {
							img.src = url;
						}
					});
				}
				store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, open));
				store.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						open();
					}
				}));
			}
		} else {
			DOM.append(delSec, $('.dispatch-task-page-none', undefined, status === 'done'
				? localize('dispatchTaskPage.noDeliverables', "Nothing recorded.")
				: localize('dispatchTaskPage.notYet', "Not delivered yet.")));
		}

		if (task.session) {
			const sesSec = this.section(container, localize('dispatchTaskPage.session', "Session"));
			const session = sessionForTask(this.management, task.session, task.session_window);
			const row = DOM.append(sesSec, $('.dispatch-task-page-row.link', { role: 'button', tabindex: '0' }));
			row.appendChild(renderIcon(Codicon.commentDiscussion));
			DOM.append(row, $('span.text', undefined, session?.title.get() || localize('dispatchTaskPage.sessionElsewhere', "A session not in this window")));
			if (session) {
				DOM.append(row, $('span.kind', undefined, localize('dispatchTaskPage.open', "Open")));
			}
			const open = async () => {
				const ok = await this.instantiationService.invokeFunction(openTaskSession, task.session, task.session_window);
				if (ok) {
					this.customViewService.hideCustomView();
				}
			};
			store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => void open()));
			store.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					void open();
				}
			}));
		}

		const commits = (task.commits ?? []).filter(c => !task.deliverables.some(d => d.kind === 'commit' && c.short.startsWith(d.ref)));
		if (commits.length) {
			const sec = this.section(container, localize('dispatchTaskPage.commits', "Commits"));
			for (const c of commits) {
				const row = DOM.append(sec, $('.dispatch-task-page-row'));
				row.appendChild(renderIcon(Codicon.gitCommit));
				DOM.append(row, $('span.hash', undefined, c.short));
				DOM.append(row, $('span.text', undefined, withoutTaskId(c.subject)));
			}
		}
		// a task id in the request or a plan step becomes a link to that task, shown by its title
		store.add(linkifyDispatchTasksWith(this.commandService, container));
	}

	private renderBack(container: HTMLElement, task: IDispatchTask | undefined, store: DisposableStore): void {
		const from: string = dispatchTaskPageBack.get();
		const archive = from === 'archive' ? dispatchArchiveProject.get() : undefined;
		const session = from === 'session' ? dispatchCustomViewOrigin.get() : undefined;
		const project = from === 'project' ? task?.project : undefined;
		let label: string;
		let go: () => unknown;
		if (from === 'waiting') {
			label = localize('dispatchTaskPage.waiting', "Waiting for you");
			go = () => this.commandService.executeCommand('dispatch.waiting.show');
		} else if (archive) {
			label = localize('dispatchTaskPage.archive', "Archive");
			go = () => this.commandService.executeCommand(DISPATCH_OPEN_TASK_ARCHIVE_COMMAND, archive);
		} else if (project) {
			label = project;
			go = () => this.commandService.executeCommand('dispatch.projects.open', project);
		} else if (session) {
			label = session.title || localize('dispatchTaskPage.theSession', "Session");
			go = () => this.commandService.executeCommand(DISPATCH_CUSTOM_VIEW_BACK_COMMAND);
		} else {
			label = localize('dispatchTaskPage.graph', "Task graph");
			go = () => this.commandService.executeCommand(DISPATCH_OPEN_TASK_GRAPH_COMMAND);
		}
		renderBackCrumb(container, label, () => void go(), store);
	}

	private section(container: HTMLElement, name: string): HTMLElement {
		const sec = DOM.append(container, $('.dispatch-task-section'));
		DOM.append(sec, $('.dispatch-task-section-head', undefined, name));
		return sec;
	}

	layout(_width: number, _height: number): void { }
}
