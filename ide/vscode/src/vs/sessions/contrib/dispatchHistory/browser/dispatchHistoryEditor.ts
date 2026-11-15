/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the History tab of the Agents window's side pane (patches/450-history.patch).
 *
 *  Every session the agents on this Mac left on disk (Claude Code, Codex, OpenCode, pi, Hermes, Gemini CLI,
 *  ZCode), also the ones never opened in Dispatch. Nothing is imported by looking: the list on the left stays
 *  as it is, no project is added. On top the scope switch (this folder / the project / all, square like the
 *  Tasks tab's), the Mac when there are others, view options and refresh; under it the search box (titles,
 *  messages, folders, models and anything typed in a session). Sessions are grouped by project, newest first:
 *  a row is the title, the last message, and one grey line with the agent's own mark and name, how many
 *  messages and sub-agents, how long ago and the model. A click opens the row: the first message, the folder,
 *  and Continue / Open in New Window. Continue opens it when the window already has it; otherwise Claude Code,
 *  Codex and OpenCode conversations go on in the chat (the Agent Host takes the conversation in, its history
 *  shows and the next message continues it: AgentService.dispatchContinueChat) or in a terminal session in the
 *  session's folder running the agent's own resume line, as the Chat | Terminal switch next to Continue says
 *  (remembered); other agents only in the terminal. Open in New Window continues it in a terminal in an editor
 *  window of its own.
 *--------------------------------------------------------------------------------------------*/

import '../../dispatchTasks/browser/media/dispatchTasks.css';
import './media/dispatchHistory.css';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IAgentHostConnectionsService } from '../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { findSessionForOpenSessionLink } from '../../chat/browser/openSessionLinkOpener.contribution.js';
import { applyContinuedApprovals } from './dispatchContinueApprovals.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { activeSessionFolder } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { DISPATCH_TERMINAL_PROVIDER_ID, DispatchTerminalSessionsProvider } from '../../dispatchTerminal/browser/dispatchTerminalSessionsProvider.js';
import {
	agentIconId, continueName, countLabel, modelLabel, DISPATCH_HISTORY_COMMAND, historyAgo, HistoryScope, HistorySort, IHistoryAnswer, IHistoryRequest, IHistorySession,
	initialScope, PAGE, requestKey
} from './dispatchHistoryModel.js';

const POLL_MS = 30_000;
const BUSY_POLL_MS = 3_000;
const SEARCH_DEBOUNCE_MS = 220;
const SCOPE_KEY = 'dispatch.history.scope';
const SORT_KEY = 'dispatch.history.sort';
const EMPTY_KEY = 'dispatch.history.showEmpty';
const AGENTS_OFF_KEY = 'dispatch.history.agentsOff';
const FOLDED_KEY = 'dispatch.history.folded';
const CONTINUE_IN_KEY = 'dispatch.history.continueIn';
/** Agents whose own conversations the chat can go on with (the Agent Host's providers). */
const CHAT_AGENTS = new Set(['claude-code', 'codex', 'opencode']);
const CHAT_APPEAR_MS = 20_000;

export class DispatchHistoryEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.dispatch.history';
	static readonly EDITOR_ID = 'workbench.editor.dispatch.history';

	override get typeId(): string {
		return DispatchHistoryEditorInput.ID;
	}

	override get editorId(): string {
		return DispatchHistoryEditorInput.EDITOR_ID;
	}

	override get resource(): undefined {
		return undefined;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ExcludeFromEditorLimit;
	}

	override getName(): string {
		return localize('dispatchHistory.name', "History");
	}

	override getIcon(): ThemeIcon {
		return Codicon.history;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof DispatchHistoryEditorInput;
	}
}

export class DispatchHistoryEditorSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(DispatchHistoryEditorInput);
	}
}

interface IState {
	readonly key?: string;
	readonly answer?: IHistoryAnswer;
	readonly loading: boolean;
}

export class DispatchHistoryEditor extends EditorPane {

	static readonly ID = DispatchHistoryEditorInput.EDITOR_ID;

