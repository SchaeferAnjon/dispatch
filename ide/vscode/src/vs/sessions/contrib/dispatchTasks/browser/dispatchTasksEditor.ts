/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Tasks tab of the Agents window's side pane (patches/430-tasks.patch;
 *  kanban design/task-model/redesign, direction A: compact cards).
 *
 *  This session's tasks (`dispatch task list --session`), or the project's (`--folder`), through
 *  dispatch-bridge's `dispatch.tasks`. On top the scope switch (This session / the project, square
 *  like the tabs above it) and Graph. Every task not done is a compact card: its status dot (the only
 *  colour: amber waiting for you, green in progress, grey to do), the title (two lines at most; it
 *  opens the task page) and the time; under it the plan's progress (ticks, x / y), the step it is on and
 *  what it delivered as line icons (page, file, commit); a click opens the card: the plan's steps
 *  (✓ done, → on it, ○ not yet) and the deliverables by name. Done tasks fold into one group of rows
 *  (it remembers being folded), five shown. A deliverable opens in the side pane or the built-in browser.
 *  Refreshed every 10 s while shown.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTasks.css';
import { handoffMarkers } from '../../dispatchLife/browser/dispatchLife.js';
import { clearDispatchLinkedHover, hasDispatchLinkedHover, linkTaskDelivery } from '../../dispatchDocs/browser/dispatchLinkedHover.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { isActiveSessionStatus } from '../../../services/sessions/common/session.js';
import { type DispatchTaskPhase, taskPhase } from '../common/dispatchTaskPhase.js';
import { dispatchBoardLive, onDidChangeDispatchBoard } from '../../dispatchBoard/browser/dispatchBoard.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { dispatchWaitingVisible, waitingDetail } from '../../sessions/browser/dispatchWaitingModel.js';
import { askDispatchTaskBrief, linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { dispatchTaskBriefs } from '../../../../workbench/contrib/chat/common/dispatchTaskBriefs.js';
import {
	activeProjectLabel, activeSessionFolder, ago, askTasks, isChatSession, DELIVERABLE_ICON, deliverableLabel, deliverableTooltip, deliverableWhere, DISPATCH_OPEN_TASK_COMMAND, DISPATCH_OPEN_TASK_GRAPH_COMMAND,
	DispatchTaskStatus, dispatchTaskReveal, IDispatchDeliverable, IDispatchTask, IDispatchTaskList, openDeliverable, planMark, planProgress, planStepTip, sessionForTask, setDispatchTaskDone, setupDeliverableWhereHover, shownStatus, STATUS_LABEL, statusMark, waitingItemOfTask, wherePlaces
} from './dispatchTasksModel.js';
import { renderDispatchWhereIcon } from '../../dispatchCommon/browser/dispatchWhere.js';
import { isDispatchWindowIdle, onDidChangeDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { DispatchNextUpView } from '../../dispatchCapture/browser/dispatchNextUp.js';

type Scope = 'session' | 'project';
const POLL_MS = 10_000;
const DONE_SHOWN = 5;
const DONE_FOLDED_KEY = 'dispatch.tasks.doneFolded';
/** The last lists the tab showed, so a reopened window shows them at once while it asks again (task-nu516). */
const LAST_LISTS_KEY = 'dispatch.tasks.lastLists';
const LAST_LISTS_MAX = 8;
/** A deliverable this new (seconds) flashes its icon once when the tab first shows it (the moment it is delivered). */
const FRESH_S = 90;
/** A task opened in place flashes this long (the Docs tab's flash). */
const FLASH_MS = 2100;
/** An ask to open a task older than this (ms) is from before the tab was there: not shown again. */
const REVEAL_FRESH_MS = 10_000;

/**
 * A task opened in place that the list does not show as a card (another session's or project's, or done): on its own
 * above the list (task-86t0e). `task` is what the window knows (at once), then the board's answer.
 */
interface ILinkedTask {
	readonly id: string;
	readonly title: string;
	task?: IDispatchTask;
	error?: string;
}

export class DispatchTasksEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.dispatch.tasks';
	static readonly EDITOR_ID = 'workbench.editor.dispatch.tasks';

	override get typeId(): string {
		return DispatchTasksEditorInput.ID;
	}

	override get editorId(): string {
		return DispatchTasksEditorInput.EDITOR_ID;
	}

	override get resource(): undefined {
		return undefined;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ExcludeFromEditorLimit;
	}

	override getName(): string {
		return localize('dispatchTasks.name', "Tasks");
	}

	override getIcon(): ThemeIcon {
		return Codicon.checklist;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof DispatchTasksEditorInput;
	}
}

export class DispatchTasksEditorSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(DispatchTasksEditorInput);
	}
}

interface ITasksState {
	readonly key?: string;
	readonly project?: string;
	readonly tasks?: readonly IDispatchTask[];
	readonly error?: string;
	readonly loading: boolean;
}

const PHASE_WRAPUP_LABEL = localize('dispatchTasks.wrapup', "Steps done, wrapping up");
const PHASE_IDLE_LABEL = localize('dispatchTasks.idle', "In progress, its session is not working now");
const STATUS_ORDER: Record<DispatchTaskStatus, number> = { waiting: 0, in_progress: 1, todo: 2, done: 3 };

export class DispatchTasksEditor extends EditorPane {

	static readonly ID = DispatchTasksEditorInput.EDITOR_ID;

