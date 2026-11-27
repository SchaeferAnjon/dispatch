/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Now tab, first in the side pane of a session (patches/410-now.patch). Direction A of
 *  2026-11-11 (task-0v1o9, kanban design/home-now/notes.md A4): three lines and one line of steps, no card.
 *
 *    head    what state the session is in ("Working · step 3 of 5 · 12 min", "Waiting for you · 4 min",
 *            "Done · 2 h ago", "In the terminal · 6 min"), the line the agent writes itself (`dispatch now "…"`),
 *            and a third line: "Right now: …" while it works, the terminal's last line, or the buttons when it
 *            waits for the person (Open proposal, Reply) or is done (Open delivery page, See changes).
 *    tasks   a row each, the one it is on opened: its steps on one thin line (done, the one it is on, the one
 *            that waits, not started), the sub-agents it sent out hanging under the step it is on ("N finished"
 *            for the ones back), what it delivered as its last rows.
 *    folds   Done in this session, Next in <project> (once done), Handed over (only once it was).
 *
 *  Before the agent has written a line the head says what its process shows (the step it is on in plain words).
 *  Data: `dispatch now --session <id> [--live] --json` through dispatch-bridge's `dispatch.now`, every 6 s while
 *  shown; `--live` (what the process is on) only while the session works or waits, it takes a few seconds.
 *  What to show is worked out in dispatchNowModel.ts.
 *--------------------------------------------------------------------------------------------*/

import { isDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import './media/dispatchNow.css';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { markDispatchTermsWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTermMarks.js';
import { ITurnPiece, nowWhy, openingWords } from '../../dispatchLearn/common/dispatchExplainModel.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChat, ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { createDispatchBlocks } from '../../../browser/dispatchStatusBlocks.js';
import { DispatchSubAgentPill, renderSubAgentList, renderWorkingHead } from '../../../browser/dispatchSubAgentPill.js';
import { subAgentsOf, subAgentState } from '../../../browser/dispatchSubAgents.js';
import { VIEW_SESSION_CHANGES_COMMAND_ID } from '../../changes/common/changes.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { DispatchBlockIcons } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { IDispatchWalkService } from '../../dispatchLearn/browser/dispatchWalkService.js';
import { stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';
import { replyParts } from '../../dispatchSubagents/browser/dispatchSubagentStrip.js';
import { runningStep } from '../../dispatchSubagents/browser/dispatchSubagentsModel.js';
import { DispatchNextUpView } from '../../dispatchCapture/browser/dispatchNextUp.js';
import { ago, deliverableLabel, deliverableTooltip, DISPATCH_OPEN_TASK_COMMAND, IDispatchDeliverable, IDispatchPlanItem, openDeliverable, withoutTaskId } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { dispatchProjectsRegistry, projectOfSession } from '../../sessions/browser/dispatchProjectsModel.js';
import { waitingChangedAt } from '../../sessions/browser/dispatchWaitingGroups.js';
import { dispatchWaitingVisible, findWaitingItem, IDispatchWaitingItem, isDesignDecide, waitingDetail } from '../../sessions/browser/dispatchWaitingModel.js';
import { NOW_ONE_LINE_BELOW } from '../../dispatchSideChat/common/dispatchSideChatModel.js';
import { DISPATCH_SIDE_CHAT_RESET_SPLIT_COMMAND } from '../../dispatchSideChat/browser/dispatchSideChatService.js';
import { agentAnchor, deliveryPage, isUnfinished, lastTerminalLine, NowMode, NowSpan, NowStepKind, nowMode, spanOf, splitTasks, stepKinds, stepOf, stoppedByPerson } from './dispatchNowModel.js';

const POLL_MS = 6_000;
/** The shimmer on "Right now": one period, kept in phase across redraws (the step it is on breathes on its own clock, dispatchMarks.ts). */
const SHIMMER_MS = 2_000;

export interface IDispatchNow {
	readonly session?: string;
	readonly now?: { readonly text: string; readonly at: number } | null;
	/** What the running session shows this moment null when it is not running. */
	readonly live?: { readonly status: 'working' | 'waiting' | 'idle'; readonly doing: string; readonly said: string; readonly at: number } | null;
	readonly task?: {
		readonly id: string;
		readonly title: string;
		readonly status: string;
		readonly plan: readonly IDispatchPlanItem[];
		readonly deliverables: readonly IDispatchDeliverable[];
	} | null;
	readonly handoffs?: readonly { readonly at: number; readonly session: string }[];
	/** Every task of the session (`dispatch now`), the ones in progress first. */
	readonly session_tasks?: readonly INowTask[];
	readonly error?: string;
}

export interface INowTask {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly plan: readonly IDispatchPlanItem[];
	readonly deliverables: readonly IDispatchDeliverable[];
	readonly updated_at?: number;
}

export class DispatchNowEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.dispatch.now';
	static readonly EDITOR_ID = 'workbench.editor.dispatch.now';

	override get typeId(): string { return DispatchNowEditorInput.ID; }
	override get editorId(): string { return DispatchNowEditorInput.EDITOR_ID; }
	override get resource(): undefined { return undefined; }

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ExcludeFromEditorLimit;
	}

	override getName(): string {
		return localize('dispatchNow.name', "Now");
	}

	override getIcon(): ThemeIcon {
		// a thin pulse line (direction A, 2026-11-11): the box with a dot was the cushion-like mark
		return Codicon.pulse;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof DispatchNowEditorInput;
	}
}

export class DispatchNowEditorSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(DispatchNowEditorInput);
	}
}

/**
 * The agent of a session in Dispatch's terminal (dispatchTerminal: its `agent`), undefined for a chat session.
 * `provided` is the provider's own object (the active session is a wrapper that does not carry `agent`).
 */
function terminalAgent(session: ISession, provided: ISession | undefined): { readonly name: string } | null | undefined {
	if (session.providerId !== 'dispatch-terminal') {
		return undefined;
	}
	const agent = (provided as (ISession & { readonly agent?: { readonly name?: string } }) | undefined)?.agent;
	return agent?.name ? { name: agent.name } : null; // null: a plain terminal, no agent in it
}

/** A terminal session's screen (dispatchTerminal's controller): what it shows, as plain text. */
function terminalScreen(provided: ISession | undefined): { text(lines: number): Promise<string> } | undefined {
	return (provided as (ISession & { readonly controller?: { text(lines: number): Promise<string> } }) | undefined)?.controller;
}