	private _root!: HTMLElement;
	private _listEl: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _barEl: HTMLElement | undefined;
	private _scope: HistoryScope = 'all';
	private _scopeChosen = false;
	private _sort: HistorySort = 'updated';
	private _query = '';
	private _limit = PAGE;
	private _machine = 'local';
	private _state: IState = { loading: true };
	private readonly _open = new Set<string>();
	private readonly _cache = new Map<string, IHistoryAnswer>();
	private readonly _barStore = this._register(new DisposableStore());
	private readonly _listStore = this._register(new DisposableStore());
	private readonly _countStore = this._register(new DisposableStore());
	private _requestId = 0;
	private _lastListKey = '';
	private _searchTimer: number | undefined;
	private _busyTimer: number | undefined;
	/** The session Continue is taking into the chat right now (its button waits). */
	private _continuing: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storage: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsProvidersService private readonly _providers: ISessionsProvidersService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@ISessionsManagementService private readonly _management: ISessionsManagementService,
		@IAgentHostConnectionsService private readonly _connections: IAgentHostConnectionsService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(DispatchHistoryEditor.ID, group, telemetryService, themeService, _storage);
		this._sort = this._storage.get(SORT_KEY, StorageScope.PROFILE) === 'created' ? 'created' : 'updated';
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, dom.$('.dispatch-tasks.dispatch-history'));
		this._root.tabIndex = -1;
		const head = dom.append(this._root, dom.$('.dispatch-history-head'));
		this._barEl = dom.append(head, dom.$('.dispatch-tasks-bar.dispatch-history-bar'));
		this.renderSearch(head);
		this._countEl = dom.append(head, dom.$('.dispatch-history-count'));
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			session?.workspace.read(reader);
			if (!this._scopeChosen) {
				this._scope = initialScope(this._storage.get(SCOPE_KEY, StorageScope.PROFILE), !!this.folder());
			}
			if (this.isVisible()) {
				this.renderBar();
				void this.refresh();
			}
		}));
		const timer = mainWindow.setInterval(() => {
			if (this.isVisible() && mainWindow.document.visibilityState === 'visible') {
				void this.refresh();
			}
		}, POLL_MS);
		this._register(toDisposable(() => {
			mainWindow.clearInterval(timer);
			mainWindow.clearTimeout(this._searchTimer);
			mainWindow.clearTimeout(this._busyTimer);
		}));
		this.renderBar();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		void this.refresh();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this.renderBar();
			void this.refresh();
		}
	}

	override focus(): void {
		(this._root?.querySelector('input.dispatch-history-search-input') as HTMLInputElement | null)?.focus();
	}

	override layout(_dimension: dom.Dimension): void { }

	// ---- the question ---------------------------------------------------------------------------

	private folder(): string | undefined {
		return activeSessionFolder(this._sessionsService);
	}

	private get agentsOff(): string[] {
		try {
			const v = JSON.parse(this._storage.get(AGENTS_OFF_KEY, StorageScope.PROFILE) ?? '[]');
			return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}

	private set agentsOff(v: string[]) {
		this._storage.store(AGENTS_OFF_KEY, JSON.stringify(v), StorageScope.PROFILE, StorageTarget.USER);
	}

	private get showEmpty(): boolean {
		return this._storage.getBoolean(EMPTY_KEY, StorageScope.PROFILE, false);
	}

	private get folded(): Set<string> {
		try {
			const v = JSON.parse(this._storage.get(FOLDED_KEY, StorageScope.PROFILE) ?? '[]');
			return new Set(Array.isArray(v) ? v : []);
		} catch {
			return new Set();
		}
	}

	private request(): IHistoryRequest {
		const folder = this.folder();
		const remote = this._machine !== 'local';
		const known = this._state.answer?.agents?.map(a => a.id) ?? [];
		const off = new Set(this.agentsOff);
		const agents = off.size && known.length ? known.filter(a => !off.has(a)) : undefined;
		return {
			scope: remote || !folder ? 'all' : this._scope,
			folder: remote ? undefined : folder,
			query: this._query.trim() || undefined,
			agents: agents && agents.length ? agents : undefined,
			sort: this._sort,
			limit: this._limit,
			showEmpty: this.showEmpty || undefined,
			machine: remote ? this._machine : undefined,
		};
	}

	/** Shows the cached answer at once, then asks the bridge for a fresh one. */
	async refresh(): Promise<void> {
		const req = this.request();
		const key = requestKey(req);
		const id = ++this._requestId;
		if (this._state.key !== key) {
			const cached = this._cache.get(key);
			this._state = { key, answer: cached ?? this._state.answer, loading: true };
			this.renderList();
		}
		let answer: IHistoryAnswer;
		try {
			answer = (await this._commandService.executeCommand<IHistoryAnswer>(DISPATCH_HISTORY_COMMAND, req)) ?? { ok: false, error: localize('dispatchHistory.noBridge', "Dispatch is not answering.") };
		} catch (e) {
			answer = { ok: false, error: String((e as Error)?.message ?? e) };
		}
		if (id !== this._requestId) {
			return;
		}
		if (answer.ok) {
			this._cache.set(key, answer);
		}
		mainWindow.clearTimeout(this._busyTimer);
		if (!answer.ok && answer.pending) {
			// the other Mac is still answering: keep loading and ask again, no warning
			this._state = { key, answer: this._state.answer, loading: true };
			this.renderBar();
			this.renderList();
			if (this.isVisible()) {
				this._busyTimer = mainWindow.setTimeout(() => void this.refresh(), BUSY_POLL_MS);
			}
			return;
		}
		this._state = { key, answer: answer.ok || !this._state.answer?.ok ? answer : this._state.answer, loading: false };
		if (!answer.ok && this._state.answer !== answer) {
			this._notificationService.warn(answer.error || localize('dispatchHistory.failed', "Could not read the session history."));
		}
		this.renderBar();
		this.renderList();
		mainWindow.clearTimeout(this._busyTimer);
		if (answer.ok && (answer.refreshing || answer.indexing) && this.isVisible()) {
			// the background read is still going: ask again soon, so new sessions show up as it finds them
			this._busyTimer = mainWindow.setTimeout(() => void this.refresh(), BUSY_POLL_MS);
		}
	}

	// ---- the bar: scope, Mac, options, refresh, search -------------------------------------------

	private renderBar(): void {
		const bar = this._barEl;
		if (!bar) {
			return;
		}
		this._barStore.clear();
		dom.clearNode(bar);
		const folder = this.folder();
		const remote = this._machine !== 'local';
		const seg = dom.append(bar, dom.$('.dispatch-tasks-scope', { role: 'tablist' }));
		const projectName = this._state.answer?.project?.name || (folder ? folder.split('/').filter(Boolean).pop() : '') || localize('dispatchHistory.project', "Project");
		const scopes: [HistoryScope, string, string][] = [
			['workspace', localize('dispatchHistory.thisFolder', "This folder"), localize('dispatchHistory.thisFolderTitle', "Sessions that worked in the folder of the session on screen")],
			['project', projectName, localize('dispatchHistory.projectTitle', "Sessions of this project, its copies included")],
			['all', localize('dispatchHistory.all', "All"), localize('dispatchHistory.allTitle', "Every session on this Mac")],
		];
		// This folder only when the folder is a copy inside a project (otherwise it is the project itself)
		const root = this._state.answer?.project?.root;
		const shown = scopes.filter(([scope]) => scope !== 'workspace' || !folder || !root || root.replace(/\/$/, '') !== folder.replace(/\/$/, ''));
		if (this._scope === 'workspace' && shown.length < scopes.length) {
			this._scope = 'project';
			mainWindow.setTimeout(() => void this.refresh(), 0);
		}
		for (const [scope, label, title] of shown) {
			const usable = scope === 'all' || (!!folder && !remote);
			const on = (remote || !folder ? 'all' : this._scope) === scope;
			const tab = dom.append(seg, dom.$<HTMLButtonElement>('button.dispatch-tasks-pill', { type: 'button', role: 'tab' }));
			tab.textContent = label;
			tab.classList.toggle('on', on);
			tab.setAttribute('aria-selected', String(on));
			tab.disabled = !usable;
			this._barStore.add(setupDispatchTextHover(this._hoverService, tab, () => ({ text: usable ? title : localize('dispatchHistory.needFolder', "Open a session in a folder first") }), { when: () => true }));
			this._barStore.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
				if (!usable || this._scope === scope) {
					return;
				}
				this._scope = scope;
				this._scopeChosen = true;
				this._storage.store(SCOPE_KEY, scope, StorageScope.PROFILE, StorageTarget.USER);
				this._limit = PAGE;
				this.renderBar();
				void this.refresh();
			}));
		}
		const tools = dom.append(bar, dom.$('.dispatch-history-tools'));
		const machines = this._state.answer?.machines ?? [];
		if (machines.length > 1) {
			const current = machines.find(m => m.id === this._machine) ?? machines[0];
			const mac = this.iconButton(tools, Codicon.vm, localize('dispatchHistory.machineTitle', "Whose sessions: this Mac or another of your Macs"), anchor => this.showMachines(anchor), current.name);
			mac.classList.add('dispatch-history-machine');
		}
		this.iconButton(tools, Codicon.filter, localize('dispatchHistory.options', "Agents, order and empty sessions"), anchor => this.showOptions(anchor));
		this.iconButton(tools, Codicon.refresh, localize('dispatchHistory.refresh', "Look for new sessions now"), () => void this.refresh());
		this.renderCount();
	}

	/** The search box: built once, so an answer that comes in while the person types never resets it. */
	private renderSearch(head: HTMLElement): void {
		const box = dom.append(head, dom.$('.dispatch-history-search'));
		box.appendChild(renderIcon(Codicon.search));
		const search = dom.append(box, dom.$<HTMLInputElement>('input.dispatch-history-search-input', {
			type: 'text',
			placeholder: localize('dispatchHistory.searchPlaceholder', "Search sessions"),
			'aria-label': localize('dispatchHistory.searchLabel', "Search sessions by title, message, folder or model"),
		}));
		const clear = dom.append(box, dom.$<HTMLButtonElement>('button.dispatch-history-clear', { type: 'button', 'aria-label': localize('dispatchHistory.clear', "Clear search") }));
		clear.appendChild(renderIcon(Codicon.close));
		const set = (value: string, now: boolean) => {
			this._query = value;
			this._limit = PAGE;
			box.classList.toggle('has-text', !!value);
			mainWindow.clearTimeout(this._searchTimer);
			if (now) {
				void this.refresh();
			} else {
				this._searchTimer = mainWindow.setTimeout(() => void this.refresh(), SEARCH_DEBOUNCE_MS);
			}
		};
		this._register(dom.addDisposableListener(clear, dom.EventType.CLICK, () => {
			search.value = '';
			set('', true);
			search.focus();
		}));
		this._register(dom.addDisposableListener(search, dom.EventType.INPUT, () => set(search.value, false)));
		this._register(dom.addDisposableListener(search, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && search.value) {
				e.preventDefault();
				e.stopPropagation();
				search.value = '';
				set('', true);
			}
		}));
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, title: string, run: (anchor: HTMLElement) => void, label?: string): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-history-tool', { type: 'button', 'aria-label': title }));
		b.appendChild(renderIcon(icon));
		if (label) {
			dom.append(b, dom.$('span', undefined, label));
		}
		this._barStore.add(setupDispatchTextHover(this._hoverService, b, () => ({ text: title }), { when: () => true }));
		this._barStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			run(b);
		}));
		return b;
	}

	private showMachines(anchor: HTMLElement): void {
		const machines = this._state.answer?.machines ?? [];
		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => machines.map(m => toAction({
				id: `dispatch.history.machine.${m.id}`,
				label: m.local ? localize('dispatchHistory.thisMac', "{0} (this Mac)", m.name) : m.name,
				checked: m.id === this._machine,
				run: () => {
					this._machine = m.id;
					this._limit = PAGE;
					this.renderBar();
					void this.refresh();
				},
			})),
		});
	}

	private showOptions(anchor: HTMLElement): void {
		const agents = this._state.answer?.agents ?? [];
		const off = new Set(this.agentsOff);
		const actions: IAction[] = [];
		for (const a of agents) {
			actions.push(toAction({
				id: `dispatch.history.agent.${a.id}`,
				label: localize('dispatchHistory.agentCount', "{0} ({1})", a.name, a.count),
				checked: !off.has(a.id),
				run: () => {
					const next = new Set(this.agentsOff);
					if (next.has(a.id)) {
						next.delete(a.id);
					} else {
						next.add(a.id);
					}
					this.agentsOff = [...next];
					void this.refresh();
				},
			}));
		}
		if (off.size) {
			actions.push(toAction({ id: 'dispatch.history.agentsAll', label: localize('dispatchHistory.agentsAll', "Show All Agents"), run: () => { this.agentsOff = []; void this.refresh(); } }));
		}
		if (actions.length) {
			actions.push(new Separator());
		}
		const sort = (value: HistorySort, label: string) => toAction({
			id: `dispatch.history.sort.${value}`, label, checked: this._sort === value, run: () => {
				this._sort = value;
				this._storage.store(SORT_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
				void this.refresh();
			},
		});
		actions.push(sort('updated', localize('dispatchHistory.sortUpdated', "Newest Activity First")), sort('created', localize('dispatchHistory.sortCreated', "Newest Started First")));
		actions.push(new Separator());
		actions.push(toAction({
			id: 'dispatch.history.empty', label: localize('dispatchHistory.showEmpty', "Show Sessions with No Messages"), checked: this.showEmpty, run: () => {
				this._storage.store(EMPTY_KEY, !this.showEmpty, StorageScope.PROFILE, StorageTarget.USER);
				void this.refresh();
			},
		}));
		this._contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	private renderCount(): void {
		const el = this._countEl;
		if (!el) {
			return;
		}
		dom.clearNode(el);
		this._countStore.clear();
		const a = this._state.answer;
		if (!a?.ok) {
			return;
		}
		const shown = a.shown ?? 0;
		const matched = a.matched ?? 0;
		const total = a.total ?? 0;
		const text = this._query.trim()
			? localize('dispatchHistory.countFound', "{0} found", matched.toLocaleString('en-US'))
			: matched > shown
				? localize('dispatchHistory.countSome', "{0} of {1} sessions", shown.toLocaleString('en-US'), matched.toLocaleString('en-US'))
				: countLabel(total, localize('dispatchHistory.session', "session"), localize('dispatchHistory.sessions', "sessions"));
		dom.append(el, dom.$('span', undefined, text));
		if (a.indexing && a.indexing.total) {
			dom.append(el, dom.$('span.dispatch-history-busy', undefined, localize('dispatchHistory.reading', "Reading your history: {0} of {1}", a.indexing.done, a.indexing.total)));
		} else if (a.refreshing) {
			dom.append(el, dom.$('span.dispatch-history-busy', undefined, localize('dispatchHistory.looking', "Looking for new sessions")));
		}
		const hint = dom.append(el, dom.$('span.dispatch-history-note', undefined, localize('dispatchHistory.notImported', "Only Continue adds to Sessions")));
		this._countStore.add(setupDispatchTextHover(this._hoverService, hint, () => ({ text: localize('dispatchHistory.notImportedTitle', "Looking here changes nothing. A session joins your list on the left only when you continue it.") }), { when: () => true }));
	}

	// ---- the list ------------------------------------------------------------------------------

	private renderList(force = false): void {
		if (!this._root) {
			return;
		}
		const state = this._state;
		const minute = Math.floor(Date.now() / 60000);
		const key = JSON.stringify([state.key, state.answer, state.loading && !state.answer, [...this._open], [...this.folded], minute]);
		if (!force && key === this._lastListKey && this._listEl) {
			return;
		}
		this._lastListKey = key;
		this.renderCount();
		const scrollTop = this._listEl?.scrollTop ?? 0;
		this._listStore.clear();
		this._listEl?.remove();
		const list = this._listEl = dom.append(this._root, dom.$('.dispatch-tasks-list.dispatch-history-list'));
		const a = state.answer;
		if (!a) {
			this.renderSkeleton(list);
			return;
		}
		if (!a.ok) {
			const empty = dom.append(list, dom.$('.dispatch-tasks-line.dispatch-tasks-empty-lines'));
			dom.append(empty, dom.$('.dispatch-tasks-empty-line', undefined, localize('dispatchHistory.errorLine', "Could not read the session history.")));
			dom.append(empty, dom.$('.dispatch-tasks-empty-hint', undefined, a.error || ''));
			return;
		}
		const groups = a.groups ?? [];
		if (!groups.length) {
			const empty = dom.append(list, dom.$('.dispatch-tasks-line.dispatch-tasks-empty-lines'));
			if (a.indexing) {
				dom.append(empty, dom.$('.dispatch-tasks-empty-line', undefined, localize('dispatchHistory.firstRead', "Reading the sessions on this Mac…")));
				dom.append(empty, dom.$('.dispatch-tasks-empty-hint', undefined, localize('dispatchHistory.firstReadHint', "The first time takes a minute or two. They show up here as they are found.")));
			} else if (this._query.trim()) {
				dom.append(empty, dom.$('.dispatch-tasks-empty-line', undefined, localize('dispatchHistory.noMatch', "No sessions match “{0}”.", this._query.trim())));
				dom.append(empty, dom.$('.dispatch-tasks-empty-hint', undefined, localize('dispatchHistory.noMatchHint', "Search looks at titles, messages, folders, models and what you typed.")));
			} else {
				dom.append(empty, dom.$('.dispatch-tasks-empty-line', undefined, a.scope === 'all'
					? localize('dispatchHistory.noneAll', "No sessions on this Mac yet.")
					: localize('dispatchHistory.noneHere', "No sessions here yet.")));
				dom.append(empty, dom.$('.dispatch-tasks-empty-hint', undefined, localize('dispatchHistory.noneHint', "Sessions of Claude Code, Codex, OpenCode and other agents show up here, also ones you ran in a terminal.")));
			}
			return;
		}
		const folded = this.folded;
		// one project in view (this folder, or the project): its name is already in the switch, no group head
		const bare = groups.length === 1 && a.scope !== 'all';
		for (const g of groups) {
			const group = dom.append(list, dom.$('.dispatch-task-group.dispatch-history-group'));
			if (bare) {
				const rows = dom.append(group, dom.$('.dispatch-history-rows'));
				for (const s of g.sessions) {
					this.renderRow(rows, s);
				}
				continue;
			}
			const head = dom.append(group, dom.$<HTMLButtonElement>('button.dispatch-task-group-head', { type: 'button' }));
			const isFolded = folded.has(g.root);
			head.setAttribute('aria-expanded', String(!isFolded));
			head.appendChild(renderIcon(isFolded ? Codicon.chevronRight : Codicon.chevronDown));
			dom.append(head, dom.$('span.dispatch-history-group-name', undefined, g.project));
			dom.append(head, dom.$('span.dispatch-task-group-count', undefined, g.count.toLocaleString('en-US')));
			this._listStore.add(setupDispatchTextHover(this._hoverService, head, () => ({ text: g.root }), { when: () => true }));
			this._listStore.add(dom.addDisposableListener(head, dom.EventType.CLICK, () => {
				const next = this.folded;
				if (next.has(g.root)) {
					next.delete(g.root);
				} else {
					next.add(g.root);
				}
				this._storage.store(FOLDED_KEY, JSON.stringify([...next]), StorageScope.PROFILE, StorageTarget.USER);
				this.renderList();
			}));
			if (isFolded) {
				continue;
			}
			const rows = dom.append(group, dom.$('.dispatch-history-rows'));
			for (const s of g.sessions) {
				this.renderRow(rows, s);
			}
		}
		if ((a.matched ?? 0) > (a.shown ?? 0)) {
			const more = dom.append(list, dom.$<HTMLButtonElement>('button.dispatch-tasks-more.dispatch-history-more', { type: 'button' }));
			more.appendChild(renderIcon(Codicon.chevronDown));
			dom.append(more, dom.$('span', undefined, localize('dispatchHistory.more', "Show {0} more", Math.min(PAGE, (a.matched ?? 0) - (a.shown ?? 0)))));
			this._listStore.add(dom.addDisposableListener(more, dom.EventType.CLICK, () => {
				this._limit += PAGE;
				void this.refresh();
			}));
		}
		list.scrollTop = scrollTop;
	}

	private renderSkeleton(list: HTMLElement): void {
		const sk = dom.append(list, dom.$('.dispatch-history-rows.dispatch-tasks-skeleton'));
		sk.setAttribute('aria-busy', 'true');
		sk.setAttribute('aria-label', localize('dispatchHistory.loading', "Loading sessions…"));
		for (const w of [70, 54, 78, 62]) {
			const row = dom.append(sk, dom.$('.dispatch-history-row'));
			const bar = dom.append(row, dom.$('.dispatch-tasks-skeleton-bar'));
			bar.style.width = `${w}%`;
			dom.append(row, dom.$('.dispatch-tasks-skeleton-bar.short'));
		}
	}

	private renderRow(parent: HTMLElement, s: IHistorySession): void {
		const id = `${s.host}|${s.key}`;
		const open = this._open.has(id);
		const row = dom.append(parent, dom.$('.dispatch-history-row', { tabIndex: 0, role: 'button' }));
		row.classList.toggle('open', open);
		row.setAttribute('aria-expanded', String(open));
		const toggle = () => {
			if (this._open.has(id)) {
				this._open.delete(id);
			} else {
				this._open.add(id);
			}
			this.renderList();
		};
		this._listStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, e => {
			if ((e.target as HTMLElement).closest('button, a, .dispatch-history-detail')) {
				return;
			}
			toggle();
		}));
		this._listStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
				e.preventDefault();
				toggle();
			}
		}));
		this._listStore.add(dom.addDisposableListener(row, dom.EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			this.showRowMenu({ x: e.clientX, y: e.clientY }, s);
		}));

		// the head: the agent's own mark, the title, the time (under the pointer the time gives way to ⋯)
		const head = dom.append(row, dom.$('.dispatch-history-row-head'));
		const mark = dom.append(head, dom.$('span.dispatch-history-mark'));
		mark.appendChild(renderIcon(ThemeIcon.fromId(agentIconId(s.icon))));
		mark.setAttribute('aria-label', s.agent_name);
		this._listStore.add(setupDispatchTextHover(this._hoverService, mark, () => ({ text: s.agent_name }), { when: () => true }));
		const title = dom.append(head, dom.$('span.dispatch-history-title'));
		title.textContent = s.title || localize('dispatchHistory.untitled', "Untitled session");
		this._listStore.add(setupDispatchTextHover(this._hoverService, title, () => ({ text: s.title })));
		dom.append(head, dom.$('span.dispatch-history-time', undefined, historyAgo(this._sort === 'created' ? s.created_at : s.last_at)));
		const actions = dom.append(head, dom.$('.dispatch-history-actions'));
		this.rowAction(actions, Codicon.ellipsis, localize('dispatchHistory.moreActions', "Continue, open in a new window, copy"), true, anchor => this.showRowMenu(anchor, s));

		// the last message (or, for a search that found it in what was typed, that line), one line
		const text = s.matches === 'text' && s.snippet ? s.snippet : s.preview?.text;
		if (text) {
			const preview = dom.append(row, dom.$('.dispatch-history-preview'));
			const who = s.matches === 'text' && s.snippet ? localize('dispatchHistory.youTyped', "You:") : s.preview?.role === 'user' ? localize('dispatchHistory.you', "You:") : localize('dispatchHistory.agentSaid', "Agent:");
			dom.append(preview, dom.$('span.dispatch-history-who', undefined, who));
			dom.append(preview, dom.$('span', undefined, ` ${text}`));
		}

		// one grey line, never wrapping: messages, sub-agents, the model; whether the list on the left has it
		const meta = dom.append(row, dom.$('.dispatch-history-meta'));
		dom.append(meta, dom.$('span', undefined, countLabel(s.messages, localize('dispatchHistory.message', "message"), localize('dispatchHistory.messages', "messages"))));
		if (s.subagents) {
			dom.append(meta, dom.$('span', undefined, countLabel(s.subagents, localize('dispatchHistory.subagent', "sub-agent"), localize('dispatchHistory.subagents', "sub-agents"))));
		}
		if (s.model) {
			const model = dom.append(meta, dom.$('span.dispatch-history-model', undefined, modelLabel(s.model)));
			this._listStore.add(setupDispatchTextHover(this._hoverService, model, () => ({ text: s.model }), { when: () => true }));
		}
		// "In Sessions" only for one the list on the left shows: an external one (VS Code picks up recent sessions
		// other apps made) is known to the window but waits for the person's range before the list shows it
		const inList = this.windowSession(s);
		if (inList && inList.isExternal?.get() !== true) {
			const tag = dom.append(meta, dom.$('span.dispatch-history-in'));
			tag.textContent = localize('dispatchHistory.inSessions', "In Sessions");
		}

		// opened: the first message, the folder, and the two ways to go on
		const detail = dom.append(row, dom.$('.dispatch-history-detail'));
		const inner = dom.append(detail, dom.$('div'));
		if (open) {
			if (s.first_prompt && s.first_prompt.trim() !== s.title.trim()) {
				dom.append(inner, dom.$('.dispatch-history-label', undefined, localize('dispatchHistory.firstMessage', "First message")));
				dom.append(inner, dom.$('.dispatch-history-first', undefined, s.first_prompt));
			}
			const facts = dom.append(inner, dom.$('.dispatch-history-facts'));
			const fact = (label: string, value: string) => {
				if (value) {
					const f = dom.append(facts, dom.$('.dispatch-history-fact'));
					dom.append(f, dom.$('span.k', undefined, label));
					dom.append(f, dom.$('span.v', undefined, value));
				}
			};
			fact(localize('dispatchHistory.agent', "Agent"), s.agent_name);
			if (s.cwd) {
				// the folder's name to read, the folders above it in grey, cut in the middle when long
				const f = dom.append(facts, dom.$('.dispatch-history-fact'));
				dom.append(f, dom.$('span.k', undefined, localize('dispatchHistory.folder', "Folder")));
				const v = dom.append(f, dom.$('span.v.dispatch-history-path'));
				const home = s.cwd.replace(/^\/Users\/[^/]+/, '~');
				const cut = home.lastIndexOf('/');
				dom.append(v, dom.$('span.name', undefined, home.slice(cut + 1) || home));
				if (cut > 0) {
					dom.append(v, dom.$('span.dir', undefined, `\u200e${home.slice(0, cut)}\u200e`)); // left-to-right marks keep the slashes in place in the right-aligned cut
				}
				if (!s.folder_exists) {
					dom.append(v, dom.$('span.dir', undefined, localize('dispatchHistory.gone', "(gone)")));
				}
				this._listStore.add(setupDispatchTextHover(this._hoverService, v, () => ({ text: s.cwd })));
			}
			fact(localize('dispatchHistory.branch', "Branch"), s.branch);
			fact(localize('dispatchHistory.started', "Started"), s.created_at ? new Date(s.created_at * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
			fact(localize('dispatchHistory.lastActive', "Last active"), s.last_at ? new Date(s.last_at * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
			const buttons = dom.append(inner, dom.$('.dispatch-history-buttons'));
			const busy = this._continuing === s.key;
			const cont = this.detailButton(buttons, busy ? localize('dispatchHistory.continuing', "Opening in the chat…") : localize('dispatchHistory.continue', "Continue"), this.canContinue(s) && !this._continuing, () => this.continue(s, false), () => this.continueTitle(s));
			cont.classList.toggle('busy', busy);
			if (this.canChat(s)) {
				this.continueInSwitch(buttons, cont);
			}
			this.detailButton(buttons, localize('dispatchHistory.newWindow', "Open in New Window"), this.canContinue(s), () => this.continue(s, true), this.newWindowTitle(s));
			if (!this.canContinue(s) && s.resume.why) {
				dom.append(inner, dom.$('.dispatch-history-why', undefined, s.resume.why));
			}
		}
	}

	private rowAction(parent: HTMLElement, icon: ThemeIcon, title: string, enabled: boolean, run: (anchor: HTMLElement) => void): void {
		const b = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-history-action', { type: 'button', 'aria-label': title }));
		b.appendChild(renderIcon(icon));
		b.disabled = !enabled;
		this._listStore.add(setupDispatchTextHover(this._hoverService, b, () => ({ text: title }), { when: () => true }));
		this._listStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			if (enabled) {
				run(b);
			}
		}));
	}

	private detailButton(parent: HTMLElement, label: string, enabled: boolean, run: () => void, title: string | (() => string)): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-history-button', { type: 'button' }));
		dom.append(b, dom.$('span', undefined, label));
		b.disabled = !enabled;
		this._listStore.add(setupDispatchTextHover(this._hoverService, b, () => ({ text: typeof title === 'string' ? title : title() }), { when: () => true }));
		this._listStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			if (enabled) {
				run();
			}
		}));
		return b;
	}

	/** Where Continue goes on with a conversation the chat can take: in the chat (the default) or in a terminal. */
	private continueIn(): 'chat' | 'terminal' {
		return this._storage.get(CONTINUE_IN_KEY, StorageScope.PROFILE) === 'terminal' ? 'terminal' : 'chat';
	}

	/** Chat | Terminal next to Continue: the same square switch as the Tasks tab's scope. */
	private continueInSwitch(parent: HTMLElement, cont: HTMLElement): void {
		const seg = dom.append(parent, dom.$('.dispatch-tasks-scope.dispatch-history-continue-in', { role: 'radiogroup', 'aria-label': localize('dispatchHistory.continueIn', "Continue in") }));
		const pills: HTMLButtonElement[] = [];
		const paint = () => {
			const cur = this.continueIn();
			for (const p of pills) {
				const on = p.dataset.continueIn === cur;
				p.classList.toggle('on', on);
				p.setAttribute('aria-checked', String(on));
			}
			cont.setAttribute('aria-description', cur === 'chat' ? localize('dispatchHistory.inChatShort', "in the chat") : localize('dispatchHistory.inTerminalShort', "in a terminal"));
		};
		const pill = (id: 'chat' | 'terminal', label: string, title: string) => {
			const p = dom.append(seg, dom.$<HTMLButtonElement>('button.dispatch-tasks-pill', { type: 'button', role: 'radio' }, label));
			p.dataset.continueIn = id;
			pills.push(p);
			this._listStore.add(setupDispatchTextHover(this._hoverService, p, () => ({ text: title }), { when: () => true }));
			this._listStore.add(dom.addDisposableListener(p, dom.EventType.CLICK, e => {
				e.stopPropagation();
				this._storage.store(CONTINUE_IN_KEY, id, StorageScope.PROFILE, StorageTarget.USER);
				paint();
			}));
		};
		pill('chat', localize('dispatchHistory.chat', "Chat"), localize('dispatchHistory.chatTitle', "Continue goes on in the chat here, with the conversation so far above it"));
		pill('terminal', localize('dispatchHistory.terminal', "Terminal"), localize('dispatchHistory.terminalTitle', "Continue goes on in a terminal in its folder, with the agent's own command"));
		paint();
	}

	/** The chat can go on with it: one of the chat's agents, on this Mac, not in the window's list yet. */
	private canChat(s: IHistorySession): boolean {
		return s.host === 'local' && CHAT_AGENTS.has(s.agent) && s.resume.ok && !this.windowSession(s) && !!s.session_id;
	}

	private machineName(s: IHistorySession): string {
		return this._state.answer?.machines?.find(m => m.id === s.host)?.name ?? s.host;
	}

	/** The window's own session for it, when the list on the left has it (the CLI's `window` is a hint; this decides). */
	private windowSession(s: IHistorySession): ISession | undefined {
		return s.host === 'local' && s.window
			? findSessionForOpenSessionLink(URI.from({ scheme: s.window.provider, path: `/${s.window.id}` }), this._management, this._connections)
			: undefined;
	}

	private canContinue(s: IHistorySession): boolean {
		return s.host !== 'local' ? !!s.cwd : !!this.windowSession(s) || s.resume.ok;
	}

	private continueTitle(s: IHistorySession): string {
		if (s.host !== 'local') {
			return localize('dispatchHistory.continueRemote', "Open its folder on {0} in a window connected to that Mac", this.machineName(s));
		}
		if (this.windowSession(s)) {
			return localize('dispatchHistory.continueWindow', "Open this session; it is already in your sessions");
		}
		if (s.resume.ok && this.canChat(s) && this.continueIn() === 'chat') {
			return localize('dispatchHistory.continueChatTitle', "Continue it in the chat here: the conversation so far shows, and your next message goes on with it. It joins your sessions on the left.");
		}
		return s.resume.ok
			? localize('dispatchHistory.continueTitle', "Continue it here: {0} picks up where it stopped, in a terminal in its folder", s.agent_name)
			: (s.resume.why ?? '');
	}

	private newWindowTitle(s: IHistorySession): string {
		if (s.host !== 'local') {
			return this.continueTitle(s);
		}
		return s.resume.ok
			? localize('dispatchHistory.newWindowTitle', "Continue it in a window of its own, on its folder")
			: (s.resume.why ?? '');
	}

	private showRowMenu(anchor: HTMLElement | { x: number; y: number }, s: IHistorySession): void {
		const can = this.canContinue(s);
		const actions: IAction[] = this.canChat(s) ? [
			new Action('dispatch.history.continueChat', localize('dispatchHistory.continueInChat', "Continue in Chat"), undefined, !this._continuing, () => this.continue(s, false, 'chat')),
			new Action('dispatch.history.continueTerminal', localize('dispatchHistory.continueInTerminal', "Continue in a Terminal"), undefined, true, () => this.continue(s, false, 'terminal')),
		] : [
			new Action('dispatch.history.continue', localize('dispatchHistory.continue', "Continue"), undefined, can, () => this.continue(s, false)),
		];
		actions.push(
			new Action('dispatch.history.newWindow', localize('dispatchHistory.newWindow', "Open in New Window"), undefined, can && (s.host !== 'local' || s.resume.ok), () => this.continue(s, true)),
			new Separator(),
			new Action('dispatch.history.copyCommand', localize('dispatchHistory.copyCommand', "Copy Command to Continue in a Terminal"), undefined, !!s.resume.command, async () => this._clipboardService.writeText(s.resume.cwd ? `cd ${shellQuote(s.resume.cwd)} && ${s.resume.command}` : s.resume.command ?? '')),
			new Action('dispatch.history.copyId', localize('dispatchHistory.copyId', "Copy Session ID"), undefined, true, async () => this._clipboardService.writeText(s.session_id)),
			new Action('dispatch.history.copyFolder', localize('dispatchHistory.copyFolder', "Copy Folder Path"), undefined, !!s.cwd, async () => this._clipboardService.writeText(s.cwd)),
		);
		if (s.host === 'local' && s.key.startsWith('/')) {
			actions.push(new Action('dispatch.history.reveal', localize('dispatchHistory.reveal', "Reveal Conversation File in Finder"), undefined, true, () => this._commandService.executeCommand('revealFileInOS', URI.file(s.key))));
		}
		this._contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	// ---- going on --------------------------------------------------------------------------------

	private async continue(s: IHistorySession, newWindow: boolean, inWhere?: 'chat' | 'terminal'): Promise<void> {
		try {
			if (s.host !== 'local') {
				await this._commandService.executeCommand('dispatch.machines', 'openWindow', s.host, s.cwd);
				return;
			}
			if (!newWindow) {
				// already one of the window's sessions: show it (a chat session goes on in the chat)
				const existing = this.windowSession(s);
				if (existing) {
					await this._sessionsService.openSession(existing.resource);
					return;
				}
			}
			if (!newWindow && this.canChat(s) && (inWhere ?? this.continueIn()) === 'chat') {
				await this.continueInChat(s);
				return;
			}
			if (!s.resume.ok || !s.resume.command || !s.resume.cwd) {
				this._notificationService.info(s.resume.why ?? localize('dispatchHistory.cannot', "This session can't be continued here."));
				return;
			}
			if (newWindow) {
				const ans = await this._commandService.executeCommand<{ ok: boolean; message?: string }>(DISPATCH_HISTORY_COMMAND, 'openWindow', { cwd: s.resume.cwd, command: s.resume.command, name: continueName(s) });
				if (!ans?.ok) {
					this._notificationService.warn(ans?.message || localize('dispatchHistory.windowFailed', "Dispatch could not open a new window."));
				}
				return;
			}
			const provider = this._providers.getProvider<DispatchTerminalSessionsProvider>(DISPATCH_TERMINAL_PROVIDER_ID);
			if (!provider) {
				this._notificationService.warn(localize('dispatchHistory.noTerminal', "The terminal is not ready yet. Try again in a moment."));
				return;
			}
			const session = await provider.open(URI.file(s.resume.cwd), {
				id: s.agent, name: continueName(s), about: '', command: s.resume.command, runnable: false, enabled: true, is_default: false,
			});
			await this._sessionsService.openSession(session.resource);
		} catch (e) {
			this._notificationService.warn(localize('dispatchHistory.continueFailed', "Could not continue the session: {0}", String((e as Error)?.message ?? e)));
		}
	}

	/** The Agent Host takes the conversation in; once the window lists it, it opens like any session. */
	private async continueInChat(s: IHistorySession): Promise<void> {
		this._continuing = s.key;
		this.renderList(true);
		try {
			const ans = await this._commandService.executeCommand<{ ok: boolean; session?: string; error?: string }>(DISPATCH_HISTORY_COMMAND, 'continueInChat', { agent: s.agent, id: s.session_id });
			if (!ans?.ok || !ans.session) {
				this._notificationService.prompt(Severity.Warning,
					localize('dispatchHistory.chatFailed', "This conversation could not go on in the chat: {0}", ans?.error || localize('dispatchHistory.noAnswer', "no answer")),
					[{ label: localize('dispatchHistory.inTerminalInstead', "Continue in a Terminal"), run: () => { this._storage.store(CONTINUE_IN_KEY, 'terminal', StorageScope.PROFILE, StorageTarget.USER); void this.continue(s, false); } }]);
				return;
			}
			const backend = URI.parse(ans.session);
			const t0 = Date.now();
			let found = findSessionForOpenSessionLink(backend, this._management, this._connections);
			while (!found && Date.now() - t0 < CHAT_APPEAR_MS) {
				await new Promise<void>(r => mainWindow.setTimeout(r, 300));
				found = findSessionForOpenSessionLink(backend, this._management, this._connections);
			}
			if (!found) {
				this._notificationService.info(localize('dispatchHistory.chatSoon', "It is in your sessions now and shows up on the left in a moment."));
				return;
			}
			await this._sessionsService.openSession(found.resource);
			await applyContinuedApprovals(found, this._providers, this._configurationService, m => this._logService.info(m)).catch(e => this._notificationService.warn(String((e as Error)?.message ?? e)));
		} finally {
			this._continuing = undefined;
			this.renderList(true);
		}
	}
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