	private _root!: HTMLElement;
	private _scope: Scope = 'session';
	private _state: ITasksState = { loading: true };
	private _showAllDone = false;
	/** Cards the person opened (by task id): they stay open across refreshes. */
	private readonly _open = new Set<string>();
	/** The project's name once an answer told it (the graph page's scope says the same). */
	private _projectName = '';
	private readonly _cache = new Map<string, ITasksState>();
	private _lastStored: string;
	private readonly _renderStore = this._register(new DisposableStore());
	private _requestId = 0;
	private _lastKey = '';
	/** Deliverables already flashed (task, ref, time): a refresh does not flash them again. */
	private readonly _flashed = new Set<string>();
	/** Next up and Later: the things noted from chats that wait in line (patches/dispatch-nextup.patch). */
	private _nextUp!: DispatchNextUpView;
	/** The task opened in place (`dispatch.showTask`), until it is closed or another session becomes active. */
	private _linked: ILinkedTask | undefined;
	private _lastReveal = 0;
	private _flash: { id: string; until: number } | undefined;
	private _linkedSession: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storage: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsManagementService private readonly _management: ISessionsManagementService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super(DispatchTasksEditor.ID, group, telemetryService, themeService, _storage);
		this._lastStored = this._storage.get(LAST_LISTS_KEY, StorageScope.PROFILE, '[]');
		try {
			for (const [key, state] of JSON.parse(this._lastStored) as [string, ITasksState][]) {
				this._cache.set(key, { ...state, loading: false });
			}
		} catch {
			// not a list this tab wrote: start empty
		}
	}

	/** Keeps an answer for the next time the same list is asked for, here and after the window reopens. */
	private remember(key: string, state: ITasksState): void {
		this._cache.delete(key);
		this._cache.set(key, state);
		const recent = [...this._cache].slice(-LAST_LISTS_MAX).map(([k, s]) => [k, { key: s.key, project: s.project, tasks: s.tasks }]);
		const value = JSON.stringify(recent);
		if (value !== this._lastStored) {
			this._lastStored = value;
			this._storage.store(LAST_LISTS_KEY, value, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, dom.$('.dispatch-tasks.dispatch-tasks-a'));
		this._root.tabIndex = -1;
		this._nextUp = this._register(this._instantiationService.createInstance(DispatchNextUpView));
		this._register(this._nextUp.onDidChange(() => this.isVisible() && this.render()));
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			session?.workspace.read(reader);
			// a task opened in place belongs to the session it was opened in
			if (this._linked && session?.resource.toString() !== this._linkedSession) {
				this._linked = undefined;
			}
			if (this.isVisible()) {
				void this.refresh();
			}
		}));
		// `dispatch.showTask`: a task link in a reply, the Now tab's task title, the Docs reader (task-86t0e)
		this._register(autorun(reader => {
			const ask = dispatchTaskReveal.read(reader);
			if (ask && ask.at > this._lastReveal && Date.now() - ask.at < REVEAL_FRESH_MS) {
				this._lastReveal = ask.at;
				this.reveal(ask.id, ask.title);
			}
		}));
		// a session that stops for you turns its task amber at once
		this._register(autorun(reader => {
			dispatchWaitingVisible.read(reader);
			if (this.isVisible()) {
				this.render();
			}
		}));
		// the board pushes its changes (dispatchBoard.ts); the timer only while it does not
		this._register(onDidChangeDispatchBoard(() => {
			if (this.isVisible() && !isDispatchWindowIdle()) {
				void this.refresh();
			}
		}));
		this._register(onDidChangeDispatchWindowIdle(idle => {
			if (!idle && this.isVisible()) {
				void this.refresh();
			}
		}));
		const timer = mainWindow.setInterval(() => {
			if (!dispatchBoardLive() && this.isVisible() && mainWindow.document.visibilityState === 'visible' && !isDispatchWindowIdle()) {
				void this.refresh();
			}
		}, POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
		this.render();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		void this.refresh();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) { clearDispatchLinkedHover(this._root); }
		if (visible) {
			void this.refresh();
		}
	}

	override focus(): void {
		this._root?.focus();
	}

	override layout(_dimension: dom.Dimension): void { }

	private request(): { key: string; req: Record<string, unknown> } | undefined {
		const session = this._sessionsService.activeSession.get();
		const folder = activeSessionFolder(this._sessionsService);
		if (this.shownScope() === 'session') {
			if (!session) {
				return undefined;
			}
			const resource = session.resource.toString();
			return { key: `s|${resource}`, req: { op: 'list', session: resource } };
		}
		return folder ? { key: `p|${folder}`, req: { op: 'list', folder } } : undefined;
	}

	/** Shows the cached list at once, then asks the bridge for a fresh one. */
	async refresh(): Promise<void> {
		// the same round as the task list: a thing just noted must not show as a card until the line is read again
		this._nextUp?.fresh();
		const r = this.request();
		const id = ++this._requestId;
		if (!r) {
			clearDispatchLinkedHover(this._root);
			this._state = { loading: false };
			this.render();
			return;
		}
		const cached = this._cache.get(r.key);
		if (this._state.key !== r.key) {
			clearDispatchLinkedHover(this._root);
			this._state = cached ? { ...cached, loading: true } : { key: r.key, loading: true };
			this.render();
		}
		const ans = await askTasks<IDispatchTaskList>(this._commandService, r.req);
		if (id !== this._requestId) {
			return;
		}
		const next: ITasksState = ans.error ? { key: r.key, error: ans.error, loading: false } : { key: r.key, project: ans.project, tasks: ans.tasks ?? [], loading: false };
		if (!next.error) {
			this.remember(r.key, next);
			dispatchTaskBriefs.remember(next.tasks ?? []);
			this._projectName = next.project || next.tasks?.find(t => t.project)?.project || this._projectName;
		}
		this._state = next.error && cached ? { ...cached, loading: false } : next;
		this.render();
	}

	private get doneFolded(): boolean {
		return this._storage.getBoolean(DONE_FOLDED_KEY, StorageScope.PROFILE, false);
	}

	private set doneFolded(value: boolean) {
		this._storage.store(DONE_FOLDED_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	/** The scope the tab shows: This session in a session without a project folder (Chats), else the one picked. */
	private shownScope(): Scope {
		return isChatSession(this._sessionsService.activeSession.get()) ? 'session' : this._scope;
	}

	/** The project by the sidebar's name for it, so the switch reads the same before any task has answered. */
	private projectLabel(): string {
		return activeProjectLabel(this._sessionsService) || this._state.project || this._projectName || localize('dispatchTasks.project', "Project");
	}

	private render(force = false): void {
		if (!this._root) {
			return;
		}
		// Keep the source stable through the 10 s poll and the minute label change. The next poll
		// paints the fresh state after leaving; explicit scope changes still render immediately.
		if (!force && hasDispatchLinkedHover(this._root)) { return; }
		const state = this._state;
		const minute = Math.floor(Date.now() / 60000);
		const waiting = (dispatchWaitingVisible.get()?.items ?? []).filter(i => i.kind !== 'only_you').map(i => [i.id, i.kind, i.phrase]);
		const phases = (state.tasks ?? []).map(t => this.phaseOf(t, shownStatus(t, this._management)));
		const linked = this._linked;
		const key = JSON.stringify([this._scope, state, this._showAllDone, [...this._open], this.doneFolded, this.projectLabel(), waiting, minute, this._nextUp?.signature(), phases,
			linked ? [linked.id, linked.title, linked.task, linked.error] : null]);
		if (!force && key === this._lastKey) {
			return;
		}
		// Keep the snippet and its attached picture stable while the person reads or clicks it.
		// The next poll redraws after the hover closes, including minute-only age changes.
		if (!force && dom.getWindow(this._root).document.querySelector('.dispatch-where-snippet')) { return; }
		this._lastKey = key;
		this._renderStore.clear();
		dom.clearNode(this._root);
		// a session that starts or stops working changes its task's mark (breathing or not) at once
		let first = true;
		this._renderStore.add(autorun(reader => {
			for (const t of state.tasks ?? []) {
				sessionForTask(this._management, t.session, t.session_window)?.status.read(reader);
			}
			if (first) {
				first = false;
			} else {
				mainWindow.setTimeout(() => this.isVisible() && this.render(), 0);
			}
		}));

		this.renderScope(this._root);
		const list = dom.append(this._root, dom.$('.dispatch-tasks-list'));
		// a task opened in place that the list does not show as a card: on its own on top, opened
		const lined = state.tasks ? this._nextUp.lined(state.tasks.map(t => t.id)) : new Set<string>();
		const asCard = new Set((state.tasks ?? []).filter(t => shownStatus(t, this._management) !== 'done' && !lined.has(t.id)).map(t => t.id));
		const linkedShown = linked && !asCard.has(linked.id) ? linked : undefined;
		if (linkedShown) {
			this.renderLinked(list, linkedShown);
		}
		if (!state.key && !state.loading) {
			dom.append(list, dom.$('.dispatch-tasks-line', undefined, localize('dispatchTasks.noSession', "Open a session to see its tasks.")));
			return;
		}
		if (!state.tasks) {
			if (state.error) {
				dom.append(list, dom.$('.dispatch-tasks-line', undefined, localize('dispatchTasks.error', "Could not list the tasks: {0}", state.error)));
			} else {
				this.renderSkeleton(list);
			}
			return;
		}
		if (!state.tasks.length) {
			const empty = dom.append(list, dom.$('.dispatch-tasks-line.dispatch-tasks-empty-lines'));
			// two lines, no icon (DESIGN.md: a side pane tab's empty state): what is missing, then where tasks come from
			dom.append(empty, dom.$('.dispatch-tasks-empty-line', undefined, this.shownScope() === 'session'
				? localize('dispatchTasks.noneSessionLine', "No tasks in this session yet.")
				: localize('dispatchTasks.noneProject', "No tasks in {0} yet.", this.projectLabel())));
			dom.append(empty, dom.$('.dispatch-tasks-empty-hint', undefined, localize('dispatchTasks.noneHint', "Ask for something and the agent plans it here.")));
			return;
		}
		const withStatus = state.tasks.map(t => ({ task: t, status: shownStatus(t, this._management) }));
		// the things waiting in line are drawn as Next up and Later under the cards
		const open = withStatus.filter(x => x.status !== 'done' && !lined.has(x.task.id)).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
		// the task opened in place is on top already
		const done = withStatus.filter(x => x.status === 'done' && x.task.id !== linkedShown?.id).map(x => x.task);
		if (!open.length && lined.size) {
			// nothing works yet: Next up says what is coming
		} else if (!open.length) {
			dom.append(list, dom.$('.dispatch-tasks-line', undefined, this.shownScope() === 'session'
				? localize('dispatchTasks.nothingSession', "Nothing in progress in this session.")
				: localize('dispatchTasks.nothingProject', "Nothing in progress in {0}.", this.projectLabel())));
		} else if (open.length) {
			const cards = dom.append(list, dom.$('.dispatch-task-cards'));
			for (const { task, status } of open) {
				this.renderCard(cards, task, status);
			}
		}
		this._nextUp.renderTasks(list, this._renderStore, state.tasks.map(t => t.id));
		if (done.length) {
			this.renderDone(list, done);
		}
		// a task id in a title or a plan step reads as that task's title (the person never reads task-xxxx)
		this._renderStore.add(linkifyDispatchTasksWith(this._commandService, list));
	}

	private renderScope(root: HTMLElement): void {
		const bar = dom.append(root, dom.$('.dispatch-tasks-bar'));
		const seg = dom.append(bar, dom.$('.dispatch-tasks-scope', { role: 'tablist' }));
		// a session without a project folder (Chats) has no project around it (task-p0za2)
		const chat = isChatSession(this._sessionsService.activeSession.get());
		const scopes: [Scope, string][] = [
			['session', localize('dispatchTasks.thisSession', "This session")],
		];
		if (!chat) {
			scopes.push(['project', this.projectLabel()]);
		}
		const shown = this.shownScope();
		for (const [scope, label] of scopes) {
			const tab = dom.append(seg, dom.$<HTMLButtonElement>('button.dispatch-tasks-pill', { type: 'button', role: 'tab' }));
			tab.classList.toggle('on', shown === scope);
			tab.setAttribute('aria-selected', String(shown === scope));
			tab.textContent = label;
			this._renderStore.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
				if (this._scope !== scope) {
					this._scope = scope;
					this._showAllDone = false;
					void this.refresh();
				}
			}));
		}
		const graph = dom.append(bar, dom.$<HTMLButtonElement>('button.dispatch-tasks-graph', { type: 'button', title: localize('dispatchTasks.graphTitle', "Show the task graph") }));
		graph.appendChild(renderIcon(Codicon.gitMerge));
		dom.append(graph, dom.$('span', undefined, localize('dispatchTasks.graph', "Graph")));
		this._renderStore.add(dom.addDisposableListener(graph, dom.EventType.CLICK, () => {
			void this._commandService.executeCommand(DISPATCH_OPEN_TASK_GRAPH_COMMAND, shown);
		}));
	}

	/** While the first list is on its way: three card-shaped grey placeholders with the shimmer. */
	private renderSkeleton(list: HTMLElement): void {
		const sk = dom.append(list, dom.$('.dispatch-task-cards.dispatch-tasks-skeleton'));
		sk.setAttribute('aria-busy', 'true');
		sk.setAttribute('aria-label', localize('dispatchTasks.loading', "Loading tasks…"));
		for (const w of [72, 58, 80]) {
			const card = dom.append(sk, dom.$('.dispatch-task-card'));
			const bar = dom.append(card, dom.$('.dispatch-tasks-skeleton-bar'));
			bar.style.width = `${w}%`;
			dom.append(card, dom.$('.dispatch-tasks-skeleton-bar.short'));
		}
	}

	/**
	 * What an In progress task is doing: the board keeps it In progress until the agent closes it, so a task whose
	 * steps are all ticked says "wrapping up" and one whose session is not working says so, instead of pinging.
	 */
	private phaseOf(task: IDispatchTask, status: DispatchTaskStatus): DispatchTaskPhase | undefined {
		if (status !== 'in_progress') {
			return undefined;
		}
		const session = sessionForTask(this._management, task.session, task.session_window);
		return taskPhase(task.plan, session ? isActiveSessionStatus(session.status.get()) : undefined);
	}

	private dot(parent: HTMLElement, status: DispatchTaskStatus, phase?: DispatchTaskPhase): HTMLElement {
		const dot = dom.append(parent, statusMark(status, phase === 'running'));
		const label = phase === 'wrapup' ? PHASE_WRAPUP_LABEL : phase === 'idle' ? PHASE_IDLE_LABEL : STATUS_LABEL[status];
		dot.removeAttribute('aria-hidden');
		dot.setAttribute('role', 'img');
		dot.setAttribute('aria-label', label);
		// the colour says it (the line beside it no longer does): its name on our card, for whoever does not know it yet
		this._renderStore.add(setupDispatchTextHover(this._hoverService, dot, () => ({ text: label }), { when: () => true }));
		return dot;
	}

	/** ✓ on an open card closes the task, ↺ on a done row opens it again; both show on hover, ✓ always on Waiting for you. */
	private doneToggle(parent: HTMLElement, task: IDispatchTask, close: boolean): void {
		const label = close ? localize('dispatchTasks.markDone', "Mark done") : localize('dispatchTasks.reopen', "Open again");
		const button = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-task-check', { type: 'button', 'aria-label': label }));
		button.appendChild(renderIcon(close ? Codicon.check : Codicon.discard));
		this._renderStore.add(setupDispatchTextHover(this._hoverService, button, () => ({ text: label }), { when: () => true }));
		this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, async e => {
			e.stopPropagation();
			button.disabled = true;
			if (await setDispatchTaskDone(this._commandService, task.id, close)) {
				void this.refresh();
			} else {
				button.disabled = false;
			}
		}));
	}

	private openTask(task: IDispatchTask): void {
		void this._commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, task.id);
	}

	/**
	 * Opens a task in place (`dispatch.showTask`): its card in the list, opened and flashing; a task the list does not
	 * show as a card (another session's or project's, or done) on its own above the list. What the window knows shows
	 * at once (the list, the reply's question for it); the board is asked again behind it (task-86t0e).
	 */
	private reveal(id: string, title: string): void {
		this._open.add(id);
		this._flash = { id, until: Date.now() + FLASH_MS };
		this._linkedSession = this._sessionsService.activeSession.get()?.resource.toString();
		const listed = this._state.tasks?.find(t => t.id === id);
		const known = listed ?? dispatchTaskBriefs.peek(id) as IDispatchTask | undefined;
		this._linked = { id, title: known?.title || title, task: known };
		this.render(true);
		this.scrollToTask(id);
		if (listed) {
			return;
		}
		void dispatchTaskBriefs.get(id, i => askDispatchTaskBrief(this._commandService, i), { fresh: true, urgent: true }).then(ans => {
			const linked = this._linked;
			if (linked?.id !== id) {
				return;
			}
			if (ans && !ans.error) {
				this._linked = { id, title: ans.title || linked.title, task: ans as IDispatchTask };
			} else if (!linked.task) {
				this._linked = { id, title: linked.title, error: ans?.error || localize('dispatchTasks.noBridge', "Dispatch is not answering.") };
			}
			this.render();
		});
	}

	private scrollToTask(id: string): void {
		const el = this._root?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	}

	/**
	 * The task opened in place that the list does not show as a card: a head saying where it is from (its project, or
	 * another session) with a close button, then its card opened, the same card as the list's. Before the window knows
	 * anything but its title: the title and placeholder bars, never a whole Loading.
	 */
	private renderLinked(list: HTMLElement, linked: ILinkedTask): void {
		const block = dom.append(list, dom.$('section.dispatch-task-linked'));
		const head = dom.append(block, dom.$('.dispatch-task-linked-head'));
		const task = linked.task;
		const here = this._sessionsService.activeSession.get();
		const project = task?.project || '';
		const sameProject = !project || project.toLowerCase() === (this._state.project || this._projectName || '').toLowerCase()
			|| project.toLowerCase() === (activeProjectLabel(this._sessionsService) || '').toLowerCase();
		const sameSession = !!task && !!here && sessionForTask(this._management, task.session, task.session_window)?.resource.toString() === here.resource.toString();
		// before the board answers nothing is said about where it is from (DESIGN.md names three wordings only)
		const where = !task ? ''
			: !sameProject ? localize('dispatchTasks.linkedProject', "In {0}", project)
				: sameSession ? localize('dispatchTasks.linkedThisSession', "In this session")
					: localize('dispatchTasks.linkedOtherSession', "In another session");
		dom.append(head, dom.$('span.dispatch-task-linked-where', undefined, where));
		const close = dom.append(head, dom.$<HTMLButtonElement>('button.dispatch-task-linked-close', { type: 'button', 'aria-label': localize('dispatchTasks.linkedClose', "Close") }));
		close.appendChild(renderIcon(Codicon.close));
		this._renderStore.add(setupDispatchTextHover(this._hoverService, close, () => ({ text: localize('dispatchTasks.linkedClose', "Close") }), { when: () => true }));
		this._renderStore.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => {
			this._linked = undefined;
			this.render(true);
		}));
		const cards = dom.append(block, dom.$('.dispatch-task-cards'));
		if (task) {
			this.renderCard(cards, task, shownStatus(task, this._management));
			return;
		}
		// the title the link showed; the rest when the board answers (or what it said instead)
		const card = dom.append(cards, dom.$('article.dispatch-task-card.dispatch-task-card-pending'));
		card.dataset.taskId = linked.id;
		card.setAttribute('aria-busy', linked.error ? 'false' : 'true');
		const top = dom.append(card, dom.$('.dispatch-task-head'));
		dom.append(top, dom.$('span.dispatch-task-mark-slot'));
		const title = dom.append(top, dom.$<HTMLButtonElement>('button.dispatch-task-title', { type: 'button' }));
		title.textContent = linked.title || localize('dispatchTasks.linkedTask', "Task");
		this._renderStore.add(dom.addDisposableListener(title, dom.EventType.CLICK, () => {
			void this._commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, linked.id);
		}));
		if (linked.error) {
			dom.append(card, dom.$('.dispatch-task-sub', undefined, localize('dispatchTasks.linkedMissing', "Could not read this task: {0}", linked.error)));
			return;
		}
		const bar = dom.append(card, dom.$('.dispatch-tasks-skeleton-bar.short'));
		bar.setAttribute('aria-hidden', 'true');
		dom.append(card, dom.$('.dispatch-tasks-skeleton-bar.short.second')).setAttribute('aria-hidden', 'true');
	}

	/** The time a card shows: the last activity while it runs or waits, when it was done once it is. */
	private when(task: IDispatchTask, status: DispatchTaskStatus): string {
		return ago(status === 'done' ? task.done_at : Math.max(task.updated_at, task.created_at));
	}

	private renderCard(cards: HTMLElement, task: IDispatchTask, status: DispatchTaskStatus): void {
		const phase = this.phaseOf(task, status);
		const card = dom.append(cards, dom.$(`article.dispatch-task-card.${status}`));
		card.classList.toggle('wrapup', phase === 'wrapup');
		// dispatch.showTask finds this card by it, and the tests
		card.dataset.taskId = task.id;
		const flash = this._flash?.id === task.id ? this._flash.until - Date.now() : 0;
		if (flash > 0) {
			// opened in place a moment ago: the flash goes on where it was through a redraw
			card.classList.add('dispatch-docs-flash-card');
			card.style.animationDelay = `-${FLASH_MS - flash}ms`;
		}
		const linked = this.linkTask(card, task);
		const hasDetail = task.plan.length > 0 || task.deliverables.length > 0;
		card.classList.toggle('open', this._open.has(task.id));
		card.classList.toggle('has-detail', hasDetail);
		let caret: HTMLElement | undefined;
		const toggle = () => {
			if (!hasDetail) {
				this.openTask(task);
				return;
			}
			if (this._open.has(task.id)) {
				this._open.delete(task.id);
			} else {
				this._open.add(task.id);
			}
			card.classList.toggle('open', this._open.has(task.id));
			caret?.setAttribute('aria-expanded', String(this._open.has(task.id)));
			this._lastKey = '';
		};

		// the head: dot, title (two lines at most; it opens the task page), time
		const head = dom.append(card, dom.$('.dispatch-task-head'));
		this.dot(head, status, phase);
		const title = dom.append(head, dom.$<HTMLButtonElement>('button.dispatch-task-title', { type: 'button' }));
		title.textContent = task.title;
		// two lines at most: the whole title on our card when they cut it off
		if (!linked) { this._renderStore.add(setupDispatchTextHover(this._hoverService, title, () => ({ text: task.title }))); }
		this._renderStore.add(dom.addDisposableListener(title, dom.EventType.CLICK, e => {
			e.stopPropagation();
			this.openTask(task);
		}));
		dom.append(head, dom.$('span.dispatch-task-time', undefined, this.when(task, status)));
		// a done task opened in place has its card too: there the button opens it again
		this.doneToggle(head, task, status !== 'done');

		// the second line: progress, the step it is on, the deliverables; or what it waits on / To do
		const meta = dom.append(card, dom.$('.dispatch-task-sub'));
		if (status === 'waiting' || !task.plan.length) {
			const line = status === 'in_progress' ? '' : this.stateLine(task, status);
			if (line) {
				dom.append(meta, dom.$('span.dispatch-task-state', undefined, line));
			} else {
				// the icons and the caret stay at the right
				dom.append(meta, dom.$('span.dispatch-task-state'));
			}
		} else {
			const doneSteps = task.plan.filter(p => p.state === 'done').length;
			const prog = dom.append(meta, dom.$('span.dispatch-task-progress'));
			const ticks = dom.append(prog, dom.$('span.dispatch-task-ticks'));
			ticks.setAttribute('aria-hidden', 'true');
			for (const step of task.plan) {
				dom.append(ticks, dom.$(step.state === 'done' ? 'i.d' : 'i'));
			}
			dom.append(prog, dom.$('span', undefined, `${doneSteps} / ${task.plan.length}`));
			this._renderStore.add(setupDispatchTextHover(this._hoverService, prog, () => ({ text: planProgress(task.plan) }), { when: () => true }));
			const current = task.plan.find(p => p.state === 'active') ?? task.plan.find(p => p.state === 'todo');
			const step = dom.append(meta, dom.$('span.dispatch-task-step-now'));
			if (phase === 'wrapup') {
				// every step ticked, the agent has not closed the task: not "→ the next step"
				dom.append(step, dom.$('span', undefined, localize('dispatchTasks.wrapupShort', "Wrapping up")));
			} else if (current) {
				step.appendChild(renderIcon(Codicon.arrowRight));
				dom.append(step, dom.$('span', undefined, current.text));
			}
		}
		if (task.deliverables.length) {
			const icons = dom.append(meta, dom.$('span.dispatch-task-deliverable-icons'));
			for (const d of task.deliverables) {
				this.renderDeliverableIcon(icons, d, task.id);
			}
		}
		const stepEls: HTMLElement[] = [];
		if (hasDetail) {
			caret = dom.append(meta, dom.$<HTMLButtonElement>('button.dispatch-task-caret', { type: 'button' }));
			caret.appendChild(renderIcon(Codicon.chevronDown));
			caret.setAttribute('aria-expanded', String(this._open.has(task.id)));
			caret.setAttribute('aria-label', localize('dispatchTasks.details', "Plan and deliverables"));
			this._renderStore.add(dom.addDisposableListener(caret, dom.EventType.CLICK, e => {
				e.stopPropagation();
				toggle();
			}));

			// opened: the plan's steps and the deliverables by name
			const detail = dom.append(card, dom.$('.dispatch-task-detail'));
			const inner = dom.append(detail, dom.$('div'));
			if (task.plan.length) {
				const steps = dom.append(inner, dom.$('ul.dispatch-task-plan'));
				for (const step of task.plan) {
					const li = dom.append(steps, dom.$(`li.${step.state}`));
					stepEls.push(li);
					const tip = planStepTip(step.state, status === 'done');
					const circle = dom.append(li, dom.$('span.dispatch-plan-circle', { 'aria-label': tip.head }));
					circle.appendChild(planMark(step.state, phase === 'running'));
					this._renderStore.add(setupDispatchTextHover(this._hoverService, circle, () => tip, { when: () => true }));
					dom.append(li, dom.$('span', undefined, step.text));
				}
			}
			if (task.deliverables.length) {
				const list = dom.append(inner, dom.$('ul.dispatch-task-deliverables'));
				for (const d of task.deliverables) {
					this.renderDeliverableRow(list, d, task.id);
				}
			}
		}
		handoffMarkers(card, task.handoffs, this._commandService, this._renderStore, stepEls, task.plan);
		// a click on the card's head or second line (not on its title or a deliverable) opens or closes it
		this._renderStore.add(dom.addDisposableListener(card, dom.EventType.CLICK, e => {
			if (!(e.target as HTMLElement).closest('.dispatch-task-detail')) {
				toggle();
			}
		}));
		card.tabIndex = 0;
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', `${task.title}, ${STATUS_LABEL[status]}`);
		this._renderStore.add(dom.addDisposableListener(card, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
				toggle();
			}
		}));
	}

	/** "only you can do this", "Write ~/.config/…", the directions to pick; "To do". The amber dot says Waiting for you. */
	private stateLine(task: IDispatchTask, status: DispatchTaskStatus): string {
		if (status !== 'waiting') {
			return STATUS_LABEL[status];
		}
		// the amber dot in front already says Waiting for you: the line says only on what
		if (task.only_you) {
			return localize('dispatchTasks.onlyYou', "only you can do this");
		}
		const waiting = waitingItemOfTask(this._management, task);
		return waiting ? waitingDetail(waiting) : '';
	}

	private renderDone(list: HTMLElement, done: readonly IDispatchTask[]): void {
		const folded = this.doneFolded;
		const group = dom.append(list, dom.$('.dispatch-task-group'));
		const head = dom.append(group, dom.$<HTMLButtonElement>('button.dispatch-task-group-head', { type: 'button' }));
		head.setAttribute('aria-expanded', String(!folded));
		head.appendChild(renderIcon(folded ? Codicon.chevronRight : Codicon.chevronDown));
		dom.append(head, dom.$('span', undefined, localize('dispatchTasks.doneHead', "Done")));
		dom.append(head, dom.$('span.dispatch-task-group-count', undefined, String(done.length)));
		this._renderStore.add(dom.addDisposableListener(head, dom.EventType.CLICK, () => {
			this.doneFolded = !folded;
			this.render(true);
		}));
		if (folded) {
			return;
		}
		const shown = this._showAllDone ? done : done.slice(0, DONE_SHOWN);
		for (const task of shown) {
			const row = dom.append(group, dom.$('.dispatch-task-row', { role: 'button', tabindex: '0' }));
			row.dataset.taskId = task.id;
			const linked = this.linkTask(row, task);
			this.dot(row, 'done');
			const rowTitle = dom.append(row, dom.$('span.dispatch-task-row-title', undefined, task.title));
			if (!linked) { this._renderStore.add(setupDispatchTextHover(this._hoverService, row, () => ({ text: task.title }), { when: [rowTitle] })); }
			if (task.deliverables.length) {
				const icons = dom.append(row, dom.$('span.dispatch-task-deliverable-icons'));
				for (const d of task.deliverables) {
					this.renderDeliverableIcon(icons, d, task.id);
				}
			}
			dom.append(row, dom.$('span.dispatch-task-time', undefined, this.when(task, 'done')));
			this.doneToggle(row, task, false);
			this._renderStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.openTask(task)));
			this._renderStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.openTask(task);
				}
			}));
		}
		if (shown.length < done.length) {
			const more = dom.append(group, dom.$<HTMLButtonElement>('button.dispatch-tasks-more', { type: 'button' }));
			more.appendChild(renderIcon(Codicon.chevronRight));
			dom.append(more, dom.$('span', undefined, localize('dispatchTasks.showMore', "Show {0} more", done.length - shown.length)));
			this._renderStore.add(dom.addDisposableListener(more, dom.EventType.CLICK, () => {
				this._showAllDone = true;
				this.render(true);
			}));
		}
	}

	private open(d: IDispatchDeliverable, taskId: string): void {
		void this._instantiationService.invokeFunction(openDeliverable, d, taskId);
	}

	/**
	 * A deliverable as a line icon (page, file, commit) on a card's second line or a done row. One with a
	 * Where to look picture is 「带框的图」: hovering it shows the snippet, a click opens it in Docs on spot 1;
	 * it flashes once when it has just been delivered.
	 */
	private renderDeliverableIcon(parent: HTMLElement, d: IDispatchDeliverable, taskId: string): void {
		const where = deliverableWhere(d);
		const b = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-task-deliverable-icon', { type: 'button' }));
		b.setAttribute('aria-label', where ? `${deliverableTooltip(d)} · ${wherePlaces(where.marks.length)}` : deliverableTooltip(d));
		const linked = this.linkDeliverable(b, d, taskId);
		if (where) {
			b.classList.add('where');
			b.appendChild(renderDispatchWhereIcon());
			if (!linked) { this._instantiationService.invokeFunction(setupDeliverableWhereHover, b, d, where, taskId, this._renderStore); }
			const key = `${taskId} ${d.ref} ${d.at ?? 0}`;
			if (!this._flashed.has(key)) {
				this._flashed.add(key);
				if (d.at && Date.now() / 1000 - d.at < FRESH_S) {
					b.classList.add('flash');
					const t = mainWindow.setTimeout(() => b.classList.remove('flash'), 2000);
					this._renderStore.add(toDisposable(() => mainWindow.clearTimeout(t)));
				}
			}
		} else {
			// an icon only: what it is and where it opens, on our card
			if (!linked) { this._renderStore.add(setupDispatchTextHover(this._hoverService, b, () => ({ text: deliverableTooltip(d) }), { when: () => true })); }
			b.appendChild(renderIcon(DELIVERABLE_ICON[d.kind]));
		}
		this._renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			this.open(d, taskId);
		}));
	}

	/**
	 * DESIGN.md 「联动悬停」: a deliverable is in two places of an open card (its icon on the second line, its
	 * row in the list); pointing at one lights the other.
	 */
	private linkTask(el: HTMLElement, task: IDispatchTask, ref?: string, options: { quiet?: boolean; fallback?: string } = {}): boolean {
		const workspace = this._sessionsService.activeSession.get()?.workspace.get()?.folders[0];
		const root = workspace?.root ?? workspace?.workingDirectory;
		const folder = root?.scheme === 'file' ? root.fsPath : '';
		const paths = ref ? [ref] : task.deliverables.filter(d => d.kind === 'file' || d.kind === 'draft').map(d => d.ref);
		// These are the document formats registered by `task deliver` / the Docs catalogue.
		// Other files retain their existing file / Where to look hover.
		if (!folder || !paths.some(p => (p.startsWith('/') || p.startsWith('file:')) && /\.(md|html?)$/i.test(p))) { return false; }
		this._renderStore.add(linkTaskDelivery(this._root, el, this._commandService, this._fileService, folder, task, deliverableLabel, ref, options));
		return true;
	}

	private linkDeliverable(el: HTMLElement, d: IDispatchDeliverable, taskId: string): boolean {
		el.dataset.deliverable = `${d.kind} ${d.ref}`;
		const task = this._state.tasks?.find(t => t.id === taskId);
		// a delivery with a Where to look picture keeps its snippet card and zoom; the link only lights the Docs row / tab
		const where = !!deliverableWhere(d);
		if (task && (d.kind === 'file' || d.kind === 'draft') && this.linkTask(el, task, d.ref, where ? { quiet: true } : { fallback: deliverableTooltip(d) })) { return !where; }
		const light = (on: boolean) => {
			const card = el.closest('.dispatch-task-card, .dispatch-task-row');
			card?.querySelectorAll<HTMLElement>('[data-deliverable]').forEach(o => {
				if (o !== el && o.dataset.deliverable === el.dataset.deliverable) {
					o.classList.toggle('linked', on);
				}
			});
		};
		this._renderStore.add(dom.addDisposableListener(el, dom.EventType.MOUSE_ENTER, () => light(true)));
		this._renderStore.add(dom.addDisposableListener(el, dom.EventType.MOUSE_LEAVE, () => light(false)));
		return false;
	}

	/** A deliverable by name in an opened card: a file with its folder, a commit with its short hash. */
	private renderDeliverableRow(parent: HTMLElement, d: IDispatchDeliverable, taskId: string): void {
		const li = dom.append(parent, dom.$('li'));
		const where = deliverableWhere(d);
		const b = dom.append(li, dom.$<HTMLButtonElement>('button.dispatch-task-deliverable', { type: 'button' }));
		const linked = this.linkDeliverable(b, d, taskId);
		if (where) {
			b.appendChild(renderDispatchWhereIcon());
			if (!linked) { this._instantiationService.invokeFunction(setupDeliverableWhereHover, b, d, where, taskId, this._renderStore); }
		} else {
			// the whole name and where it opens (the row cuts the name off and shows only the folder)
			if (!linked) { this._renderStore.add(setupDispatchTextHover(this._hoverService, b, () => ({ text: deliverableTooltip(d) }), { when: () => true })); }
			b.appendChild(renderIcon(DELIVERABLE_ICON[d.kind]));
		}
		if (where) {
			dom.append(b, dom.$('span.name', undefined, deliverableLabel(d)));
			dom.append(b, dom.$('span.dir', undefined, wherePlaces(where.marks.length)));
		} else if (d.kind === 'commit') {
			dom.append(b, dom.$('span.name', undefined, withoutRef(deliverableLabel(d), d.ref)));
			dom.append(b, dom.$('span.hash', undefined, d.ref));
		} else {
			dom.append(b, dom.$('span.name', undefined, deliverableLabel(d)));
			const folder = d.kind === 'file' || d.kind === 'draft' ? folderOf(d.ref, activeSessionFolder(this._sessionsService)) : '';
			if (folder) {
				dom.append(b, dom.$('span.dir', undefined, folder));
			}
		}
		this._renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			this.open(d, taskId);
		}));
	}
}

/** "abc1234 Subject" → "Subject" (the hash has its own column). */
function withoutRef(label: string, ref: string): string {
	return label.startsWith(`${ref} `) ? label.slice(ref.length + 1) : label;
}

/** A file's folder: relative to the session's folder (or its repository) when inside it, home as ~. */
function folderOf(path: string, root: string | undefined): string {
	if (!path.startsWith('/')) {
		return '';
	}
	const dir = path.split('/').slice(0, -1).join('/');
	const bases = root ? [root, root.replace(/(\.worktrees|\/\.claude\/worktrees)\/[^/]+$/, '')] : [];
	for (const base of bases) {
		if (dir === base) {
			return '';
		}
		if (dir.startsWith(base + '/')) {
			return dir.slice(base.length + 1);
		}
	}
	const home = /^\/Users\/[^/]+/.exec(dir)?.[0];
	return home ? '~' + dir.slice(home.length) : dir;
}