function engineName(session: ISession, provided: ISession | undefined): string {
	const inTerminal = terminalAgent(session, provided);
	if (inTerminal !== undefined) {
		// the agent the terminal runs, never the provider's own id (it read "dispatch-terminal", task-tt6y)
		return inTerminal?.name ?? localize('dispatchNow.terminal', "Terminal");
	}
	const t = `${session.sessionType} ${session.resource.scheme}`.toLowerCase();
	return t.includes('codex') ? 'Codex' : t.includes('opencode') ? 'OpenCode' : t.includes('claude') ? 'Claude Code' : session.sessionType;
}

function statusOf(status: SessionStatus): 'working' | 'needs-input' | 'error' | 'idle' {
	return status === SessionStatus.InProgress ? 'working' : status === SessionStatus.NeedsInput ? 'needs-input' : status === SessionStatus.Error ? 'error' : 'idle';
}

/** "12 min", "2 h", "3 d"; under a minute "1 min" (it has been going on). */
function spanWords(s: NowSpan): string {
	switch (s.unit) {
		case 'now': return localize('dispatchNow.oneMin', "1 min");
		case 'min': return localize('dispatchNow.min', "{0} min", s.n);
		case 'h': return localize('dispatchNow.hours', "{0} h", s.n);
		case 'd': return localize('dispatchNow.days', "{0} d", s.n);
	}
}

/** "2 h ago", "just now". */
function agoWords(s: NowSpan): string {
	return s.unit === 'now' ? localize('dispatchNow.justNow', "just now") : localize('dispatchNow.ago', "{0} ago", spanWords(s));
}

const SVG = 'http://www.w3.org/2000/svg';
/** The thin ">_" the session rows use for a terminal, drawn at 14px. */
function terminalGlyph(): SVGElement {
	const svg = mainWindow.document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('class', 'dispatch-now-term');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of ['M3 5l3 3-3 3', 'M8 11.5h5']) {
		const p = svg.appendChild(mainWindow.document.createElementNS(SVG, 'path'));
		p.setAttribute('d', d);
	}
	return svg;
}

function icon(i: ThemeIcon, cls = ''): HTMLElement {
	const el = dom.$(`span${ThemeIcon.asCSSSelector(i)}${cls}`);
	el.setAttribute('aria-hidden', 'true');
	return el;
}

/** A deliverable's thin icon: a page, a build, a commit, a link. */
function deliverableIcon(d: IDispatchDeliverable): ThemeIcon {
	return d.kind === 'commit' ? Codicon.gitCommit : d.kind === 'build' ? Codicon.package : d.kind === 'url' ? Codicon.link : Codicon.file;
}

/** What the head needs that is not in `dispatch now`: read from the window each time it draws. */
interface IHeadFacts {
	readonly mode: NowMode;
	readonly status: 'working' | 'needs-input' | 'error' | 'idle';
	/** The session's waiting row (approve, decide) or the design direction one of its tasks waits on. */
	readonly asked?: IDispatchWaitingItem;
	readonly design?: IDispatchWaitingItem;
	/** The person stopped the last turn before it ended. */
	readonly canceled: boolean;
}

/** What each session showed last, for every Now tab of the window (the tab is closed on a new-session page and made
 *  again on the way back): coming back shows that at once, not a guessed state, until the new answer is in. */
const SEEN = new Map<string, IDispatchNow>();

/** The tasks a session's Now lists, from its last answer; undefined when it was never read in this window. */
export function nowTaskIds(session: string, answer: IDispatchNow | undefined = SEEN.get(session)): readonly string[] | undefined {
	return answer && [...(answer.session_tasks ?? []).map(t => t.id), ...(answer.task ? [answer.task.id] : [])];
}

/** A task to open in place in Now, from a task link in the conversation (task-ewbvh, dispatchNow.contribution.ts). */
export const dispatchNowReveal = observableValue<{ readonly session: string; readonly id: string; readonly at: number } | undefined>('dispatchNowReveal', undefined);

/** Sessions whose last turn the person stopped: the number of requests each had then (stoppedByPerson). */
const STOPPED_KEY = 'dispatch.now.stoppedTurns';
const STOPPED_KEPT = 200;

export class DispatchNowEditor extends EditorPane {

	static readonly ID = DispatchNowEditorInput.EDITOR_ID;

