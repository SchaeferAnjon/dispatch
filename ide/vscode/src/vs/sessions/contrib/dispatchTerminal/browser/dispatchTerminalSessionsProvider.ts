/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: terminal sessions in the sessions list.
 *
 *  A terminal a person opens for a project (a plain one, or one running an agent's own text interface) is a
 *  session of its own kind: it sits in the sessions list next to the chat sessions, under its project, with the
 *  agent's mark (or a terminal) and "(terminal)" in its name, and selecting it shows the terminal where a chat
 *  would be (dispatchTerminalView.ts).
 *
 *  The terminals live in Dispatch's terminal daemon (kanban app/termd), not in this window: quitting Dispatch
 *  leaves them running, and the next window lists them again and shows each with what it printed meanwhile.
 *  After a Mac restart they come back from disk with their last screen and start again in the same folder; an
 *  agent that can go on with its conversation does (Claude Code with the id Dispatch gave it, Codex, OpenCode
 *  and Gemini with their latest one). Closing the session ends the terminal; quitting the shell removes it.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { ChatInteractivity, ChatOriginKind, IChat, ISession, ISessionCapabilities, ISessionType, ISessionWorkspace, ISessionWorkspaceBrowseAction, SessionStatus, SessionTypeAuthRequirement, toSessionId } from '../../../services/sessions/common/session.js';
import { IPreparedNewSession, ISendRequestOptions, ISessionChangeEvent, ISessionModelPickerOptions, ISessionModelsSnapshot, ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import { claudeSubAgents, claudeSubAgentsFolder, claudeTranscriptPath, ISubAgent, readSubAgentMeta } from './dispatchTerminalModel.js';
import { fillRecipe, ITermdSessionInfo, ITerminalAgent, ITerminalAgentMeta, launchFor, movePane, PaneCommand, PaneLayout, paneIds, PaneSide, removePane, sanePaneLayout, splitPane, stepPane, terminalSessionTitle } from './dispatchTerminalModel.js';
import { DispatchTerminalController } from './dispatchTerminalController.js';
import { TermdClient } from './termdClient.js';
import { folderDisplayName } from '../../../common/dispatchSeparateCopy.js';

export const DISPATCH_TERMINAL_PROVIDER_ID = 'dispatch-terminal';
export const DISPATCH_TERMINAL_SESSION_TYPE = 'dispatch-terminal';
export const DISPATCH_TERMINAL_SCHEME = 'dispatch-terminal';

/** True while the keyboard is in a terminal session's screen: ⌘V, ⌘K, ⌘F and the rest act on it. */
export const DispatchTerminalFocus = new RawContextKey<boolean>('dispatchTerminalFocus', false, 'Whether the keyboard is in a terminal session of the Agents window.');
/** The keyboard is in a pane a terminal session split off (not its first): ⌘W closes that pane. */
export const DispatchTerminalInPane = new RawContextKey<boolean>('dispatchTerminalInPane', false, 'Whether the keyboard is in a pane split off a terminal session (not its first one).');

const TERMINAL_SESSION_TYPE: ISessionType = {
	id: DISPATCH_TERMINAL_SESSION_TYPE,
	label: 'Terminal',
	icon: Codicon.terminal,
	authRequirement: SessionTypeAuthRequirement.None,
};

const WORKING_AFTER_MS = 1500;
/**
 * Dispatch IDE (terminal-start-not-working): an agent draws for a second or more as it starts up (OpenCode's screen,
 * Claude Code's banner), before anyone asked it anything. Until it has told a turn itself, drawing in its first
 * seconds is it starting, not working on a request.
 */
const AGENT_STARTING_MS = 8000;
/** How often a Claude Code terminal's record is looked at for sub-agents (only read when it grew). */
const SUB_AGENTS_MS = 3000;

const CAPABILITIES: ISessionCapabilities = { supportsMultipleChats: false, supportsRename: true, supportsDelete: true };

/** The agent's own mark (dispatchAgents/browser/dispatchAgentIcons.ts); a blank terminal keeps the terminal icon. */
function iconFor(agent: ITerminalAgentMeta | undefined): ThemeIcon {
	return agent ? agentIcon(agent.id) : Codicon.terminal;
}

/**
 * A sub-agent Claude Code sent out from a terminal session, as a chat of that session started by a tool (the way the
 * Agent Host gives a chat session's sub-agents): the sessions list draws it under the session
 * (browser/dispatchSubAgentRows.ts), and opening it shows its own record, read only (dispatchTerminalView.ts).
 */
export class DispatchSubAgentChat implements IChat {
	readonly resource: URI;
	readonly createdAt: Date;
	readonly title = observableValue<string>(this, '');
	readonly updatedAt = observableValue<Date>(this, new Date());
	readonly status = observableValue<SessionStatus>(this, SessionStatus.InProgress);
	readonly changes = constObservable([]);
	readonly checkpoints = constObservable(undefined);
	readonly modelId = observableValue<string | undefined>(this, undefined);
	readonly modelSource = constObservable(undefined);
	readonly mode = constObservable<{ readonly id: string; readonly kind: string } | undefined>(undefined);
	readonly isArchived = constObservable(false);
	readonly isRead = constObservable(true);
	readonly interactivity = constObservable(ChatInteractivity.ReadOnly);
	readonly description = constObservable(undefined);
	readonly lastTurnEnd = observableValue<Date | undefined>(this, undefined);
	readonly origin;
	readonly capabilities = constObservable({ canRename: false, canDelete: false });
	/** Its own record (agent-<id>.jsonl), once Claude Code has written it. */
	file: string | undefined;

	constructor(terminalId: string, readonly toolUseId: string, startedAt: number | undefined, parent: URI) {
		this.resource = URI.from({ scheme: DISPATCH_TERMINAL_SCHEME, path: `/${terminalId}`, fragment: `subagent/${toolUseId}` });
		this.createdAt = new Date(startedAt ?? Date.now());
		this.origin = { kind: ChatOriginKind.Tool, chat: parent };
	}

	update(sub: ISubAgent, model: string | undefined, file: string | undefined): boolean {
		const status = !sub.done ? SessionStatus.InProgress : sub.failed ? SessionStatus.Error : SessionStatus.Completed;
		const end = sub.endedAt ? new Date(sub.endedAt) : undefined;
		const changed = this.title.get() !== sub.name || this.status.get() !== status || this.modelId.get() !== model || this.lastTurnEnd.get()?.getTime() !== end?.getTime();
		this.file = file ?? this.file;
		if (changed) {
			this.title.set(sub.name, undefined);
			this.status.set(status, undefined);
			this.modelId.set(model, undefined);
			this.lastTurnEnd.set(end, undefined);
			this.updatedAt.set(end ?? new Date(), undefined);
		}
		return changed;
	}
}

/** A session that is a terminal: it knows its terminal in the daemon and what runs in it. */
export class DispatchTerminalSession implements ISession {
	readonly providerId = DISPATCH_TERMINAL_PROVIDER_ID;
	readonly sessionType = DISPATCH_TERMINAL_SESSION_TYPE;
	readonly icon: ThemeIcon;
	readonly createdAt: Date;
	readonly resource: URI;
	readonly sessionId: string;
	readonly workspace: IObservable<ISessionWorkspace | undefined>;
	readonly title;
	readonly updatedAt;
	private readonly _status = observableValue<SessionStatus>(this, SessionStatus.Completed);
	/** Working while the program draws, Waiting for you after it rang the bell, else done. */
	readonly status: IObservable<SessionStatus> = this._status;
	readonly completedStateIcon: IObservable<ThemeIcon | undefined>;
	readonly changes = constObservable([]);
	readonly changesets = constObservable(undefined);
	readonly modelId = constObservable<string | undefined>(undefined);
	readonly mode = constObservable<{ readonly id: string; readonly kind: string } | undefined>(undefined);
	readonly loading = constObservable(false);
	readonly isArchived = constObservable(false);
	private readonly _isRead = observableValue<boolean>(this, true);
	/** Unread: the agent ended a turn (its hooks said so) while the session was not on screen. */
	readonly isRead: IObservable<boolean> = this._isRead;
	/** The session view has it on screen (dispatchTerminalView.ts). */
	viewing = false;
	/** Keeps "seen" with the terminal in the daemon, so unread survives Dispatch closing. */
	onDidSee: ((at: number) => void) | undefined;
	readonly description = constObservable(undefined);
	readonly lastTurnEnd = constObservable<Date | undefined>(undefined);
	private readonly _chats = observableValue<readonly IChat[]>(this, []);
	/** Its one screen, then the sub-agents its agent sent out (Claude Code's, read from its record). */
	readonly chats: IObservable<readonly IChat[]>;
	private readonly _subAgents = new Map<string, DispatchSubAgentChat>();
	/** The size of the record when it was read last, so an unchanged one is not read again. */
	transcriptSize = -1;
	/** The meta files of its sub-agents already read: file name -> what they say. */
	readonly subAgentMeta = new Map<string, { toolUseId?: string; model?: string; parent?: string }>();
	private readonly _subAgentList = observableValue<readonly ISubAgent[]>(this, []);
	/** The sub-agents as Claude Code's record lists them (the view draws them as blocks). */
	readonly subAgentList: IObservable<readonly ISubAgent[]> = this._subAgentList;

	/** The sub-agent whose record the view shows instead of the conversation (opened from its row in the list). */
	readonly reading = observableValue<DispatchSubAgentChat | undefined>(this, undefined);

	subAgentChat(resource: URI): DispatchSubAgentChat | undefined {
		return [...this._subAgents.values()].find(c => c.resource.toString() === resource.toString());
	}

	/** The sub-agents from the record; true when the list of chats or one of them changed. */
	setSubAgents(subs: readonly ISubAgent[], models: ReadonlyMap<string, string>, files: ReadonlyMap<string, string>): boolean {
		let changed = false;
		const main = this.mainChat.get();
		for (const sub of subs) {
			let chat = this._subAgents.get(sub.id);
			if (!chat) {
				chat = new DispatchSubAgentChat(this.id, sub.id, sub.startedAt, main.resource);
				this._subAgents.set(sub.id, chat);
				changed = true;
			}
			changed = chat.update(sub, models.get(sub.id) ?? sub.model, files.get(sub.id)) || changed;
		}
		if (changed) {
			this._subAgentList.set(subs, undefined);
			this._chats.set([main, ...this._subAgents.values()], undefined);
		}
		return changed;
	}
	readonly mainChat: IObservable<IChat>;
	readonly capabilities = constObservable(CAPABILITIES);

	private readonly _title;
	private readonly _updatedAt;

	constructor(
		/** The terminal's id in the daemon. */
		readonly id: string,
		readonly folder: URI,
		/** What runs in it; undefined for a plain terminal. */
		readonly agent: ITerminalAgentMeta | undefined,
		readonly controller: DispatchTerminalController,
		title: string | undefined,
		createdAt: number | undefined,
	) {
		this.resource = URI.from({ scheme: DISPATCH_TERMINAL_SCHEME, path: `/${id}` });
		this.sessionId = toSessionId(DISPATCH_TERMINAL_PROVIDER_ID, this.resource);
		this.createdAt = new Date(createdAt ?? Date.now());
		this.icon = iconFor(agent);
		this.completedStateIcon = constObservable<ThemeIcon | undefined>(this.icon);
		// a terminal in a separate copy goes by its project's name (kanban task-lj06.28)
		const name = folderDisplayName(folder.path);
		this.workspace = constObservable<ISessionWorkspace>({
			uri: folder,
			label: name,
			icon: Codicon.folder,
			folders: [{ root: folder, workingDirectory: folder, name, description: undefined }],
			requiresWorkspaceTrust: false,
			isVirtualWorkspace: false,
			typeIcon: Codicon.terminal,
		});
		this._title = observableValue<string>(this, title || terminalSessionTitle(agent));
		this.title = this._title;
		this._updatedAt = observableValue<Date>(this, this.createdAt);
		this.updatedAt = this._updatedAt;
		const chat: IChat = {
			resource: URI.from({ scheme: DISPATCH_TERMINAL_SCHEME, path: `/${id}`, fragment: 'chat' }),
			createdAt: this.createdAt,
			title: this._title,
			updatedAt: this.updatedAt,
			status: this.status,
			changes: this.changes,
			checkpoints: constObservable(undefined),
			modelId: this.modelId,
			modelSource: constObservable(undefined),
			mode: this.mode,
			isArchived: this.isArchived,
			isRead: this.isRead,
			interactivity: constObservable(ChatInteractivity.Full),
			description: this.description,
			lastTurnEnd: this.lastTurnEnd,
		};
		this._chats.set([chat], undefined);
		this.chats = this._chats;
		this.mainChat = constObservable(chat);
	}

	/** Set by the provider: a delayed change of activity reaches the list and the bell. */
	onDidChangeActivity: (() => void) | undefined;

	setTitle(title: string): void {
		this._title.set(title, undefined);
	}

	// ---- panes: the session's terminal split into several (⌘D, ⌘⇧D), each its own terminal in the daemon ----

	/** The other panes' screens (the main one is `controller`), by their terminal id. */
	readonly panes = new Map<string, DispatchTerminalController>();
	/** The layout as the daemon keeps it, with panes that may not be here yet. */
	rawLayout: unknown;
	private readonly _layout = observableValue<PaneLayout>(this, { pane: this.id });
	/** The panes as they are drawn: only the ones this window has. */
	readonly layout: IObservable<PaneLayout> = this._layout;
	private readonly _expanded = observableValue<string | undefined>(this, undefined);
	/** One pane given the whole space for a while (⌘⇧Enter). */
	readonly expanded: IObservable<string | undefined> = this._expanded;
	private readonly _focusedPane = observableValue<string>(this, this.id);
	/** The pane the keyboard is in or was in last. */
	readonly focusedPane: IObservable<string> = this._focusedPane;

	paneController(id: string): DispatchTerminalController | undefined {
		return id === this.id ? this.controller : this.panes.get(id);
	}

	/** The layout from `rawLayout` and the panes here; true when it changed. */
	refreshLayout(): boolean {
		const next = sanePaneLayout(this.rawLayout, this.id, new Set(this.panes.keys()));
		if (JSON.stringify(next) === JSON.stringify(this._layout.get())) {
			return false;
		}
		this._layout.set(next, undefined);
		if (!paneIds(next).includes(this._focusedPane.get())) {
			this._focusedPane.set(this.id, undefined);
		}
		if (this._expanded.get() && !paneIds(next).includes(this._expanded.get()!)) {
			this._expanded.set(undefined, undefined);
		}
		return true;
	}

	setLayout(layout: PaneLayout): void {
		this.rawLayout = layout;
		this.refreshLayout();
	}

	setFocusedPane(id: string): void {
		this._focusedPane.set(id, undefined);
	}

	toggleExpanded(id: string): void {
		this._expanded.set(this._expanded.get() === id || paneIds(this._layout.get()).length < 2 ? undefined : id, undefined);
	}

	/** Read or unread, here and in the daemon's copy (seen now). Returns whether it changed. */
	private _seenAt = 0;

	setRead(read: boolean): boolean {
		if (read) {
			this._seenAt = Date.now();
			this.onDidSee?.(this._seenAt);
		}
		if (this._isRead.get() === read) {
			return false;
		}
		this._isRead.set(read, undefined);
		return true;
	}

	private _busyTimer: ReturnType<typeof setTimeout> | undefined;
	/** Dispatch IDE (terminal-start-not-working): when its program started (ms), whether the agent ever told a turn. */
	private _runningSince: number | undefined;
	private _lastState: ITermdSessionInfo['state'] | undefined;
	private _toldTurn = false;
	private _startTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastInfo: Parameters<DispatchTerminalSession['setActivity']>[0] | undefined;

	/**
	 * Working, waiting for the person or done, from the daemon. When the agent tells its turn itself (its hooks,
	 * `turn`), that is what the row shows; otherwise only an agent works (a plain shell's commands are the person's
	 * own), and only after it has kept drawing a moment: a redraw is not a turn. The bell does not file these: the
	 * agent's hooks file them in the inbox themselves (terminal_hook.py), also while Dispatch is closed.
	 */
	setActivity(info: Pick<ITermdSessionInfo, 'busy' | 'bell' | 'turn' | 'turnAt' | 'seenAt'> & Partial<Pick<ITermdSessionInfo, 'state' | 'createdAt'>>): boolean {
		// Dispatch IDE (terminal-start-not-working): the program started when the terminal went running (seen now), or
		// when it was made if it already ran as this window came up
		if (info.state !== undefined) {
			if (info.state === 'running' && this._lastState !== 'running') {
				this._runningSince = this._lastState === undefined ? (info.createdAt ?? Date.now()) : Date.now();
			}
			this._lastState = info.state;
		}
		if (info.turn) {
			this._toldTurn = true;
		}
		this._lastInfo = info;
		const starting = !this._toldTurn && this._runningSince !== undefined && Date.now() - this._runningSince < AGENT_STARTING_MS;
		if (starting && info.busy && !info.bell && !info.turn) {
			// look again once the start is over: if it still draws then, that is work
			if (this._startTimer === undefined) {
				this._startTimer = setTimeout(() => {
					this._startTimer = undefined;
					if (this._lastInfo && this.setActivity(this._lastInfo)) {
						this.onDidChangeActivity?.();
					}
				}, AGENT_STARTING_MS - (Date.now() - this._runningSince!) + 50);
			}
			info = { ...info, busy: false };
		}
		if (info.turn) {
			if (this._busyTimer !== undefined) {
				clearTimeout(this._busyTimer);
				this._busyTimer = undefined;
			}
			const told = info.turn === 'working' ? SessionStatus.InProgress
				: info.turn === 'needs_you' || info.bell ? SessionStatus.NeedsInput
					: info.turn === 'stopped' ? SessionStatus.Error : SessionStatus.Completed;
			// a turn ended out of sight: the row says there is something new, as a chat session's does
			let unread = false;
			if (told !== SessionStatus.InProgress && !this.viewing && this._isRead.get() && (info.turnAt ?? 0) > Math.max(info.seenAt ?? 0, this._seenAt)) {
				this._isRead.set(false, undefined);
				unread = true;
			}
			if (told === this._status.get()) {
				return unread;
			}
			this._status.set(told, undefined);
			if (told !== SessionStatus.InProgress) {
				this._updatedAt.set(new Date(), undefined);
			}
			return true;
		}
		const busy = !!info.busy && !!this.agent;
		if (busy && !info.bell && this._status.get() !== SessionStatus.InProgress) {
			if (this._busyTimer === undefined) {
				this._busyTimer = setTimeout(() => {
					this._busyTimer = undefined;
					if (this._status.get() !== SessionStatus.NeedsInput) {
						this._status.set(SessionStatus.InProgress, undefined);
						this.onDidChangeActivity?.();
					}
				}, WORKING_AFTER_MS);
			}
			return false;
		}
		if (!busy && this._busyTimer !== undefined) {
			clearTimeout(this._busyTimer);
			this._busyTimer = undefined;
		}
		const next = info.bell ? SessionStatus.NeedsInput : busy ? SessionStatus.InProgress : SessionStatus.Completed;
		if (next === this._status.get()) {
			return false;
		}
		this._status.set(next, undefined);
		if (next !== SessionStatus.InProgress) {
			this._updatedAt.set(new Date(), undefined);
		}
		return true;
	}
}

export interface IOpenTerminalOptions {
	/** Typed instead of the agent's own start (a resume or a fork of another conversation). */
	readonly command?: string;
	/** With `command`: the conversation id it gives the agent, so a restart goes on with it. */
	readonly agentSession?: string;
	/** Pasted into the agent's prompt once it is up, not sent: the person reads and sends it. */
	readonly draft?: string;
	readonly title?: string;
}

/** Sessions that are terminals. */
export class DispatchTerminalSessionsProvider extends Disposable implements ISessionsProvider {
	readonly id = DISPATCH_TERMINAL_PROVIDER_ID;
	readonly label = 'Terminal';
	readonly icon: ThemeIcon = Codicon.terminal;
	readonly order = 100;
	readonly sessionTypes: readonly ISessionType[] = [TERMINAL_SESSION_TYPE];
	readonly onDidChangeSessionTypes = Event.None;
	readonly browseActions: readonly ISessionWorkspaceBrowseAction[] = [];
	readonly onDidChangeModels = Event.None;

	private readonly _sessions = new Map<string, DispatchTerminalSession>();
	private readonly _byTerminal = new Map<string, DispatchTerminalSession>();
	private readonly _disposables = new Map<string, IDisposable>();
	/** Every screen (the sessions' and their panes'), by terminal id, and the session each belongs to. */
	private readonly _controllers = new Map<string, DispatchTerminalController>();
	private readonly _owner = new Map<string, DispatchTerminalSession>();
	/** Panes listed before their session (the order the daemon lists them in does not matter). */
	private readonly _orphans = new Map<string, ITermdSessionInfo>();
	private readonly _onDidRequestMenu = this._register(new Emitter<{ session: DispatchTerminalSession; pane: DispatchTerminalController; event: MouseEvent }>());
	/** A right-click in a terminal (dispatchTerminalActions.ts shows the menu). */
	readonly onDidRequestMenu = this._onDidRequestMenu.event;
	private readonly _onDidRequestFind = this._register(new Emitter<DispatchTerminalController>());
	/** ⌘F in a terminal (dispatchTerminalActions.ts shows the find box). */
	readonly onDidRequestFind = this._onDidRequestFind.event;
	private readonly _onDidRequestSessionStep = this._register(new Emitter<{ session: DispatchTerminalSession; delta: 1 | -1 }>());
	/** ⌘⇧] ⌘⇧[ in a terminal: the next or previous session of its folder (dispatchTerminalActions.ts opens it). */
	readonly onDidRequestSessionStep = this._onDidRequestSessionStep.event;
	private readonly _onDidChangeSessions = this._register(new Emitter<ISessionChangeEvent>());
	readonly onDidChangeSessions = this._onDidChangeSessions.event;
	readonly client: TermdClient;
	private readonly _focus: IContextKey<boolean>;
	private readonly _inPane: IContextKey<boolean>;
	/** The terminal the keyboard is in, or was in last. */
	private _lastFocused: DispatchTerminalController | undefined;

	constructor(
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@ICommandService private readonly _commands: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
	) {
		super();
		this.client = this._register(_instantiation.createInstance(TermdClient));
		// the sub-agents Claude Code sends out from a terminal, read from its record (it says nothing on the screen
		// a program could rely on): the sessions list shows them under the session
		const subTimer = mainWindow.setInterval(() => {
			for (const s of this._sessions.values()) {
				void this._readSubAgents(s);
			}
		}, SUB_AGENTS_MS);
		this._register({ dispose: () => mainWindow.clearInterval(subTimer) });
		this._focus = DispatchTerminalFocus.bindTo(contextKeyService);
		this._inPane = DispatchTerminalInPane.bindTo(contextKeyService);
		this._register(this.client.onEvent(e => {
			if (e.type === 'added') {
				this._adopt(e.info);
			} else if (e.type === 'removed' || e.type === 'exit') {
				const s = this._byTerminal.get(e.session);
				if (s) {
					this._remove(s);
				} else {
					this._removePane(e.session);
				}
			} else if (e.type === 'changed') {
				const s = this._byTerminal.get(e.session);
				if (s) {
					let changed = s.setActivity(e.info);
					if (e.info.title && e.info.title !== s.title.get()) {
						s.setTitle(e.info.title);
						changed = true;
					}
					if (changed) {
						this._onDidChangeSessions.fire({ added: [], removed: [], changed: [s] });
					}
				}
			} else if (e.type === 'data') {
				this._controllers.get(e.session)?.output(e.data);
			}
		}));
		this._register(this.client.onDidReconnect(() => void this._reconnected()));
		void this._restore();
	}

	private readonly _readingSubAgents = new Set<string>();

	/** Reads a Claude Code terminal's record again when it grew: its sub-agents, their models and records. */
	private async _readSubAgents(session: DispatchTerminalSession): Promise<void> {
		const id = session.controller.info.agentSession;
		if (session.agent?.id !== 'claude' || !id || this._readingSubAgents.has(session.id)) {
			return;
		}
		this._readingSubAgents.add(session.id);
		try {
			const home = this._paths.userHome({ preferLocal: true }).fsPath;
			const path = claudeTranscriptPath(home, session.folder.fsPath, id);
			const stat = await this._files.stat(URI.file(path)).catch(() => undefined);
			if (!stat || stat.size === session.transcriptSize) {
				return;
			}
			session.transcriptSize = stat.size ?? -1;
			const subs = claudeSubAgents((await this._files.readFile(URI.file(path))).value.toString());
			const models = new Map<string, string>();
			const files = new Map<string, string>();
			if (subs.length) {
				const folder = claudeSubAgentsFolder(path);
				const listing = await this._files.resolve(URI.file(folder)).catch(() => undefined);
				for (const child of listing?.children ?? []) {
					if (!child.name.endsWith('.meta.json')) {
						continue;
					}
					let meta = session.subAgentMeta.get(child.name);
					if (!meta) {
						meta = readSubAgentMeta((await this._files.readFile(child.resource).catch(() => undefined))?.value.toString() ?? '');
						if (meta.toolUseId) {
							session.subAgentMeta.set(child.name, meta);
						}
					}
					if (meta.toolUseId) {
						if (meta.model) {
							models.set(meta.toolUseId, meta.model);
						}
						files.set(meta.toolUseId, `${folder}/${child.name.replace(/\.meta\.json$/, '.jsonl')}`);
					}
				}
			}
			if (session.setSubAgents(subs, models, files)) {
				this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
			}
		} catch (e) {
			this._log.trace('[dispatch terminal] sub-agents', e);
		} finally {
			this._readingSubAgents.delete(session.id);
		}
	}

	/** The terminals the daemon kept: there when this window opens, the same ones as before it closed. */
	private async _restore(attempt = 0): Promise<void> {
		try {
			const kept = await this._commands.executeCommand<{ ok?: boolean; running?: boolean }>('dispatch.terminal', 'daemon', { ifKept: true });
			if (!kept?.running) {
				return;
			}
			const { sessions } = await this.client.request<{ sessions: ITermdSessionInfo[] }>('list');
			for (const info of sessions) {
				this._adopt(info);
			}
		} catch (e) {
			// dispatch-bridge may still be starting with the window: ask again a few times
			if (attempt < 6) {
				mainWindow.setTimeout(() => void this._restore(attempt + 1), 2000 * (attempt + 1));
			} else {
				this._log.warn('[dispatch terminal] could not list the kept terminals', e);
			}
		}
	}

	private async _reconnected(): Promise<void> {
		try {
			const { sessions } = await this.client.request<{ sessions: ITermdSessionInfo[] }>('list');
			const alive = new Set(sessions.map(s => s.id));
			for (const s of [...this._sessions.values()]) {
				if (!alive.has(s.id)) {
					this._remove(s);
				}
			}
			for (const id of [...this._owner.keys()]) {
				if (!alive.has(id)) {
					this._removePane(id);
				}
			}
			for (const info of sessions) {
				this._adopt(info);
			}
			for (const c of this._controllers.values()) {
				void c.reattach();
			}
		} catch (e) {
			this._log.warn('[dispatch terminal] could not attach again', e);
		}
	}

	private _adopt(info: ITermdSessionInfo): DispatchTerminalSession | undefined {
		const existing = this._byTerminal.get(info.id);
		if (existing) {
			return existing;
		}
		if (info.parent) {
			this._adoptPane(info);
			return undefined;
		}
		const folder = URI.file(info.cwd || '/');
		const controller = this._instantiation.createInstance(DispatchTerminalController, this.client, info);
		const session = new DispatchTerminalSession(info.id, folder, info.agent, controller, info.title, info.createdAt);
		session.rawLayout = info.layout;
		// ⌘W in the session's own first pane stays the window's: that pane is the session (Close Terminal ends it)
		controller.hasPanes = () => false;
		this._controllers.set(info.id, controller);
		session.onDidChangeActivity = () => this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
		session.onDidSee = at => void this.client.request('meta', { session: info.id, meta: { seenAt: at } }).catch(() => undefined);
		session.setActivity(info);
		const store = new DisposableStore();
		store.add(controller);
		store.add(controller.onDidFocus(focused => {
			if (focused) {
				this._lastFocused = controller;
				session.setFocusedPane(controller.id);
			} else if (this._lastFocused !== controller) {
				// another pane took the keyboard first (its focus came before this blur): the keys stay the terminal's
				return;
			}
			this._focus.set(focused);
			this._inPane.set(false);
		}));
		store.add(controller.onContextMenu(event => this._onDidRequestMenu.fire({ session, pane: controller, event })));
		store.add(controller.onFind(() => this._onDidRequestFind.fire(controller)));
		store.add(controller.onPaneCommand(cmd => void this.paneCommand(session, controller, cmd)));
		this._disposables.set(session.sessionId, store);
		this._sessions.set(session.sessionId, session);
		this._byTerminal.set(info.id, session);
		this._owner.set(info.id, session);
		for (const orphan of [...this._orphans.values()].filter(o => o.parent === info.id)) {
			this._orphans.delete(orphan.id);
			this._adoptPane(orphan);
		}
		session.refreshLayout();
		this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
		return session;
	}

	/** A pane of a session: its own screen, drawn inside the session's view. */
	private _adoptPane(info: ITermdSessionInfo): void {
		if (this._controllers.has(info.id)) {
			return;
		}
		const session = info.parent ? this._byTerminal.get(info.parent) : undefined;
		if (!session) {
			this._orphans.set(info.id, info);
			return;
		}
		const controller = this._instantiation.createInstance(DispatchTerminalController, this.client, info);
		controller.hasPanes = () => true;
		const store = new DisposableStore();
		store.add(controller);
		store.add(controller.onDidFocus(focused => {
			if (focused) {
				this._lastFocused = controller;
				session.setFocusedPane(controller.id);
			} else if (this._lastFocused !== controller) {
				// another pane took the keyboard first (its focus came before this blur): the keys stay the terminal's
				return;
			}
			this._focus.set(focused);
			this._inPane.set(focused);
		}));
		store.add(controller.onContextMenu(event => this._onDidRequestMenu.fire({ session, pane: controller, event })));
		store.add(controller.onFind(() => this._onDidRequestFind.fire(controller)));
		store.add(controller.onPaneCommand(cmd => void this.paneCommand(session, controller, cmd)));
		this._disposables.set(`pane:${info.id}`, store);
		this._controllers.set(info.id, controller);
		this._owner.set(info.id, session);
		session.panes.set(info.id, controller);
		session.refreshLayout();
	}

	private _removePane(id: string): void {
		this._orphans.delete(id);
		const session = this._owner.get(id);
		if (!session || id === session.id) {
			return;
		}
		const controller = this._controllers.get(id);
		this._controllers.delete(id);
		this._owner.delete(id);
		session.panes.delete(id);
		if (this._lastFocused === controller) {
			this._lastFocused = session.controller;
		}
		const store = this._disposables.get(`pane:${id}`);
		this._disposables.delete(`pane:${id}`);
		store?.dispose();
		const before = session.rawLayout;
		const layout = before ? removePane(sanePaneLayout(before, session.id, new Set([...session.panes.keys(), id])), id) : undefined;
		session.setLayout(layout ?? { pane: session.id });
		this._saveLayout(session);
	}

	private _saveLayout(session: DispatchTerminalSession): void {
		void this.client.request('meta', { session: session.id, meta: { layout: session.layout.get() } }).catch(e => this._log.warn('[dispatch terminal] layout', e));
	}

	/** The sizes a person dragged the dividers to, kept with the layout. */
	setPaneSizes(session: DispatchTerminalSession, layout: PaneLayout): void {
		session.setLayout(layout);
		this._saveLayout(session);
	}

	/**
	 * A new pane next to `from`: a shell in the folder `from` is in now ('row' to its right, 'column' below it),
	 * as Orca's Split Terminal Right / Down. The pane is a terminal of its own in the daemon, kept with the session.
	 */
	async splitPane(session: DispatchTerminalSession, from: DispatchTerminalController, dir: 'row' | 'column'): Promise<void> {
		const cwd = from.cwd || session.folder.fsPath;
		const { info } = await this.client.request<{ info: ITermdSessionInfo }>('create', {
			session: generateUuid(),
			cwd,
			cols: Math.max(20, Math.floor((from.info.cols ?? 100) / (dir === 'row' ? 2 : 1))),
			rows: Math.max(5, Math.floor((from.info.rows ?? 30) / (dir === 'column' ? 2 : 1))),
			meta: { title: 'Terminal', parent: session.id, project: session.folder.fsPath },
		});
		this._adoptPane(info);
		session.setLayout(splitPane(session.layout.get(), from.id, info.id, dir));
		session.setFocusedPane(info.id);
		this._saveLayout(session);
		// the view draws the new pane, then the keyboard goes to it
		mainWindow.setTimeout(() => this._controllers.get(info.id)?.focus(), 120);
	}

	/** A pane dragged onto another pane's edge: it moves there (its terminal keeps running). */
	movePane(session: DispatchTerminalSession, id: string, target: string, side: PaneSide): void {
		const next = movePane(session.layout.get(), id, target, side);
		if (next === session.layout.get()) {
			return;
		}
		session.setLayout(next);
		session.setFocusedPane(id);
		this._saveLayout(session);
		mainWindow.setTimeout(() => this._controllers.get(id)?.focus(), 120);
	}

	/** Closes a pane (not the session's own first one: closing that is Close Terminal). */
	async closePane(session: DispatchTerminalSession, id: string): Promise<boolean> {
		if (id === session.id || !session.panes.has(id)) {
			return false;
		}
		const next = stepPane(session.layout.get(), id, -1);
		this._removePane(id);
		await this.client.request('kill', { session: id }).catch(e => this._log.warn('[dispatch terminal] close pane', e));
		session.paneController(next)?.focus();
		return true;
	}

	async paneCommand(session: DispatchTerminalSession, from: DispatchTerminalController, cmd: PaneCommand): Promise<void> {
		switch (cmd) {
			case 'splitRight': return this.splitPane(session, from, 'row');
			case 'splitDown': return this.splitPane(session, from, 'column');
			case 'closePane': await this.closePane(session, from.id); return;
			case 'nextPane':
			case 'previousPane': {
				const to = stepPane(session.layout.get(), from.id, cmd === 'nextPane' ? 1 : -1);
				if (session.expanded.get() && session.expanded.get() !== to) {
					session.toggleExpanded(to);
				}
				session.paneController(to)?.focus();
				return;
			}
			case 'expandPane':
				session.toggleExpanded(from.id);
				mainWindow.setTimeout(() => from.focus(), 60);
				return;
			case 'nextSession':
			case 'previousSession':
				this._onDidRequestSessionStep.fire({ session, delta: cmd === 'nextSession' ? 1 : -1 });
				return;
		}
	}

	/** The session a screen belongs to (its own or one of its panes). */
	ownerOf(controller: DispatchTerminalController): DispatchTerminalSession | undefined {
		return this._owner.get(controller.id);
	}

	/**
	 * Opens a terminal in `folder` and adds it to the list. With an agent, the agent's own command is typed into
	 * it once the shell is up, so the agent starts the way it does when typed by hand and asks before it acts.
	 */
	async open(folder: URI, agent: ITerminalAgent | undefined, options: IOpenTerminalOptions = {}): Promise<DispatchTerminalSession> {
		const launch = agent ? launchFor(agent, generateUuid) : undefined;
		const agentSession = options.command ? options.agentSession : launch?.agentSession;
		const restoreCommand = options.command
			? (agent && agentSession ? fillRecipe(agent.resume, agentSession) || undefined : undefined)
			: launch?.restoreCommand;
		const meta: Record<string, unknown> = {
			title: options.title || terminalSessionTitle(agent),
			agent: agent ? { id: agent.id, name: agent.name, command: agent.command, start: agent.start, resume: agent.resume, fork: agent.fork } : undefined,
			agentSession,
			restoreCommand,
			project: folder.fsPath,
		};
		const { info } = await this.client.request<{ info: ITermdSessionInfo }>('create', {
			session: generateUuid(),
			cwd: folder.fsPath,
			cols: 100,
			rows: 30,
			command: options.command ?? launch?.command,
			draft: options.draft,
			meta,
		});
		return this._adopt(info)!;
	}

	private _remove(session: DispatchTerminalSession): void {
		if (this._sessions.delete(session.sessionId)) {
			for (const id of [...session.panes.keys()]) {
				this._removePane(id);
			}
			this._byTerminal.delete(session.id);
			this._controllers.delete(session.id);
			this._owner.delete(session.id);
			const store = this._disposables.get(session.sessionId);
			this._disposables.delete(session.sessionId);
			if (this._lastFocused === session.controller) {
				this._lastFocused = undefined;
				this._focus.set(false);
			}
			store?.dispose();
			this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
		}
	}

	getTerminalSession(sessionId: string): DispatchTerminalSession | undefined {
		return this._sessions.get(sessionId);
	}

	/** The terminal the keyboard is in or was in last (for ⌘V, ⌘K, ⌘F and the menu's commands). */
	get activeController(): DispatchTerminalController | undefined {
		return this._lastFocused;
	}

	sessionOf(controller: DispatchTerminalController): DispatchTerminalSession | undefined {
		return this._owner.get(controller.id);
	}

	getSessions(): ISession[] {
		return [...this._sessions.values()];
	}

	// A terminal is not a chat: nothing below applies to it. They are here because the sessions list asks every provider.

	resolveWorkspace(): ISessionWorkspace | undefined {
		return undefined; // new sessions are never created in a terminal provider: the workspace picker skips it
	}

	getSessionTypes(): ISessionType[] {
		return [];
	}

	createNewSession(): ISession {
		throw new Error('A terminal is opened from the terminal button, not from the new session page.');
	}

	createQuickChat(): ISession {
		throw new Error('A terminal is opened from the terminal button, not from the new session page.');
	}

	deleteNewSession(): void { }

	async prepareNewSession(_sessionId: string, _token: CancellationToken, _query: string): Promise<IPreparedNewSession> {
		throw new Error('Not a chat.');
	}

	async renameChat(sessionId: string, _chatUri: URI, title: string): Promise<void> {
		return this.renameSession(sessionId, title);
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.setTitle(title);
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
			await this.client.request('meta', { session: session.id, meta: { title } }).catch(e => this._log.warn('[dispatch terminal] rename', e));
		}
	}

	getModelsSnapshot(): ISessionModelsSnapshot {
		return { models: [], desiredModelResolution: { kind: 'notRequested' }, modelTarget: undefined };
	}

	getModelPickerOptions(): ISessionModelPickerOptions {
		return { useGroupedModelPicker: false, showFeatured: false, showUnavailableFeatured: false, showManageModelsAction: false, showAutoModel: false };
	}

	setModel(): void { }

	/** Closing a terminal session ends the terminal; the shell and whatever runs in it end. */
	async deleteSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			this._remove(session);
			await this.client.request('kill', { session: session.id }).catch(e => this._log.warn('[dispatch terminal] close', e));
		}
	}

	async deleteSessions(sessionIds: readonly string[]): Promise<void> {
		for (const id of sessionIds) {
			await this.deleteSession(id);
		}
	}

	/** There is nothing to keep once it is archived: archiving a terminal closes it, like closing it. */
	archiveSession(sessionId: string): Promise<void> {
		return this.deleteSession(sessionId);
	}

	async unarchiveSession(): Promise<void> { }

	async setSessionReadState(sessionId: string, isRead: boolean): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session?.setRead(isRead)) {
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: [session] });
		}
	}

	async deleteChat(): Promise<boolean> {
		return false;
	}

	async createNewChat(): Promise<IChat> {
		throw new Error('A terminal has one screen.');
	}

	async forkChat(): Promise<IChat> {
		throw new Error('A terminal has one screen.');
	}

	async createSideChat(): Promise<IChat> {
		throw new Error('A terminal has one screen.');
	}

	async sendRequest(_sessionId: string, _chatResource: URI, _options: ISendRequestOptions): Promise<ISession> {
		throw new Error('Type in the terminal itself.');
	}

	override dispose(): void {
		for (const d of this._disposables.values()) {
			d.dispose();
		}
		this._disposables.clear();
		super.dispose();
	}
}