	private _root!: HTMLElement;
	private _data: IDispatchNow | undefined;
	private _key = '';
	private _requestId = 0;
	private _lastSig = '';
	private readonly _renderStore = this._register(new DisposableStore());
	private _reading: string | undefined;
	private _readAgain = false;
	/** Tasks the person opened or closed (the one it is on is open until closed). */
	private readonly _taskOpen = new Map<string, boolean>();
	/** Folds the person opened: 'done', 'next', 'handoffs', 'finished'. */
	private readonly _folds = new Set<string>();
	/** A task a link in the conversation asked to open here; done once its row is drawn open (or after 10 s). */
	private _reveal: { readonly id: string; readonly at: number } | undefined;
	/** The sub-agents' pills drawn this round (VS Code's, sessions/browser/dispatchSubAgentPill.ts). */
	private _pills: DispatchSubAgentPill[] = [];
	/** A terminal session's last line, read with the board every round. */
	private _terminalLine = '';
	/** The head being drawn: the task it is on takes its state for the step it is on. */
	private _mode: NowMode = 'done';
	/** The kinds of the last turn's parts, as the why line read them (task-39x97). */
	private _pieces = '';
	/** The status mark kept across redraws: the falling blocks would start over every round otherwise. */
	private _mark: { readonly key: string; readonly el: Element; readonly disposable?: IDisposable } | undefined;
	/** Next in <project> once the session is done (patches/dispatch-nextup.patch's line). */
	private _nextUp!: DispatchNextUpView;
	/** The tab is shorter than 120 (the side chat's pane under it, task-5im8n): the head is one line, which a click
	 *  puts the side chat's line back from. */
	private _oneLine = false;
	/** The agent's line in the head, for the one line's tooltip. */
	private _sayText = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IChatService private readonly _chatService: IChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@IDispatchWalkService private readonly _walkService: IDispatchWalkService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(DispatchNowEditor.ID, group, telemetryService, themeService, _storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, dom.$('.dispatch-now-tab'));
		this._root.tabIndex = -1;
		this._nextUp = this._register(this._instantiationService.createInstance(DispatchNextUpView));
		this._register(this._nextUp.onDidChange(() => this.isVisible() && this.render()));
		this._register(toDisposable(() => this._mark?.disposable?.dispose()));
		// one line (the side chat's pane took the room): a click puts the line between them back where it starts
		this._register(dom.addDisposableListener(this._root, dom.EventType.CLICK, () => {
			if (this._oneLine) {
				void this._commandService.executeCommand(DISPATCH_SIDE_CHAT_RESET_SPLIT_COMMAND);
			}
		}));
		// a task link in the conversation: its row opens here, in place (task-ewbvh)
		this._register(autorun(reader => {
			const reveal = dispatchNowReveal.read(reader);
			if (reveal && reveal.session === this._sessionsService.activeSession.get()?.resource.toString()) {
				this._reveal = reveal;
				this._lastSig = '';
				this.render();
			}
		}));
		// Waiting for you says what the session asks: the head follows it
		this._register(autorun(reader => {
			dispatchWaitingVisible.read(reader);
			if (this.isVisible()) {
				this.render();
			}
		}));
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			session?.status.read(reader);
			session?.modelId.read(reader);
			if (this.isVisible()) {
				void this.refresh();
			}
		}));
		// the agents it sent out: one sent, one back
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			const provided = session && (this._sessionsManagementService.getSession(session.resource) ?? session);
			for (const chat of provided ? subAgentsOf(provided, reader) : []) {
				subAgentState(chat, reader);
				chat.title.read(reader);
			}
			if (this.isVisible()) {
				this.render();
			}
		}));
		this._register(this._accessibilityService.onDidChangeReducedMotion(() => this.isVisible() && this.render()));
		// the why line (task-39x97): the agent's opening words come in as it writes them; the head follows, at most every 500 ms
		const replyWatch = this._register(new MutableDisposable<DisposableStore>());
		const redraw = this._register(new RunOnceScheduler(() => this.isVisible() && this.render(), 500));
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			const request = session ? this._chatService.getSession(session.mainChat.read(reader).resource)?.lastRequestObs.read(reader) : undefined;
			const store = new DisposableStore();
			replyWatch.value = store;
			if (request?.response) {
				store.add(request.response.onDidChange(() => redraw.schedule()));
			}
			redraw.schedule();
		}));
		// Walk me through comes in the head's buttons once a turn that changed files has ended (task-fktjx)
		this._register(autorun(reader => {
			this._walkService.offer.read(reader);
			if (this.isVisible()) {
				this.render();
			}
		}));
		const timer = mainWindow.setInterval(() => {
			if (this.isVisible() && mainWindow.document.visibilityState === 'visible' && !isDispatchWindowIdle()) {
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
		if (visible) {
			void this.refresh();
		}
	}

	override focus(): void {
		this._root?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		this._oneLine = dimension.height < NOW_ONE_LINE_BELOW;
		this.syncOneLine();
	}

	/** The head as one line (design/side-chat-now B1): the state's mark, the agent's line cut to one, the step. */
	private syncOneLine(): void {
		this._root.classList.toggle('one-line', this._oneLine);
		this._root.title = this._oneLine ? this._sayText : '';
		if (this._oneLine) {
			this._root.setAttribute('aria-label', localize('dispatchNow.oneLineAria', "{0}. Click for the default split", this._sayText));
		} else {
			this._root.removeAttribute('aria-label');
		}
	}

	async refresh(): Promise<void> {
		this._nextUp?.ensure();
		const session = this._sessionsService.activeSession.get();
		const key = session?.resource.toString() ?? '';
		if (key !== this._key) {
			this._key = key;
			this._root.dataset.session = key; // which session this tab speaks for (tests and tools read it)
			this._data = SEEN.get(key);
			this._taskOpen.clear();
			this._folds.clear();
			this._terminalLine = '';
			this.render();
		}
		if (!key || session?.status.get() === SessionStatus.Untitled) {
			return;
		}
		// one read at a time: on a busy Mac a read can take longer than the 6 s between rounds, and a newer read
		// must not keep throwing the older answers away; one more round follows when something asked meanwhile
		if (this._reading === key) {
			this._readAgain = true;
			return;
		}
		this._reading = key;
		try {
			await this.read(session, key);
		} finally {
			this._reading = undefined;
		}
		if (this._readAgain) {
			this._readAgain = false;
			void this.refresh();
		}
	}

	private async read(session: ISession | undefined, key: string): Promise<void> {
		const id = ++this._requestId;
		let data: IDispatchNow;
		const provided = session && this._sessionsManagementService.getSession(session.resource);
		const screen = session && terminalAgent(session, provided) !== undefined ? terminalScreen(provided) : undefined;
		try {
			// what the process is on costs a look at every running session: only while this one works or waits
			const status = session?.status.get();
			const live = status === SessionStatus.InProgress || status === SessionStatus.NeedsInput;
			const [answer, text] = await Promise.all([
				this._commandService.executeCommand<IDispatchNow>('dispatch.now', { session: key, live }),
				screen ? screen.text(60) : Promise.resolve(''),
			]);
			data = answer ?? { error: 'no answer' };
			this._terminalLine = screen ? lastTerminalLine(text) : '';
		} catch (e) {
			data = { error: String(e) };
		}
		if (id !== this._requestId || key !== this._key) {
			return;
		}
		if (data.error && this._data && !this._data.error) {
			return; // keep what was shown; the next round tries again
		}
		this._data = data;
		if (!data.error) {
			SEEN.delete(key);
			SEEN.set(key, data);
			if (SEEN.size > 40) {
				SEEN.delete(SEEN.keys().next().value!);
			}
		}
		this.render();
	}

	/**
	 * The person stopped the session's last turn. The conversation says so only while it stays loaded, so the turn is
	 * kept in the window's storage (dispatchNowModel.ts stoppedByPerson): the head still reads Stopped after a switch
	 * to another session and after a reload, until a later turn is there.
	 */
	private stopped(session: ISession, idle: boolean): boolean {
		const requests = this._chatService.getSession(session.mainChat.get().resource)?.getRequests();
		let marks: Record<string, number> = {};
		try {
			marks = JSON.parse(this._storageService.get(STOPPED_KEY, StorageScope.APPLICATION, '{}'));
		} catch {
			// unreadable: as if nothing was kept
		}
		const key = session.resource.toString();
		const { canceled, mark } = stoppedByPerson({ idle, requests: requests?.length, lastCanceled: !!requests?.at(-1)?.response?.isCanceled, marked: marks[key] });
		if (mark !== marks[key]) {
			delete marks[key];
			if (mark !== undefined) {
				marks[key] = mark;
			}
			const keys = Object.keys(marks);
			for (const old of keys.slice(0, Math.max(0, keys.length - STOPPED_KEPT))) {
				delete marks[old];
			}
			this._storageService.store(STOPPED_KEY, JSON.stringify(marks), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return canceled;
	}

	/** The state the head shows: the session's own, or Waiting for you when something of it waits on the person. */
	private headFacts(session: ISession, provided: ISession): IHeadFacts {
		const status = statusOf(session.status.get());
		const waiting = dispatchWaitingVisible.get();
		const row = findWaitingItem(waiting, session.resource);
		const asked = row && (row.kind === 'approve' || row.kind === 'decide') ? row : undefined;
		const open = new Set((this._data?.session_tasks ?? []).filter(t => t.status !== 'done').map(t => t.id));
		if (this._data?.task && this._data.task.status !== 'done') {
			open.add(this._data.task.id);
		}
		const design = waiting?.items.find(i => isDesignDecide(i) && !!i.task && open.has(i.task));
		const canceled = this.stopped(session, status === 'idle');
		const mode = nowMode({
			terminal: terminalAgent(session, provided) !== undefined,
			status,
			asks: !!asked || !!design || this._data?.task?.status === 'waiting',
			canceled,
			unfinished: isUnfinished(this._data?.task),
		});
		return { mode, status, asked, design, canceled };
	}

	/**
	 * What the turn is running this moment, from the conversation the window draws: the newest tool call not finished
	 * ("Count to 1500 A" for a sub-agent, the command it runs). The process's own word for OpenCode in this window is a
	 * bare "Working"; this says which step.
	 */
	private runningTool(session: ISession): string {
		return runningStep(replyParts(this._chatService, session.mainChat.get().resource));
	}

	/** What the agent wrote at the start of its last turn before it did anything (dispatchExplainModel's openingWords). */
	private opening(session: ISession): string {
		const parts = this._chatService.getSession(session.mainChat.get().resource)?.getRequests().at(-1)?.response?.response.value ?? [];
		const pieces: ITurnPiece[] = parts.map(p => p.kind === 'markdownContent' ? { kind: 'text', text: p.content.value }
			: p.kind === 'toolInvocation' || p.kind === 'toolInvocationSerialized' || p.kind === 'externalEdit' || p.kind === 'textEditGroup' ? { kind: 'call' } : { kind: 'other' });
		// what the turn is made of, for tests and tools: "text call call text other"
		this._pieces = parts.map(p => p.kind).join(' ');
		return openingWords(pieces);
	}

	/** When the turn it is on started (the last message sent), from the conversation's own record. */
	private turnStartedAt(session: ISession): number | undefined {
		return this._chatService.getSession(session.mainChat.get().resource)?.getRequests().at(-1)?.timestamp;
	}

	private render(): void {
		const session = this._sessionsService.activeSession.get();
		const d = this._data;
		const provided = session && (this._sessionsManagementService.getSession(session.resource) ?? session);
		const facts = session && provided ? this.headFacts(session, provided) : undefined;
		const still = this._accessibilityService.isMotionReduced();
		const agentsSig = provided ? subAgentsOf(provided).map(c => [c.resource.toString(), subAgentState(c), c.title.get()]) : []; // the pills keep their own clocks
		// what the head and the rows show; the live part without its clock, which moves every round
		const shown = d && { ...d, live: d.live && { status: d.live.status, doing: d.live.doing, said: d.live.said } };
		const sig = JSON.stringify([this._key, shown, session?.status.get(), session?.modelId.get(), Math.floor(Date.now() / 60000), facts && [facts.mode, facts.canceled, facts.asked?.id, facts.asked && waitingDetail(facts.asked), facts.design?.id, facts.design?.open],
			facts?.mode === 'done' ? this._nextUp?.signature() : '', agentsSig, this.walkStops(session), [...this._taskOpen], [...this._folds], this._terminalLine, still, session && this.turnStartedAt(session), session ? this.opening(session) : '', facts?.mode === 'working' && session ? this.runningTool(session) : '', session?.lastTurnEnd.get()?.getTime()]);
		if (sig === this._lastSig) {
			this._pills.forEach(pill => pill.update()); // the step a sub-agent is on, on the pills there are
			return;
		}
		this._lastSig = sig;
		this._renderStore.clear();
		this._pills = [];
		dom.clearNode(this._root);
		if (!session || !provided || !facts) {
			this.empty(localize('dispatchNow.noSession', "Nothing open"), localize('dispatchNow.noSessionMore', "Open a session to see what it is doing."));
			return;
		}
		if (session.status.get() === SessionStatus.Untitled) {
			// a new chat's side pane: nothing has happened yet, say how it starts (task-qx5ln)
			this.empty(localize('dispatchNow.newSession', "Nothing here yet"), localize('dispatchNow.newSessionMore', "Send a message to start. What the agent is doing, its plan and what it delivers show up here."));
			return;
		}

		this._mode = facts.mode;
		// the board's answer is not in yet and the session is at rest: whether it is done, paused or waits for the person
		// is not known, so the head does not guess (it said "Done" for a second or two on every switch); quiet bars instead
		if (!d && facts.status === 'idle' && facts.mode !== 'terminal') {
			const sk = dom.append(this._root, dom.$('section.dispatch-now-top.dispatch-now-skeleton'));
			sk.dataset.part = 'now-head-loading';
			sk.setAttribute('aria-busy', 'true');
			sk.setAttribute('aria-label', localize('dispatchNow.looking', "Looking..."));
			for (const w of [38, 72, 24]) {
				dom.append(sk, dom.$('span')).style.width = `${w}%`;
			}
			return;
		}
		this.head(session, provided, facts, still);

		if (!d) {
			return;
		}
		if (d.error) {
			// why, in the CLI's own first line, and a way to try at once (it also tries again by itself every round)
			const failed = dom.append(this._root, dom.$('.dispatch-now-empty.dispatch-now-failed'));
			failed.dataset.part = 'failed';
			dom.append(failed, dom.$('b', undefined, localize('dispatchNow.errorHead', "Can't read the task board")));
			const why = d.error.split('\n').map(l => l.trim()).find(Boolean) ?? '';
			dom.append(failed, dom.$('span.dispatch-now-why', undefined, why.length > 160 ? `${why.slice(0, 159)}…` : why));
			dom.append(failed, dom.$('span', undefined, localize('dispatchNow.errorAgain', "Trying again every few seconds.")));
			const again = dom.append(failed, dom.$<HTMLButtonElement>('button.dispatch-now-retry', { type: 'button' }, localize('dispatchNow.tryAgain', "Try again")));
			this._renderStore.add(dom.addDisposableListener(again, dom.EventType.CLICK, () => {
				again.disabled = true;
				void this.refresh().finally(() => again.disabled = false);
			}));
			return;
		}
		const tasks = d.session_tasks ?? (d.task ? [d.task] : []);
		const agents = subAgentsOf(provided);
		if (!tasks.length && !agents.length) {
			const none = dom.append(this._root, dom.$('.dispatch-now-empty'));
			dom.append(none, dom.$('b', undefined, localize('dispatchNow.noTask', "No task yet")));
			dom.append(none, dom.$('span', undefined, localize('dispatchNow.noTaskMore', "When the agent starts a task here, its steps and what it delivers show up in this tab.")));
			return;
		}

		// the tasks: the one it is on first and open, the others not finished under it; no heading over them
		const { rows, done } = splitTasks(tasks, d.task?.id);
		// a task link in the conversation: its row opens (in Done in this session too), comes into view and flashes once
		const reveal = this._reveal && Date.now() - this._reveal.at < 10_000 ? this._reveal : undefined;
		if (reveal && tasks.some(t => t.id === reveal.id)) {
			this._reveal = undefined;
			this._taskOpen.set(reveal.id, true);
			if (done.some(t => t.id === reveal.id)) {
				this._folds.add('done');
			}
			dom.getWindow(this._root).requestAnimationFrame(() => {
				const row = this._root.querySelector<HTMLElement>(`.dispatch-now-task[data-task="${CSS.escape(reveal.id)}"]`);
				row?.scrollIntoView({ block: 'nearest' });
				row?.classList.add('flash');
			});
		}
		// in the order they were sent out, as in the conversation, the strip and the sidebar
		const working = agents.filter(c => subAgentState(c) === 'sub-agent');
		const back = agents.filter(c => subAgentState(c) !== 'sub-agent');
		const current = rows.find(t => t.id === d.task?.id);
		// the sub-agents hang under the step it is on; with no step to hang from they come first, on their own
		const anchored = !!current && current.status !== 'done' && agentAnchor(current.plan ?? []) >= 0;
		const plan = dom.append(this._root, dom.$('section.dispatch-now-sec'));
		plan.dataset.part = 'now-plan';
		if (agents.length && !anchored) {
			const list = dom.append(plan, dom.$('ol.dispatch-now-steps.dispatch-now-agents'));
			this.agentRows(list, provided, working, back, false);
		}
		for (const t of rows) {
			this.taskRow(plan, t, t === current, still, t === current && anchored ? { session: provided, working, back } : undefined);
		}

		// what is over or comes next, folded
		const handoffs = d.handoffs ?? [];
		const project = projectOfSession(session, dispatchProjectsRegistry.get())?.project;
		const next = facts.mode === 'done' && project ? (this._nextUp?.line?.next ?? []).filter(r => r.project === project.name || r.project === project.label) : [];
		if (done.length || next.length || handoffs.length) {
			const folds = dom.append(this._root, dom.$('section.dispatch-now-sec'));
			folds.dataset.part = 'now-folds';
			if (done.length) {
				this.fold(folds, 'done', localize('dispatchNow.doneHere', "Done in this session"), done.length, body => {
					for (const t of done) {
						this.taskRow(body, t, false, still, undefined);
					}
				});
			}
			if (next.length && project) {
				this.fold(folds, 'next', localize('dispatchNow.nextIn', "Next in {0}", project.label || project.name), next.length, body => {
					const list = dom.append(body, dom.$('ol.dispatch-now-steps.dispatch-now-next'));
					for (const r of next) {
						const li = dom.append(list, dom.$('li.dispatch-now-step.todo.link'));
						const b = dom.append(li, dom.$<HTMLButtonElement>('button.dispatch-now-rowbtn', { type: 'button', title: localize('dispatchNow.openNext', "Open this task") }));
						b.dataset.task = r.id;
						dom.append(b, dom.$('span.dispatch-now-slot')).appendChild(stateMark('todo'));
						dom.append(b, dom.$('span.dispatch-now-words', undefined, withoutTaskId(r.title)));
						this._renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this._commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, r.id)));
					}
				});
			}
			if (handoffs.length) {
				// only once the work was handed over: a fresh session that took the notes (never "0" as bookkeeping)
				this.fold(folds, 'handoffs', localize('dispatchNow.handedOver', "Handed over"), handoffs.length, body => {
					const list = dom.append(body, dom.$('ol.dispatch-now-steps.dispatch-now-handoffs'));
					for (const h of handoffs.slice().reverse()) {
						const li = dom.append(list, dom.$('li.dispatch-now-step.done'));
						dom.append(li, dom.$('span.dispatch-now-slot')).appendChild(icon(DispatchBlockIcons['pass-on']));
						dom.append(li, dom.$('span.dispatch-now-words', undefined, localize('dispatchNow.handoffRow', "To a fresh session, the notes went along")));
						dom.append(li, dom.$('span.dispatch-now-time', undefined, ago(h.at)));
					}
				});
			}
		}
	}

	// ---- the head: state, the line, and Right now / the terminal's last line / the buttons ----------------------

	private head(session: ISession, provided: ISession, facts: IHeadFacts, still: boolean): void {
		const d = this._data;
		const { mode } = facts;
		const top = dom.append(this._root, dom.$('section.dispatch-now-top'));
		top.dataset.part = 'now-head';
		top.dataset.mode = mode;
		top.dataset.pieces = this._pieces;

		// 1. the state, the step, how long; the engine and model when pointed at
		const line = dom.append(top, dom.$('.dispatch-now-status'));
		line.dataset.part = 'status';
		dom.append(line, dom.$('span.dispatch-now-slot')).appendChild(this.markFor(mode, still));
		const name = engineName(session, provided);
		const model = session.modelId.get();
		line.title = model ? `${name} · ${model.split('/').pop()}` : name;
		const now = Date.now();
		const words: string[] = [];
		const inTerminal = terminalAgent(session, provided);
		if (mode === 'working') {
			words.push(localize('dispatchNow.stateWorking', "Working"));
			const step = d?.task && d.task.status !== 'done' ? stepOf(d.task.plan ?? []) : undefined;
			if (step) {
				words.push(localize('dispatchNow.step', "step {0} of {1}", step.at, step.of));
			}
			const started = this.turnStartedAt(session);
			if (started) {
				words.push(spanWords(spanOf(now - started)));
			}
		} else if (mode === 'waiting') {
			words.push(localize('dispatchNow.stateWaiting', "Waiting for you"));
			const item = facts.asked ?? facts.design;
			// when it last moved, the same clock as its row under Waiting for you (dispatchWaitingGroups.ts)
			const at = item ? waitingChangedAt(item) : 0;
			if (at) {
				words.push(spanWords(spanOf(now - at * 1000)));
			}
		} else if (mode === 'done' || mode === 'stopped' || mode === 'paused') {
			words.push(mode === 'done' ? localize('dispatchNow.stateDone', "Done") : mode === 'paused' ? localize('dispatchNow.statePaused', "Paused") : localize('dispatchNow.stateStopped', "Stopped"));
			const step = mode === 'paused' && d?.task ? stepOf(d.task.plan ?? []) : undefined;
			if (step) {
				words.push(localize('dispatchNow.step', "step {0} of {1}", step.at, step.of));
			}
			const end = session.lastTurnEnd.get() ?? session.updatedAt.get();
			if (end) {
				words.push(agoWords(spanOf(now - end.getTime())));
			}
		} else {
			words.push(localize('dispatchNow.stateTerminal', "In the terminal"));
			words.push(spanWords(spanOf(now - session.createdAt.getTime())));
		}
		dom.append(line, dom.$('span.dispatch-now-state', undefined, words.join(' · ')));

		// 2. the line: what the agent wrote itself, else what the window knows
		// while it works, a line written before this turn began is about an earlier turn: it does not lead
		const turn = mode === 'working' ? this.turnStartedAt(session) : undefined;
		const own = d?.now?.text && !(turn && d.now.at && d.now.at * 1000 < turn) ? withoutTaskId(d.now.text) : '';
		// the process's step in plain words; a bare "Working" says no more than the status line above it, the tool call the
		// conversation is running does
		const said = d?.live && d.live.status !== 'idle' && mode !== 'stopped' && !/^(working|thinking)\W*$/i.test(d.live.doing.trim()) ? d.live.doing.trim() : '';
		const doing = said || (mode === 'working' ? this.runningTool(session) : '');
		const asked = facts.asked ? waitingDetail(facts.asked) : facts.design ? withoutTaskId(facts.design.title) : '';
		const say = mode === 'waiting' ? asked || own || localize('dispatchNow.waiting', "Waiting for you.")
			: mode === 'working' ? own || doing || localize('dispatchNow.working', "Working on your request.")
				: mode === 'stopped' ? (inTerminal !== undefined ? localize('dispatchNow.stoppedTerminal', "Stopped. Type in the terminal to go on.") : facts.canceled ? localize('dispatchNow.stoppedByYou', "You stopped it. Send a message to go on.") : localize('dispatchNow.stopped', "Stopped. Send a message to try again."))
					: mode === 'terminal' ? own || (session.status.get() === SessionStatus.InProgress && inTerminal ? localize('dispatchNow.runningTerminal', "{0} is running", inTerminal.name)
						: inTerminal ? localize('dispatchNow.readyTerminal', "{0} is open in the terminal and ready. Type there to give it something to do.", inTerminal.name)
							: localize('dispatchNow.plainTerminal', "A terminal in this project. Type a command there."))
						: own || (d?.task ? withoutTaskId(d.task.title) : d ? localize('dispatchNow.resting', "Finished its last turn. Send a message to go on.") : localize('dispatchNow.looking', "Looking..."));
		const sayEl = dom.append(top, dom.$('.dispatch-now-say', undefined, say));
		sayEl.dataset.part = 'say';
		this._sayText = say;
		// the step it is on, for the head's one line ("3/5")
		const at = d?.task && d.task.status !== 'done' ? stepOf(d.task.plan ?? []) : undefined;
		if (at) {
			dom.append(top, dom.$('span.dispatch-now-count', { 'data-part': 'now-count' }, `${at.at}/${at.of}`));
		}
		this.syncOneLine();
		if (!own && d && !d.error && mode !== 'waiting') {
			sayEl.title = localize('dispatchNow.howTo', "The agent writes this line itself with dispatch now \"…\" when it moves on to a new step.");
		}

		// 2b. why, in plain words (task-39x97, design/learn-scene frame 1): only what the agent itself said this turn
		// (its own line when the head shows something else, else what it wrote before it began); nothing else asks a model
		const started = this.turnStartedAt(session);
		const ownInTurn = d?.now?.text && d.now.at && started && d.now.at * 1000 >= started ? withoutTaskId(d.now.text) : '';
		const why = mode === 'terminal' ? undefined : nowWhy({ own: ownInTurn, say, opening: this.opening(session) });
		const terms = { hoverService: this._hoverService, commandService: this._commandService, configurationService: this._configurationService };
		const reply = `now:${session.resource.toString()}`;
		this._renderStore.add(markDispatchTermsWith(terms, sayEl, reply, 0));
		if (why) {
			const whyEl = dom.append(top, dom.$('.dispatch-now-why', undefined, why.text));
			whyEl.dataset.part = 'why';
			// where it came from, for tests and tools; no tooltip of its own (the words in it have theirs)
			whyEl.dataset.from = why.from;
			this._renderStore.add(markDispatchTermsWith(terms, whyEl, reply, 1));
		}

		// 3. what goes under it
		if (mode === 'working' && own && doing && doing !== own) {
			const sub = dom.append(top, dom.$('.dispatch-now-sub.shimmer', undefined, localize('dispatchNow.rightNow', "Right now: {0}", doing)));
			sub.dataset.part = 'right-now';
			sub.title = doing;
			sub.style.setProperty('--now-phase', `-${Date.now() % SHIMMER_MS}ms`);
		} else if (mode === 'terminal' && this._terminalLine) {
			const sub = dom.append(top, dom.$('.dispatch-now-sub.mono', undefined, this._terminalLine));
			sub.dataset.part = 'terminal-line';
			sub.title = this._terminalLine;
		} else if (mode === 'waiting') {
			const buttons = dom.append(top, dom.$('.dispatch-now-btns'));
			buttons.dataset.part = 'buttons';
			const proposal = facts.design?.open ? facts.design : undefined;
			const page = proposal ? undefined : d?.task ? deliveryPage(d.task.deliverables, 'Proposal') : undefined;
			if (proposal || page) {
				this.button(buttons, localize('dispatchNow.openProposal', "Open proposal"), 'fill', () => proposal
					// the same as its row in Waiting for you: the prototype in this pane, next to the page
					? this._commandService.executeCommand('_dispatch.openPath', proposal.open, { fromDocs: true, task: proposal.task })
					: this._instantiationService.invokeFunction(openDeliverable, page!, d?.task?.id));
			}
			this.button(buttons, localize('dispatchNow.reply', "Reply"), proposal || page ? 'outline' : 'fill', () => this.reply(session));
		} else if (mode === 'paused' || (mode === 'stopped' && facts.canceled)) {
			// stopped with steps left: answer it to go on, or look at what it changed; no solid button
			const buttons = dom.append(top, dom.$('.dispatch-now-btns'));
			buttons.dataset.part = 'buttons';
			this.button(buttons, localize('dispatchNow.reply', "Reply"), 'outline', () => this.reply(session));
			this.walkButton(buttons, session, 'ghost');
			if (!session.isQuickChat?.get() && !!session.workspace.get()) {
				this.button(buttons, localize('dispatchNow.seeChanges', "See changes"), 'ghost', () => this._commandService.executeCommand(VIEW_SESSION_CHANGES_COMMAND_ID));
			}
		} else if (mode === 'done') {
			// the newest delivery page of the session: the task it was on last can be another (a request noted from the chat)
			const pages = (d?.session_tasks ?? (d?.task ? [d.task] : [])).map(t => ({ t, page: deliveryPage(t.deliverables, 'Delivery page') })).filter(x => !!x.page);
			const newest = pages.sort((a, b) => (b.page!.at ?? 0) - (a.page!.at ?? 0))[0];
			const page = newest?.page;
			const pageTask = newest?.t.id;
			// the Changes tab is there for a session in a folder, never for a chat (singlePaneDockedTabsCoordinator)
			const changes = !session.isQuickChat?.get() && !!session.workspace.get();
			if (page || changes) {
				const buttons = dom.append(top, dom.$('.dispatch-now-btns'));
				buttons.dataset.part = 'buttons';
				if (page) {
					this.button(buttons, localize('dispatchNow.openDelivery', "Open delivery page"), 'outline', () => this._instantiationService.invokeFunction(openDeliverable, page, pageTask));
				}
				// the turn that just ended, stop by stop (frame 5 of design/learn-scene: before See changes)
				this.walkButton(buttons, session, page ? 'ghost' : 'outline');
				if (changes) {
					// next to Walk me through it is the quieter one (designer review, task-fktjx)
					this.button(buttons, localize('dispatchNow.seeChanges', "See changes"), page || this.walkStops(session) ? 'ghost' : 'outline', () => this._commandService.executeCommand(VIEW_SESSION_CHANGES_COMMAND_ID));
				}
			}
		}
	}

	/** The mark in front of the state: the falling blocks of the session row, VS Code's round state icons (dispatchMarks.ts), ">_". */
	private markFor(mode: NowMode, still: boolean): Element {
		const key = `${mode}|${still}`;
		if (this._mark?.key === key) {
			return this._mark.el; // the same node: its blocks keep falling where they were
		}
		this._mark?.disposable?.dispose();
		let el: Element;
		let disposable: IDisposable | undefined;
		switch (mode) {
			case 'working': {
				const blocks = createDispatchBlocks(still ? 'still' : 'running');
				el = blocks.element;
				disposable = blocks.disposable;
				break;
			}
			case 'waiting': el = stateMark('waiting'); break;
			case 'paused': el = stateMark('stop'); break;
			case 'stopped': el = stateMark('stopped'); break;
			case 'done': el = stateMark('done'); break;
			case 'terminal': el = terminalGlyph(); break;
		}
		this._mark = { key, el, disposable };
		return el;
	}

	/** How many stops the walk of this session's last turn has; 0 when there is none. */
	private walkStops(session: ISession | undefined): number {
		const offer = this._walkService.offer.get();
		return session && offer?.sessionId === session.sessionId ? offer.stops : 0;
	}

	/** Walk me through, when the turn that ended changed files (the same walk as the pill in the corner, task-fktjx). */
	private walkButton(parent: HTMLElement, session: ISession, kind: 'outline' | 'ghost'): void {
		if (this.walkStops(session)) {
			const b = this.button(parent, localize('dispatchNow.walk', "Walk me through"), kind, () => this._walkService.start());
			b.dataset.part = 'walk-me-through';
		}
	}

	private button(parent: HTMLElement, label: string, kind: 'fill' | 'outline' | 'ghost', run: () => Promise<unknown> | unknown): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>(`button.dispatch-now-btn.${kind}`, { type: 'button' }, label));
		this._renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => {
			Promise.resolve(run()).catch(onUnexpectedError);
		}));
		return b;
	}

	/** Reply: the cursor in the session's message box (its main conversation, not a sub-agent's). */
	private async reply(session: ISession): Promise<void> {
		const main = session.mainChat.get();
		const active = (session as IActiveSession).activeChat?.get();
		if (active && active.resource.toString() !== main.resource.toString()) {
			await this._sessionsService.openChat(session, main.resource);
		}
		const widget = await whenChatWidgetForSession(this._chatWidgetService, main.resource);
		widget?.focusInput();
	}

	// ---- tasks: a row each, its steps on one line, its sub-agents and deliveries under them ------------------------

	private taskRow(parent: HTMLElement, t: INowTask, current: boolean, still: boolean, agents: { readonly session: ISession; readonly working: IChat[]; readonly back: IChat[] } | undefined): void {
		const plan = t.plan ?? [];
		const delivered = t.deliverables ?? [];
		const title = withoutTaskId(t.title);
		const hasBody = plan.length > 0 || delivered.length > 0 || !!agents;
		const open = hasBody && (this._taskOpen.get(t.id) ?? current);
		const row = dom.append(parent, dom.$('.dispatch-now-task'));
		row.dataset.task = t.id;
		row.classList.toggle('current', current);
		row.classList.toggle('done', t.status === 'done');
		const caret = dom.append(row, dom.$<HTMLButtonElement>('button.dispatch-now-caret', { type: 'button' }));
		caret.appendChild(icon(Codicon.chevronRight));
		// the title opens and closes the steps in place, as the caret does; it no longer goes to the Tasks tab (the person,
		// 2026-11-16, task-ewbvh). The caret is the one stop for the keyboard and the screen reader, so a row is one stop.
		const label = dom.append(row, dom.$('span.dispatch-now-title', { title }, title));
		if (hasBody) {
			this._renderStore.add(dom.addDisposableListener(label, dom.EventType.CLICK, () => caret.click()));
		} else {
			label.classList.add('static');
		}
		const done = plan.filter(p => p.state === 'done').length;
		const count = t.status === 'done' ? localize('dispatchNow.taskDone', "Done") : plan.length ? localize('dispatchNow.planCount', "{0} of {1}", done, plan.length) : '';
		if (count) {
			dom.append(row, dom.$('span.dispatch-now-count', undefined, count));
		}
		if (!hasBody) {
			caret.disabled = true;
			caret.setAttribute('aria-hidden', 'true');
			caret.tabIndex = -1;
			return;
		}
		const body = dom.append(parent, dom.$('.dispatch-now-body'));
		body.dataset.task = t.id;
		const inner = dom.append(body, dom.$('.dispatch-now-body-in'));
		this.bindToggle(caret, body, open, opened => this._taskOpen.set(t.id, opened), {
			open: localize('dispatchNow.showSteps', "Show the steps of {0}", title),
			close: localize('dispatchNow.hideSteps', "Hide the steps of {0}", title),
		});

		// the steps on one thin line; the sub-agents under the step it is on
		// the task it is on takes the head's state: the green filled circle only while it runs, amber while it waits for the person
		// (Waiting for you can know before the board does), the large ring where it paused
		const kinds = stepKinds(plan, t.status, current ? this._mode : undefined);
		const anchor = agents ? agentAnchor(plan) : -1;
		if (plan.length) {
			const list = dom.append(inner, dom.$('ol.dispatch-now-steps'));
			list.dataset.part = 'steps';
			plan.forEach((p, i) => {
				this.stepRow(list, p.text, kinds[i], i, plan.length, t.status !== 'done' && this._sessionWorking(), still);
				if (agents && i === anchor) {
					this.agentRows(list, agents.session, agents.working, agents.back, i < plan.length - 1);
				}
			});
		} else if (agents) {
			this.agentRows(dom.append(inner, dom.$('ol.dispatch-now-steps.dispatch-now-agents')), agents.session, agents.working, agents.back, false);
		}

		// what it delivered: its last rows, no box
		if (delivered.length) {
			const list = dom.append(inner, dom.$('ul.dispatch-now-dls'));
			list.dataset.part = 'delivered';
			for (const dl of delivered) {
				const li = dom.append(list, dom.$('li'));
				const b = dom.append(li, dom.$<HTMLButtonElement>('button.dispatch-now-rowbtn.dispatch-now-dl', { type: 'button', title: deliverableTooltip(dl) }));
				b.dataset.kind = dl.kind;
				dom.append(b, dom.$('span.dispatch-now-slot')).appendChild(icon(deliverableIcon(dl)));
				dom.append(b, dom.$('span.dispatch-now-words', undefined, deliverableLabel(dl)));
				if (dl.at) {
					dom.append(b, dom.$('span.dispatch-now-time', undefined, ago(dl.at)));
				}
				this._renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => void this._instantiationService.invokeFunction(openDeliverable, dl, t.id)));
			}
		}
	}

	private _sessionWorking(): boolean {
		return this._sessionsService.activeSession.get()?.status.get() === SessionStatus.InProgress;
	}

	/** A step: 28 high, its mark in a 14 slot on the line that runs from the first step to the last. */
	private stepRow(list: HTMLElement, text: string, kind: NowStepKind, i: number, n: number, live: boolean, still: boolean): void {
		const li = dom.append(list, dom.$(`li.dispatch-now-step.${kind}`));
		li.classList.toggle('first', i === 0);
		li.classList.toggle('last', i === n - 1);
		// the marks of DESIGN.md「符号表」: a finished step the grey filled check, the one it is on the green filled circle
		// (breathing while it runs), waiting the amber one, where it stopped and not started the large ring
		const mark = kind === 'done' ? 'seen' : kind === 'ask' ? 'waiting' : kind;
		dom.append(li, dom.$('span.dispatch-now-slot')).appendChild(stateMark(mark, { live: kind === 'now' && live && !still }));
		dom.append(li, dom.$('span.dispatch-now-words', { title: text }, text));
		li.setAttribute('aria-label', `${kind === 'done' ? localize('dispatchNow.stepDone', "Done") : kind === 'now' ? localize('dispatchNow.stepNow', "Doing this now") : kind === 'ask' ? localize('dispatchNow.stepAsk', "Waiting for you") : kind === 'stop' ? localize('dispatchNow.stepStop', "Stopped here") : localize('dispatchNow.stepTodo', "Not started")}: ${text}`);
	}

	/**
	 * The sub-agents as the strip above the message box and the sidebar show them (task-518qw): "2 agents working",
	 * VS Code's pill for each that works, "N finished" opening the ones back in place. `through`: the steps' line goes on.
	 */
	private agentRows(list: HTMLElement, session: ISession, working: readonly IChat[], back: readonly IChat[], through: boolean): void {
		if (!working.length && !back.length) {
			return; // nothing sent out: no block, the steps keep their 28
		}
		const li = dom.append(list, dom.$('li.dispatch-now-agents-block'));
		li.dataset.part = 'now-subagents';
		li.classList.toggle('through', through);
		if (working.length) {
			renderWorkingHead(li, working.length);
		}
		this._pills.push(...renderSubAgentList(li, session, working, back, this._folds.has('finished'), this._renderStore, this._instantiationService, () => {
			if (!this._folds.delete('finished')) {
				this._folds.add('finished');
			}
			this.render();
		}));
	}

	// ---- folds -------------------------------------------------------------------------------------------------

	/** "Done in this session  2": a caret, the words, the count; it opens in place. */
	private fold(parent: HTMLElement, id: string, label: string, count: number, fill: (body: HTMLElement) => void): void {
		const b = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-now-fold', { type: 'button' }));
		b.dataset.part = `fold-${id}`;
		b.appendChild(icon(Codicon.chevronRight));
		dom.append(b, dom.$('span.dispatch-now-fold-label', undefined, label));
		dom.append(b, dom.$('span.dispatch-now-count', undefined, String(count)));
		const body = dom.append(parent, dom.$('.dispatch-now-body'));
		body.dataset.part = `fold-${id}-body`;
		fill(dom.append(body, dom.$('.dispatch-now-body-in')));
		this.bindToggle(b, body, this._folds.has(id), opened => opened ? this._folds.add(id) : this._folds.delete(id), {
			open: localize('dispatchNow.foldOpen', "{0}, {1}: show", label, count),
			close: localize('dispatchNow.foldClose', "{0}, {1}: hide", label, count),
		});
	}

	/**
	 * A caret or fold that opens `body` in place: the class flips on the nodes there are (the rows' height moves in
	 * 200 ms) without drawing the tab again; a closed body is inert, so the keyboard skips what is folded away.
	 */
	private bindToggle(button: HTMLButtonElement, body: HTMLElement, open: boolean, remember: (open: boolean) => void, aria: { readonly open: string; readonly close: string }): void {
		const set = (opened: boolean) => {
			button.classList.toggle('open', opened);
			button.setAttribute('aria-expanded', String(opened));
			button.setAttribute('aria-label', opened ? aria.close : aria.open);
			body.classList.toggle('open', opened);
			body.inert = !opened;
		};
		set(open);
		this._renderStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			const opened = !body.classList.contains('open');
			remember(opened);
			set(opened);
		}));
	}

	private empty(title: string, line: string): void {
		const e = dom.append(this._root, dom.$('.dispatch-now-empty'));
		dom.append(e, dom.$('b', undefined, title));
		dom.append(e, dom.$('span', undefined, line));
	}
}
