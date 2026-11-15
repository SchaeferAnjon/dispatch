/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode as the third harness next to Claude and Codex, through the person's own
 *  `opencode` CLI and its Agent Client Protocol mode (`opencode acp`, opencodeAcpClient.ts). OpenCode
 *  brings its own models, keys, tools and permission rules and runs them itself; this is only the
 *  adapter that maps what it reports onto the Agent Host's chats, the same relation the Codex harness
 *  has to `codex app-server`:
 *
 *  - One `opencode acp` process for the whole agent host (started when the first OpenCode chat needs
 *    it, kept running, started again after it exits); each chat is one ACP session in it, addressed
 *    by id. A new chat's folder is warmed while the person types, so the first message does not wait
 *    for the process or for OpenCode's per-folder start.
 *  - A new chat is provisional until its first message creates the ACP session; the session id (the
 *    folder, the model) is the chat's providerData, so a restored chat loads the same session
 *    (`session/load` replays it into turns, opencodeReplay.ts) and goes on where it was.
 *  - Text and reasoning stream as response parts, tools as tool calls worded like Claude's
 *    (opencodeTools.ts), a permission OpenCode asks for as the host's confirmation card.
 *  - Models are `opencode models --verbose`, grouped by provider, with OpenCode's variants as the
 *    thinking level (opencodeModels.ts); they are listed again when OpenCode's config or keys change
 *    and when a new process starts.
 *  - OpenCode's question tool asks through the host's question card (opencodeQuestions.ts): the
 *    process runs with the tool on and its own HTTP server on a port and password of ours.
 *  - OpenCode's own recent sessions (started in its terminal UI or `opencode run`) are listed like
 *    Claude's and Codex's (opencodeSessions.ts); opening one goes on in that session. A session a chat
 *    here created is reported as the chat's backing, so it is not listed a second time.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from '@vscode/sqlite3';
import { raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentHostClientType } from '../../common/agentHostClientInfo.js';
import { type AgentChatMigrationResult, type AgentChatOperationContext, type AgentProvider, AgentSession, type AgentSignal, type IActiveClient, type IAgent, type IAgentChatConfigCompletionsParams, type IAgentChatContext, type IAgentChatDataChange, type IAgentChatMetadata, type IAgentChatMetadataOptions, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentDescriptor, type IAgentDiscoveredChat, type IAgentMaterializeChatEvent, type IAgentModelInfo, type IAgentResolveChatConfigParams, type IAgentSlashCommand, resolveAgentChatContext } from '../../common/agent.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { MessageAttachmentKind, type AgentSelection, type MessageAttachment, type ModelSelection, type ProtectedResourceMetadata, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { createSchema, platformSessionSchema, type AutoApproveLevel } from '../../common/agentHostSchema.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ChatInputRequestPurpose, withChatInputRequestPurpose } from '../../common/meta/agentChatInputRequestMeta.js';
import { readDispatchMarksMeta, renderDispatchMarksText } from '../../common/meta/dispatchMarksAttachmentMeta.js';
import { applyDispatchQuotes } from '../../common/meta/dispatchQuoteAttachmentMeta.js';
import { ChatInputResponseKind, ChatOriginKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, buildDefaultChatUri, buildSubagentChatUri, isSubagentChatUri, createErrorResponsePart, isDefaultChatUri, type ChatInputAnswer, type ClientPluginCustomization, type Customization, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import { AcpError, OpenCodeAcpClient, type IAcpConfigOption, type IAcpNotification, type IAcpPermissionRequest, type IAcpSessionUpdate } from './opencodeAcpClient.js';
import { OPENCODE_DEFAULT_EFFORT, OPENCODE_PROVIDER_ID, namesFromModelOption, opencodeConfigFiles, opencodeEffortOf, opencodePaths, parseJsonc, parseOpenCodeModels, readDefaultModel, readProviderNames, toAgentModels, type IOpenCodeModel } from './opencodeModels.js';
import { configuredProviders, keepMissingProviders } from './opencodeModelKeep.js';
import { OPENCODE_QUESTION_TOOL_ENV, OPENCODE_SERVER_PASSWORD_ENV, OpenCodeQuestionEventType, OpenCodeServer, freePort, newServerPassword, toChatInputQuestions, toOpenCodeAnswers, type IOpenCodeQuestion, type IOpenCodeQuestionEvent } from './opencodeQuestions.js';
import { mapReplayToTurns, openCodeOwnTurnMessage } from './opencodeReplay.js';
import { OpenCodeSubagentMirror } from './opencodeSubagentMirror.js';
import { childSessionOf, childSessionOfUpdate, messagesToUpdates, type OpenCodeStreamEvent } from './opencodeSubagentSteps.js';
import { OPENCODE_SESSION_ID, openCodeDiscoverable, openCodeSessionIndexQuery, openCodeSessionRows, parseOpenCodeSessionRows, type IOpenCodeSessionRow } from './opencodeSessions.js';
import { OpenCodeSessionIndex } from './opencodeSessionIndex.js';
import { subagentAnswer, subagentTask, toolDisplayName, toolHasInput, toolInputString, toolInvocationMessage, toolMeta, toolOutputText, toolPastTenseMessage, toolPermission, toolView, type IOpenCodeToolView } from './opencodeTools.js';
import { openCodeSlashCommandsForMenu, readAvailableCommands, type IAcpAvailableCommand } from './opencodeCommands.js';
import { type IOpenCodePick, openCodeTooOldMessage, opencodeCandidatePaths, resolveOpenCode } from './opencodeVersion.js';
import type { IAgentServerToolHost } from '../../common/agentServerTools.js';
import { diffNotesPrompt, resolveDiffNotes } from './dispatchOpenCodeFeedback.js';
import { DispatchOpenCodeKit } from './dispatchOpenCodeKit.js';

export const OPENCODE_AGENT_PROVIDER_ID = OPENCODE_PROVIDER_ID;

/** Seconds OpenCode may take to start, open, load or reconfigure a session before it counts as stuck. */
const REQUEST_TIMEOUT_MS = 120_000;
/** A provider one listing missed is looked for again this much later (opencodeModelKeep.ts). */
const MISSED_PROVIDER_RECHECK_MS = 15_000;

/**
 * Variables an agent's own shell leaves behind (the app started from inside another agent's terminal):
 * OpenCode's shell commands must not look like another session's. The same rule as the dispatch CLI's
 * in-app chats (kanban app/cli/chat_protocol.py child_env).
 */
const INHERITED_ENV_PREFIXES = ['CLAUDE', 'HERDR_', 'ZELLIJ'];
const INHERITED_ENV_NAMES = new Set(['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'DISPATCH_SESSION_ID', 'DISPATCH_CALLER', 'DISPATCH_ACTOR', 'TMUX', 'TMUX_PANE']);

/** The environment `opencode` runs with: ours minus another agent's session variables, and a PATH that finds it. */
export function opencodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!INHERITED_ENV_NAMES.has(key) && !INHERITED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
			out[key] = value;
		}
	}
	out['PATH'] = opencodeSearchPath(env);
	return out;
}

/**
 * Dispatch IDE: OpenCode's sessions from its database file itself, read-only, in this process (about 0.1 s
 * against 1 to 2.5 s for an `opencode db` process). Throws when it cannot: the index then asks `opencode db`.
 */
export async function readOpenCodeDatabase(database: string, query: string): Promise<IOpenCodeSessionRow[]> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const db = await new Promise<Database>((resolve, reject) => {
		const opened: Database = new sqlite3.Database(database, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(opened));
	});
	try {
		db.configure('busyTimeout', 3000);
		const rows = await new Promise<unknown[]>((resolve, reject) => db.all(query, (error: Error | null, out: unknown[]) => error ? reject(error) : resolve(out)));
		return openCodeSessionRows(rows);
	} finally {
		db.close();
	}
}

/** Where `opencode` usually lives; the app is started from the Dock, so PATH may have none of these. */
export function opencodeSearchPath(env: NodeJS.ProcessEnv = process.env): string {
	// Dispatch IDE: exactly these folders when set, as the dispatch CLI looks for engines (engines.search_path): the
	// copy that answers is the copy the version check read
	if (env['DISPATCH_ENGINE_PATH']) {
		return [env['DISPATCH_ENGINE_PATH'], '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
	}
	const home = os.homedir();
	const extra = [
		path.join(home, '.opencode', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'),
		path.join(home, 'npm-global', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'),
		'/opt/homebrew/bin', '/usr/local/bin',
	];
	const dirs: string[] = [];
	for (const dir of [...(env['PATH'] ?? '').split(path.delimiter), ...extra]) {
		if (dir && !dirs.includes(dir)) {
			dirs.push(dir);
		}
	}
	return dirs.join(path.delimiter);
}

/**
 * The first `opencode` on the search path, or undefined when OpenCode is not installed. Only says that
 * OpenCode is there (the harness is offered or not); which copy runs, by version, is {@link resolveOpenCode}.
 */
export function findOpenCode(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return opencodeCandidatePaths(opencodeSearchPath(env))[0];
}

/** What a chat keeps across restarts (its providerData). */
export interface IOpenCodePersistedChat {
	/** the ACP session id (`ses_…`), OpenCode's own */
	readonly opencodeSessionId: string;
	readonly cwd?: string;
	readonly model?: ModelSelection;
}

export function encodeOpenCodeChat(chat: IOpenCodePersistedChat): string {
	return JSON.stringify(chat);
}

export function decodeOpenCodeChat(providerData: string | undefined): IOpenCodePersistedChat | undefined {
	if (!providerData) {
		return undefined;
	}
	try {
		const value = JSON.parse(providerData) as Partial<IOpenCodePersistedChat>;
		if (typeof value?.opencodeSessionId !== 'string' || !value.opencodeSessionId) {
			return undefined;
		}
		return {
			opencodeSessionId: value.opencodeSessionId,
			...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
			...(value.model && typeof value.model.id === 'string' ? { model: value.model } : {}),
		};
	} catch {
		return undefined;
	}
}

/** The ACP content blocks of a prompt: the text, images as image blocks, files as resource links. */
export function toPromptBlocks(promptText: string, allAttachments: readonly MessageAttachment[] | undefined, readFile: (p: string) => Buffer | undefined = safeReadFile): Record<string, unknown>[] {
	// Dispatch IDE: quotes (Quote, ⇧⌘L) go in front of the message as `>` paragraphs, as for Claude and Codex
	const { prompt, attachments } = applyDispatchQuotes(promptText, allAttachments);
	const blocks: Record<string, unknown>[] = [];
	if (prompt) {
		blocks.push({ type: 'text', text: prompt });
	}
	// Dispatch IDE (draw-and-ask): boxes drawn on a picture go right after it, as for Claude and Codex
	let images = 0;
	const pushImage = (image: Record<string, unknown>, att: MessageAttachment) => {
		blocks.push(image);
		images++;
		const marks = readDispatchMarksMeta(att);
		if (marks) {
			blocks.push({ type: 'text', text: renderDispatchMarksText(marks, images) });
		}
	};
	for (const att of attachments ?? []) {
		if (att.type === MessageAttachmentKind.EmbeddedResource) {
			const mimeType = imageMime(att.data, att.contentType);
			if (mimeType) {
				pushImage({ type: 'image', mimeType, data: att.data }, att);
			}
			continue;
		}
		if (att.type === MessageAttachmentKind.Resource) {
			const uri = URI.isUri(att.uri) ? att.uri : URI.parse(String(att.uri));
			if (uri.scheme === 'file' && (att.displayKind === 'image' || att.contentType?.startsWith('image/'))) {
				const bytes = readFile(uri.fsPath);
				const data = bytes?.toString('base64');
				const mimeType = data ? imageMime(data, 'image/*') : undefined;
				if (data && mimeType) {
					pushImage({ type: 'image', mimeType, data }, att);
					continue;
				}
			}
			blocks.push({ type: 'resource_link', uri: uri.toString(), name: att.label || path.basename(uri.path) });
			continue;
		}
		if (att.type === MessageAttachmentKind.Simple && att.modelRepresentation) {
			blocks.push({ type: 'text', text: att.modelRepresentation });
		}
	}
	if (!blocks.length) {
		blocks.push({ type: 'text', text: '' });
	}
	return blocks;
}

function safeReadFile(p: string): Buffer | undefined {
	try {
		return fs.readFileSync(p);
	} catch {
		return undefined;
	}
}

/** The media type of base64 image bytes (from the bytes: a pasted image keeps its original label). */
function imageMime(data: string, contentType: string | undefined): string | undefined {
	if (!contentType?.toLowerCase().startsWith('image/')) {
		return undefined;
	}
	let head: string;
	try {
		head = atob(data.slice(0, 24));
	} catch {
		return undefined;
	}
	if (head.startsWith('\x89PNG')) {
		return 'image/png';
	}
	if (head.startsWith('\xFF\xD8\xFF')) {
		return 'image/jpeg';
	}
	if (head.startsWith('GIF8')) {
		return 'image/gif';
	}
	if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
		return 'image/webp';
	}
	return undefined;
}

interface IToolState {
	view: IOpenCodeToolView;
	ready: boolean;
	done: boolean;
	/** Dispatch IDE: a subagent task told to the Agent Host (it has a chat of its own under the session). */
	subagent?: boolean;
}

interface ITurnState {
	readonly id: string;
	readonly started: number;
	/** where the first seconds went (logged when the turn ends): the session ready, OpenCode's first word, its first tool */
	readonly timing: { ready?: number; firstUpdate?: number; firstTool?: number };
	/** Stop was pressed: what OpenCode still reports for this turn was cut off */
	cancelled: boolean;
	markdownPartId: string | undefined;
	reasoningPartId: string | undefined;
	readonly tools: Map<string, IToolState>;
	/**
	 * A turn OpenCode started by itself (a plugin going on with its to-do list, a background task
	 * reporting back): no `session/prompt` of ours answers it, so it ends when OpenCode goes quiet.
	 */
	readonly own?: { quiet: ReturnType<typeof setTimeout> | undefined };
	/** Dispatch IDE (diff notes): the notes this turn acts on, marked done when it ends */
	notes?: readonly string[];
}

/** How long OpenCode stays quiet before a turn it started by itself counts as done. */
const OWN_TURN_QUIET_MS = 6_000;
/** ... after it reported the step's usage (the end of a model call). */
const OWN_TURN_QUIET_AFTER_USAGE_MS = 2_000;

interface IChatState {
	readonly chat: URI;
	/** the host session the chat belongs to (its configuration resource) */
	session: URI | undefined;
	readonly created: number;
	modified: number;
	cwd: string | undefined;
	model: ModelSelection | undefined;
	/** the ACP session, once the first message created it (or a restore named it) */
	sessionId: string | undefined;
	/** the process generation the session is loaded in (undefined: not loaded in the current process) */
	attachedGeneration: number | undefined;
	/** the model and effort OpenCode has for the session right now */
	applied: { model?: string; effort?: string };
	/** whether the session's model takes a thinking level (its config options have an effort select) */
	hasEffort: boolean;
	creating: Promise<string> | undefined;
	attaching: Promise<void> | undefined;
	turn: ITurnState | undefined;
	/** `session/update`s collected while `session/load` replays the history */
	replay: IAcpSessionUpdate[] | undefined;
	/** permission requests waiting for the person, by tool call id */
	readonly permissions: Map<string, (approved: boolean | undefined) => void>;
	/** OpenCode's questions waiting for the person, by its request id (`que_…`) */
	readonly questions: Map<string, { readonly directory: string; readonly generation: number; readonly asked: readonly IOpenCodeQuestion[]; readonly turnId: string }>;
	/** the last `session/prompt` until OpenCode answers it (a stopped turn winds down for a moment) */
	inflight: Promise<unknown> | undefined;
	/** OpenCode's title for the session went to the host (onDidSuggestChatTitle) */
	titled: boolean;
	/** what OpenCode was told while no turn of ours ran (`user_message_chunk`): the message of its own turn */
	ownPrompt: string | undefined;
	/** tool calls of turns that ended: a late update for one of them starts no turn of OpenCode's own */
	readonly pastTools: Set<string>;
	disposed: boolean;
}

let partCounter = 0;

/** What an OpenCode chat may be set to in the window: how much is approved without asking (resolveChatConfig). */
const opencodeChatConfigSchema = createSchema({
	[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
	[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
});

/** A config file as OpenCode's process sees it, less the default models the harness sets per session itself. */
function configWithoutDefaults(file: string): string {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
	const config = parseJsonc(text);
	if (!config) {
		return text;
	}
	const rest = { ...config };
	delete rest.model;
	delete rest.small_model;
	return JSON.stringify(rest);
}

/**
 * The resident `opencode acp` process. `ensure()` starts it (and runs `initialize`) the first time
 * and again after it exited; every start is a new generation, and a session is only usable in the
 * generation that loaded it.
 */
class OpenCodeProcess extends Disposable {
	private _client: OpenCodeAcpClient | undefined;
	private _starting: Promise<OpenCodeAcpClient> | undefined;
	private _generation = 0;
	/**
	 * OpenCode's config or credentials changed since the process started. It reads them once, so it
	 * still has the old ones (a provider added with `opencode auth login` is unknown to it).
	 */
	private _stale = false;

	private readonly _onNotification = this._register(new Emitter<IAcpNotification>());
	readonly onNotification = this._onNotification.event;

	private readonly _onExit = this._register(new Emitter<{ generation: number; reason: string }>());
	readonly onExit = this._onExit.event;

	private readonly _onQuestion = this._register(new Emitter<{ generation: number; event: IOpenCodeQuestionEvent }>());
	/** a question event from the running process's own server (opencodeQuestions.ts) */
	readonly onQuestion = this._onQuestion.event;
	private readonly _onDidStart = this._register(new Emitter<number>());
	/** a new process is ready (its generation) */
	readonly onDidStart = this._onDidStart.event;
	private readonly _onStream = this._register(new Emitter<OpenCodeStreamEvent>());
	/** Dispatch IDE: parts and messages of every session from the process's own server (a sub-agent's steps) */
	readonly onStream = this._onStream.event;
	private readonly _onServerConnect = this._register(new Emitter<number>());
	/** the question events are (again) followed: questions asked meanwhile can be looked up */
	readonly onServerConnect = this._onServerConnect.event;
	private _server: OpenCodeServer | undefined;

	requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;

	constructor(
		/** the copy to run; looked at again for every start, so an upgrade needs no restart of the window */
		private readonly _resolve: () => Promise<IOpenCodePick | undefined>,
		private readonly _env: () => NodeJS.ProcessEnv,
		private readonly _log: ILogService,
	) {
		super();
	}

	get generation(): number {
		return this._generation;
	}

	get running(): OpenCodeAcpClient | undefined {
		return this._client && !this._client.exited ? this._client : undefined;
	}

	/** The running process's own HTTP server (its questions and their answers). */
	get server(): OpenCodeServer | undefined {
		return this.running ? this._server : undefined;
	}

	/** The files OpenCode reads at start changed: the next {@link ensure} while nothing runs starts a new process. */
	markStale(): void {
		if (this.running || this._starting) {
			this._stale = true;
		}
	}

	/**
	 * The running process, started when there is none. A stale one (see {@link markStale}) is replaced
	 * when `idle` says no turn needs it; sessions it had are resumed in the new one.
	 */
	ensure(idle: () => boolean = () => false): Promise<OpenCodeAcpClient> {
		let running = this.running;
		if (running && this._stale && idle()) {
			this._stale = false;
			this._log.info(`[OpenCode] config or credentials changed: a new process replaces ${running.pid}`);
			this._client = undefined;
			running.dispose();
			running = undefined;
		}
		if (running) {
			return Promise.resolve(running);
		}
		if (!this._starting) {
			this._starting = this._start().finally(() => { this._starting = undefined; });
		}
		return this._starting;
	}

	private async _start(): Promise<OpenCodeAcpClient> {
		// Before anything starts: a copy older than OPENCODE_MIN_VERSION would answer the first session with 401
		const pick = await this._resolve();
		if (!pick) {
			throw new Error('OpenCode is not installed.');
		}
		if (!pick.supported) {
			this._log.warn(`[OpenCode] ${openCodeTooOldMessage(pick)} (${pick.candidates.map(c => `${c.path} ${c.version?.join('.') ?? '?'}`).join(', ')})`);
			throw new Error(openCodeTooOldMessage(pick));
		}
		const generation = ++this._generation;
		this._stale = false;
		const started = Date.now();
		// the question tool on, and the server inside the process on a port and password of ours: its
		// questions come from there (ACP has no request for them)
		const port = await freePort();
		const password = newServerPassword();
		const env = { ...this._env(), [OPENCODE_QUESTION_TOOL_ENV]: '1', [OPENCODE_SERVER_PASSWORD_ENV]: password };
		const client = new OpenCodeAcpClient(pick.binary, ['acp', '--hostname', '127.0.0.1', '--port', String(port)], os.homedir(), env, message => this._log.info(message));
		this._client = client;
		let server: OpenCodeServer | undefined;
		client.onNotification(n => this._onNotification.fire(n));
		client.onExit(reason => {
			this._log.info(`[OpenCode] process ${client.pid} (generation ${generation}): ${reason}`);
			if (this._client === client) {
				this._client = undefined;
			}
			if (server) {
				if (this._server === server) {
					this._server = undefined;
				}
				server.dispose();
			}
			client.dispose();
			this._onExit.fire({ generation, reason });
		});
		client.requestHandler = (method, params) => this.requestHandler ? this.requestHandler(method, params) : Promise.reject(new AcpError(-32601, `${method} is not supported`));
		try {
			const init = await client.request<{ agentInfo?: { version?: string } }>('initialize', {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: 'dispatch-ide', title: 'Dispatch IDE', version: '1' },
			}, REQUEST_TIMEOUT_MS);
			this._log.info(`[OpenCode] process ${client.pid} ready: OpenCode ${init?.agentInfo?.version ?? '?'} in ${Date.now() - started} ms`);
			this._onDidStart.fire(generation);
			if (!client.exited) {
				server = new OpenCodeServer(port, password, message => this._log.info(message));
				this._server?.dispose();
				this._server = server;
				server.listen(event => this._onQuestion.fire({ generation, event }), () => this._onServerConnect.fire(generation), event => this._onStream.fire(event));
			}
			return client;
		} catch (error) {
			if (this._client === client) {
				this._client = undefined;
			}
			client.dispose();
			throw error;
		}
	}

	override dispose(): void {
		this._server?.dispose();
		this._server = undefined;
		this._client?.dispose();
		this._client = undefined;
		super.dispose();
	}
}

export class OpenCodeAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = OPENCODE_AGENT_PROVIDER_ID;
	readonly agentHostCapabilities = { workspaceConversion: false } as const;

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;
	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;
	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;
	private readonly _onDidSuggestChatTitle = this._register(new Emitter<{ readonly chat: URI; readonly title: string }>());
	readonly onDidSuggestChatTitle = this._onDidSuggestChatTitle.event;
	readonly onDidSpawnChat = Event.None;
	private readonly _onDidDiscoverChats = this._register(new Emitter<readonly IAgentDiscoveredChat[]>());
	readonly onDidDiscoverChats = this._onDidDiscoverChats.event;
	/** OpenCode's own sessions, kept in memory and on disk and read again when its database changes (opencodeSessionIndex.ts) */
	private _sessionIndex: OpenCodeSessionIndex | undefined;
	private _databasePath: Promise<string | undefined> | undefined;
	private _discovery: Promise<void> | undefined;
	/** The OpenCode sessions discovery has reported in this process */
	private readonly _discovered = new Set<string>();

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this._models;
	private _openCodeModels: IOpenCodeModel[] = [];
	private _providerNames = new Map<string, string>();
	private _defaultModel: string | undefined;

	private readonly _chats = new Map<string, IChatState>();
	private readonly _chatsBySession = new Map<string, IChatState>();
	private readonly _subagents = new OpenCodeSubagentMirror(
		sessionId => {
			const state = this._chatsBySession.get(sessionId);
			return state ? { chat: state.chat, turnId: state.turn?.id } : undefined;
		},
		(chat, parentToolCallId, action) => this._onDidChatProgress.fire({ kind: 'action', resource: chat, parentToolCallId, action }),
	);
	/** Dispatch IDE: OpenCode's command list per ACP session (`available_commands_update`), and the last one per folder. */
	private readonly _availableCommands = new Map<string, readonly IAcpAvailableCommand[]>();
	private readonly _availableCommandsByCwd = new Map<string, readonly IAcpAvailableCommand[]>();
	/** folders OpenCode has started an instance for, in the current process generation */
	private readonly _warmFolders = new Map<string, Promise<void>>();
	private readonly _firstBinary: string;
	private readonly _process: OpenCodeProcess;
	private readonly _refreshModelsSoon: RunOnceScheduler;
	/** Dispatch IDE (opencode-kit): the app's plugin kit into OpenCode's config folders before it starts, so it does not wait for npm */
	private readonly _kit: DispatchOpenCodeKit;

	constructor(
		binary: string | undefined,
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
		this._firstBinary = binary ?? findOpenCode() ?? 'opencode';
		this._kit = new DispatchOpenCodeKit(() => this._env(), this._logService);
		this._process = this._register(new OpenCodeProcess(() => this._kit.prepare().then(() => this._pick()), () => this._env(), this._logService));
		this._process.requestHandler = (method, params) => this._onAgentRequest(method, params);
		this._register(this._process.onNotification(n => this._onNotification(n)));
		this._register(this._process.onExit(e => this._onProcessExit(e.generation, e.reason)));
		this._register(this._process.onQuestion(e => this._onQuestion(e.generation, e.event)));
		this._register(this._process.onServerConnect(generation => void this._syncQuestions(generation)));
		// Dispatch IDE: a sub-agent's steps from OpenCode's server, into its chat under the session (opencodeSubagentMirror.ts)
		this._register(this._process.onStream(e => this._subagents.onEvent(e)));
		// the models again once a process runs: a list made while the machine was busy can miss the providers
		// whose keys come from the environment (seen under load: 5 providers of 16)
		this._register(this._process.onDidStart(() => this._refreshModelsSoon.schedule()));
		this._refreshModelsSoon = this._register(new RunOnceScheduler(() => void this.refreshModels(), 2000));
		this._watchConfig();
		void this.refreshModels();
	}

	// Dispatch IDE (diff notes): the host's tools, to read the notes Submit Feedback sends (dispatchOpenCodeFeedback.ts)
	private _serverToolHost: IAgentServerToolHost | undefined;
	setServerToolHost(host: IAgentServerToolHost): void {
		this._serverToolHost = host;
	}

	getDescriptor(): IAgentDescriptor {
		// Dispatch IDE (opencode-first-run): `preparing` until the first model list comes
		return { provider: OPENCODE_AGENT_PROVIDER_ID, displayName: 'OpenCode', description: localize('opencode.description', "OpenCode with your own providers and keys"), ...(this._preparing ? { preparing: true } : {}) };
	}

	private _env(): NodeJS.ProcessEnv {
		return opencodeEnv();
	}

	/** The copy to run now: the first one that is new enough, else the newest (`supported` false). Versions are asked once per file. */
	private _pick(): Promise<IOpenCodePick | undefined> {
		const env = this._env();
		return resolveOpenCode(env['PATH'] ?? '', env);
	}

	/** The binary for commands that only read (models, its database): the picked copy, whatever its version. */
	private async _binary(): Promise<string> {
		return (await this._pick())?.binary ?? this._firstBinary;
	}

	// ---- models ---------------------------------------------------------------

	private _modelAttempts = 0;
	/** Providers the last listing missed and that are still shown (keepMissingProviders). */
	private _missedProviders: ReadonlySet<string> = new Set();

	/** Dispatch IDE (opencode-first-run): the first model list has not come yet (the picker says OpenCode is getting ready). */
	private _preparing = true;
	/** Settles once the first listing without plugins is over (`opencode db` reads OpenCode's own sessions after it, see _readSessionsWithCli). */
	private _quickListedDone: () => void = () => { };
	private readonly _quickListed = new Promise<void>(resolve => this._quickListedDone = resolve);
	private _listing: Promise<void> | undefined;
	private _listAgain = false;

	/** One listing at a time: a refresh asked for while one runs runs once more after it. */
	refreshModels(): Promise<void> {
		if (this._listing) {
			this._listAgain = true;
			return this._listing;
		}
		this._listing = (async () => {
			do {
				this._listAgain = false;
				await this._refreshModels();
			} while (this._listAgain);
		})().finally(() => this._listing = undefined);
		return this._listing;
	}

	/**
	 * `opencode models --verbose`. `pure` runs it without plugins (OPENCODE_PURE): OpenCode installs its plugin kit
	 * from npm into its config folder on the first start that loads any plugin (Dispatch's own included), and that
	 * start waits for npm: seconds on a good network, minutes on a slow one, about five when npm cannot be reached.
	 * The model list does not need plugins.
	 */
	private async _listModels(pure: boolean, timeout: number, binary?: string): Promise<IOpenCodeModel[]> {
		binary ??= await this._binary();
		if (!pure) {
			await this._kit.prepare(); // Dispatch IDE (opencode-kit): plugins load, so the kit must be there
		}
		const env = pure ? { ...this._env(), OPENCODE_PURE: '1' } : this._env();
		const started = Date.now();
		// Dispatch IDE (opencode-models-retry): on a busy Mac the listing can take over a minute
		const stdout = await new Promise<string>(resolve => execFile(binary, ['models', '--verbose'], { env, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, out) => {
			if (error) {
				this._logService.warn(`[OpenCode] opencode models${pure ? ' (without plugins)' : ''} failed after ${Math.round((Date.now() - started) / 1000)} s: ${error.message}`);
			}
			resolve(out ?? '');
		}).stdin?.end()); // Dispatch IDE: newer OpenCode reads stdin to its end first; an open pipe kept it waiting
		return parseOpenCodeModels(stdout);
	}

	private async _refreshModels(): Promise<void> {
		// Dispatch IDE (opencode-first-run): the first list comes without plugins, in a second or two, so OpenCode is
		// in the engine picker at once (a new Mac waited six minutes and more for it); the full list (plugins can add
		// providers) follows and replaces it. The full one may take as long as OpenCode's first install of its plugin
		// kit does: that install is done once, here, before the first chat, so it gets ten minutes.
		// It runs the copy found first, without waiting for every copy's --version (seconds on a Mac busy starting up);
		// OpenCode's own sessions are read after it, not at the same time (both would set up its new database at once).
		if (!this._openCodeModels.length) {
			const quick = await this._listModels(true, 30_000, this._firstBinary);
			if (quick.length && !this._openCodeModels.length) {
				this._takeModels(quick, 'without plugins');
			}
		}
		this._quickListedDone();
		const models = await this._listModels(false, this._openCodeModels.length ? 10 * 60_000 : 120_000);
		if (!models.length) {
			// no models yet: OpenCode would stay greyed out in the engine picker, so ask again a little later
			if (!this._openCodeModels.length && this._modelAttempts < 5) {
				const delay = 5000 * 2 ** this._modelAttempts++;
				this._logService.info(`[OpenCode] no models listed: trying again in ${delay / 1000} s`);
				const timer = setTimeout(() => void this.refreshModels(), delay);
				this._register(toDisposable(() => clearTimeout(timer)));
			} else if (!this._openCodeModels.length && this._preparing) {
				// given up: the picker says No models available rather than getting ready
				this._preparing = false;
				this._models.set([], undefined);
			}
			return;
		}
		this._modelAttempts = 0;
		this._takeModels(models, 'with plugins');
	}

	private _takeModels(models: IOpenCodeModel[], how: string): void {
		this._preparing = false;
		// a provider this listing missed stays while OpenCode keeps its key, else until the next listing misses it too (opencodeModelKeep.ts)
		const readJson = (file: string) => { try { return parseJsonc(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
		const configured = configuredProviders(readJson(path.join(opencodePaths().data, 'auth.json')), opencodeConfigFiles().map(readJson));
		const sure = keepMissingProviders(this._openCodeModels, models, this._missedProviders, configured);
		this._missedProviders = new Set(sure.kept.filter(p => !configured.has(p)));
		if (this._missedProviders.size) {
			this._logService.info(`[OpenCode] the listing missed ${[...this._missedProviders].join(', ')}: kept for now, listing again in ${MISSED_PROVIDER_RECHECK_MS / 1000} s`);
			const timer = setTimeout(() => void this.refreshModels(), MISSED_PROVIDER_RECHECK_MS);
			this._register(toDisposable(() => clearTimeout(timer)));
		}
		if (sure.kept.some(p => configured.has(p))) {
			this._logService.info(`[OpenCode] the listing missed ${sure.kept.filter(p => configured.has(p)).join(', ')}, whose key OpenCode keeps: still listed`);
		}
		if (sure.dropped.length) {
			this._logService.info(`[OpenCode] ${sure.dropped.join(', ')} missed twice in a row: no longer listed`);
		}
		this._openCodeModels = [...sure.models];
		const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };
		const learned = this._providerNames;
		this._providerNames = readProviderNames(read(path.join(opencodePaths().cache, 'models.json')), opencodeConfigFiles().map(read));
		for (const [id, name] of learned) {
			if (!this._providerNames.has(id)) {
				this._providerNames.set(id, name);
			}
		}
		this._defaultModel = readDefaultModel(read);
		this._publishModels();
		this._logService.info(`[OpenCode] ${models.length} models from ${new Set(models.map(m => m.providerId)).size} providers (${how}), default ${this._defaultModel ?? '(none)'}`);
	}

	private _publishModels(): void {
		this._models.set(toAgentModels(this._openCodeModels, this._providerNames, this._defaultModel), undefined);
	}

	/** Provider names a session's model option knows and the models.dev cache did not (a custom provider). */
	private _learnNames(options: readonly IAcpConfigOption[] | undefined): void {
		const model = options?.find(o => o.category === 'model' || o.id === 'model');
		if (!model?.options) {
			return;
		}
		let changed = false;
		for (const [id, name] of namesFromModelOption(model.options)) {
			if (name && !this._providerNames.has(id)) {
				this._providerNames.set(id, name);
				changed = true;
			}
		}
		if (changed && this._openCodeModels.length) {
			this._publishModels();
		}
	}

	/**
	 * OpenCode's config and keys: a change lists the models again (a provider added, the default
	 * changed). The files are polled (every 5 s, a stat each): a folder watch would also fire for
	 * every write OpenCode makes to its database next to auth.json.
	 */
	private _watchConfig(): void {
		const auth = path.join(opencodePaths().data, 'auth.json');
		const files = [...opencodeConfigFiles(), auth];
		for (const file of files) {
			let seen = file === auth ? '' : configWithoutDefaults(file);
			const listener = (current: fs.Stats, previous: fs.Stats) => {
				if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
					this._logService.info(`[OpenCode] ${path.basename(file)} changed: listing the models again`);
					this._refreshModelsSoon.schedule();
					// a new key or provider needs a new process; a new default model does not (sessions set theirs)
					const now = file === auth ? String(current.mtimeMs) : configWithoutDefaults(file);
					if (file === auth || now !== seen) {
						this._process.markStale();
					}
					seen = now;
				}
			};
			fs.watchFile(file, { interval: 5000, persistent: false }, listener);
			this._register(toDisposable(() => fs.unwatchFile(file, listener)));
		}
	}

	// ---- the process and its sessions ---------------------------------------

	private _state(chat: URI): IChatState {
		const key = chat.toString();
		let state = this._chats.get(key);
		if (!state) {
			const now = Date.now();
			state = {
				chat, session: undefined, created: now, modified: now, cwd: undefined, model: undefined, sessionId: undefined, attachedGeneration: undefined,
				applied: {}, hasEffort: false, creating: undefined, attaching: undefined, turn: undefined, replay: undefined, permissions: new Map(), questions: new Map(), inflight: undefined, titled: false, ownPrompt: undefined, pastTools: new Set(), disposed: false,
			};
			this._chats.set(key, state);
		}
		return state;
	}

	private _bindSession(state: IChatState, sessionId: string): void {
		state.sessionId = sessionId;
		this._chatsBySession.set(sessionId, state);
	}

	private _fire(state: IChatState, action: ChatAction | SessionAction): void {
		this._onDidChatProgress.fire({ kind: 'action', resource: state.chat, action });
	}

	private _persisted(state: IChatState): string | undefined {
		return state.sessionId ? encodeOpenCodeChat({
			opencodeSessionId: state.sessionId,
			...(state.cwd ? { cwd: state.cwd } : {}),
			...(state.model ? { model: state.model } : {}),
		}) : undefined;
	}

	/**
	 * Start OpenCode's instance for a folder ahead of the first message (about a second per folder,
	 * more on the first one after a start): a load of a session id that does not exist makes OpenCode
	 * open the folder, then fails, and creates nothing.
	 */
	private _warm(cwd: string | undefined): void {
		if (!cwd) {
			return;
		}
		const generation = this._process.generation;
		const key = `${generation}:${cwd}`;
		if (this._warmFolders.has(key)) {
			return;
		}
		const warming = (async () => {
			const client = await this._process.ensure(() => this._idle());
			await this._kit.prepare(cwd); // Dispatch IDE (opencode-kit): the folder's own .opencode
			this._logService.info(`[OpenCode] warming ${cwd} (OpenCode logs the expected "service failure" for the made-up session on stderr)`);
			try {
				await client.request('session/load', { sessionId: 'ses_dispatch_warm_folder', cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);
			} catch {
				// expected: the session does not exist, the folder is open now
			}
		})();
		this._warmFolders.set(key, warming.catch(error => this._logService.info(`[OpenCode] warming ${cwd} failed: ${String(error)}`)));
	}

	/** No chat but `except` has a turn running or a question waiting: the process can be replaced. */
	private _idle(except?: IChatState): boolean {
		for (const state of this._chats.values()) {
			if (state !== except && (state.turn || state.creating || state.attaching || state.replay || state.permissions.size)) {
				return false;
			}
		}
		return true;
	}

	/** The chat's ACP session, loaded in the running process: created (first message) or resumed (after a restart). */
	private async _ensureSession(state: IChatState): Promise<{ client: OpenCodeAcpClient; sessionId: string }> {
		const client = await this._process.ensure(() => this._idle(state));
		const generation = this._process.generation;
		if (!state.sessionId) {
			if (!state.creating) {
				state.creating = (async () => {
					const cwd = state.cwd ?? os.homedir();
					await this._warmFolders.get(`${generation}:${cwd}`);
					await this._kit.prepare(cwd); // Dispatch IDE (opencode-kit): the folder's own .opencode
					const created = await client.request<{ sessionId: string; configOptions?: IAcpConfigOption[] }>('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);
					this._bindSession(state, created.sessionId);
					state.cwd = cwd;
					const commands = this._availableCommands.get(created.sessionId);
					if (commands) {
						this._availableCommandsByCwd.set(cwd, commands);
					}
					state.attachedGeneration = generation;
					this._readOptions(state, created.configOptions);
					this._logService.info(`[OpenCode] session ${created.sessionId} in ${cwd}`);
					this._onDidMaterializeChat.fire({
						chat: state.chat,
						project: undefined,
						workingDirectories: [URI.file(cwd)],
						result: { providerData: this._persisted(state), ...this._backing(state) },
					});
					return created.sessionId;
				})().finally(() => { state.creating = undefined; });
			}
			const sessionId = await state.creating;
			return { client, sessionId };
		}
		if (state.attachedGeneration !== generation) {
			if (!state.attaching) {
				state.attaching = (async () => {
					// the process started again since this session was loaded: pick it up without replaying it
					const resumed = await client.request<{ configOptions?: IAcpConfigOption[] }>('session/resume', { sessionId: state.sessionId, cwd: state.cwd ?? os.homedir(), mcpServers: [] }, REQUEST_TIMEOUT_MS);
					state.attachedGeneration = generation;
					state.applied = {};
					this._readOptions(state, resumed?.configOptions);
				})().finally(() => { state.attaching = undefined; });
			}
			await state.attaching;
		}
		return { client, sessionId: state.sessionId };
	}

	/** What the session's config options say OpenCode has now: its model, its effort, whether it takes one. */
	private _readOptions(state: IChatState, options: readonly IAcpConfigOption[] | undefined): void {
		if (!options) {
			return;
		}
		this._learnNames(options);
		const model = options.find(o => o.id === 'model' || o.category === 'model');
		const effort = options.find(o => o.id === 'effort' || o.category === 'thought_level');
		if (typeof model?.currentValue === 'string') {
			state.applied.model = model.currentValue;
		}
		state.hasEffort = !!effort?.options?.length;
		state.applied.effort = typeof effort?.currentValue === 'string' ? effort.currentValue : undefined;
	}

	/** Bring the session to the chat's model and thinking level before a prompt. */
	private async _applySettings(state: IChatState, client: OpenCodeAcpClient, sessionId: string): Promise<void> {
		const model = state.model?.id;
		if (model && model !== state.applied.model) {
			try {
				const r = await client.request<{ configOptions?: IAcpConfigOption[] }>('session/set_config_option', { sessionId, configId: 'model', value: model }, REQUEST_TIMEOUT_MS);
				state.applied.model = model;
				this._readOptions(state, r?.configOptions);
			} catch (error) {
				this._logService.warn(`[OpenCode] could not set model ${model}: ${String(error)}`);
			}
		}
		const effort = opencodeEffortOf(state.model);
		if (state.hasEffort && effort !== (state.applied.effort ?? OPENCODE_DEFAULT_EFFORT)) {
			try {
				const r = await client.request<{ configOptions?: IAcpConfigOption[] }>('session/set_config_option', { sessionId, configId: 'effort', value: effort }, REQUEST_TIMEOUT_MS);
				state.applied.effort = effort;
				this._readOptions(state, r?.configOptions);
			} catch (error) {
				this._logService.warn(`[OpenCode] could not set thinking level ${effort}: ${String(error)}`);
			}
		}
	}

	private _onProcessExit(generation: number, reason: string): void {
		for (const key of [...this._warmFolders.keys()]) {
			if (key.startsWith(`${generation}:`)) {
				this._warmFolders.delete(key);
			}
		}
		for (const state of this._chats.values()) {
			if (state.attachedGeneration !== generation) {
				continue;
			}
			state.attachedGeneration = undefined;
			state.applied = {};
			state.questions.clear();
			const turn = state.turn;
			if (turn) {
				this._closeOpenTools(state, turn, true);
				state.turn = undefined;
				this._fire(state, { type: ActionType.ChatError, turnId: turn.id, duration: Date.now() - turn.started, part: createErrorResponsePart({ errorType: 'opencode', message: localize('opencode.exited', "OpenCode stopped ({0}). Send the message again to go on.", reason) }) });
			}
		}
	}

	// ---- turns ----------------------------------------------------------------

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined): Promise<void> {
		const state = this._state(chat);
		const folder = workingDirectories?.[0];
		if (folder?.scheme === 'file' && folder.fsPath !== state.cwd) {
			if (!state.sessionId) {
				state.cwd = folder.fsPath;
			} else {
				// an OpenCode session belongs to its folder; the chat goes on where it started
				this._logService.warn(`[OpenCode] ${chat.toString()} runs in ${state.cwd}, not ${folder.fsPath}`);
			}
		}
		const turn: ITurnState = { id: turnId ?? `opencode-turn-${Date.now()}`, started: Date.now(), timing: {}, cancelled: false, markdownPartId: undefined, reasoningPartId: undefined, tools: new Map() };
		state.turn = turn;
		state.modified = Date.now();
		let client: OpenCodeAcpClient;
		let sessionId: string;
		try {
			({ client, sessionId } = await this._ensureSession(state));
			await this._applySettings(state, client, sessionId);
			turn.timing.ready = Date.now() - turn.started;
		} catch (error) {
			this._endTurnWithError(state, turn, error);
			return;
		}
		if (turn.cancelled || state.turn !== turn) {
			return;
		}
		// Host instructions (title, artifact and plan-link rules) name tools OpenCode does not have, and
		// would be stored in OpenCode's history as part of the person's message: not forwarded.
		// Dispatch IDE (diff notes): OpenCode cannot read the notes from the host, so they go in the message
		const notes = await diffNotesPrompt(this._serverToolHost, chat, prompt, attachments, state.cwd, this._logService);
		if (turn.cancelled || state.turn !== turn) {
			return;
		}
		turn.notes = notes?.ids;
		void this._runTurn(state, turn, client, sessionId, toPromptBlocks(notes?.prompt ?? prompt, attachments));
	}

	private async _runTurn(state: IChatState, turn: ITurnState, client: OpenCodeAcpClient, sessionId: string, blocks: Record<string, unknown>[]): Promise<void> {
		try {
			// a turn stopped a moment ago may still be winding down in OpenCode: let it answer first
			if (state.inflight) {
				await Promise.race([state.inflight.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 15_000))]);
				if (state.turn !== turn || turn.cancelled) {
					return;
				}
			}
			const prompt = client.request<{ stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number } }>('session/prompt', { sessionId, prompt: blocks });
			state.inflight = prompt;
			const result = await prompt.finally(() => {
				if (state.inflight === prompt) {
					state.inflight = undefined;
				}
			});
			if (state.turn !== turn) {
				return; // cancelled by the host, or the process exited: already ended
			}
			const cancelled = turn.cancelled || result?.stopReason === 'cancelled';
			this._closeOpenTools(state, turn, cancelled);
			state.turn = undefined;
			state.modified = Date.now();
			this._logTiming(state, turn, result?.stopReason ?? '?');
			this._suggestTitle(state);
			if (result?.usage && !cancelled) {
				this._fire(state, {
					type: ActionType.ChatUsage, turnId: turn.id, usage: {
						...(typeof result.usage.inputTokens === 'number' ? { inputTokens: result.usage.inputTokens } : {}),
						...(typeof result.usage.outputTokens === 'number' ? { outputTokens: result.usage.outputTokens } : {}),
						...(typeof result.usage.cachedReadTokens === 'number' ? { cacheReadTokens: result.usage.cachedReadTokens } : {}),
						...(state.applied.model ? { model: state.applied.model } : {}),
					},
				});
			}
			if (result?.stopReason === 'refusal') {
				this._fire(state, { type: ActionType.ChatError, turnId: turn.id, duration: Date.now() - turn.started, part: createErrorResponsePart({ errorType: 'opencode', message: localize('opencode.refusal', "The model refused to go on.") }) });
				return;
			}
			if (turn.notes?.length && !cancelled) {
				await resolveDiffNotes(this._serverToolHost, state.chat, turn.notes, this._logService);
			}
			this._fire(state, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration: Date.now() - turn.started });
		} catch (error) {
			if (state.turn === turn) {
				this._endTurnWithError(state, turn, error);
			}
		}
	}

	/**
	 * OpenCode names a session with a small model while its first turn runs. The name goes to the host
	 * once (it replaces the first-message title unless the person renamed the chat): at the end of a
	 * turn, else a few seconds later, when OpenCode has it.
	 */
	private _suggestTitle(state: IChatState, attempt = 0): void {
		const client = this._process.running;
		if (state.titled || state.disposed || !state.sessionId || !client) {
			return;
		}
		const sessionId = state.sessionId;
		client.request<{ sessions?: { sessionId?: string; title?: string }[] }>('session/list', { cwd: state.cwd ?? os.homedir() }, REQUEST_TIMEOUT_MS).then(result => {
			const title = result?.sessions?.find(s => s.sessionId === sessionId)?.title?.trim();
			if (state.titled || state.disposed) {
				return;
			}
			if (title && !/^(New|Child) session - /.test(title)) {
				state.titled = true;
				this._logService.info(`[OpenCode] ${sessionId} is titled "${title}"`);
				this._onDidSuggestChatTitle.fire({ chat: state.chat, title });
			} else if (attempt < 2) {
				setTimeout(() => this._suggestTitle(state, attempt + 1), attempt === 0 ? 4000 : 12000);
			}
		}, () => { /* an OpenCode without session/list: the first message stays the title */ });
	}

	/** One line per turn: how long the session took to be ready, OpenCode's first update and first tool call. */
	private _logTiming(state: IChatState, turn: ITurnState, how: string): void {
		const t = turn.timing;
		const ms = (v: number | undefined) => v === undefined ? '-' : `${v} ms`;
		this._logService.info(`[OpenCode] turn ${how} in ${Date.now() - turn.started} ms (${state.applied.model ?? 'default model'}): session ready ${ms(t.ready)}, first update ${ms(t.firstUpdate)}, first tool ${ms(t.firstTool)}`);
	}

	private _endTurnWithError(state: IChatState, turn: ITurnState, error: unknown): void {
		this._closeOpenTools(state, turn, true);
		if (state.turn === turn) {
			state.turn = undefined;
		}
		const message = error instanceof Error ? error.message : String(error);
		this._logService.warn(`[OpenCode] turn failed: ${message}`);
		this._fire(state, { type: ActionType.ChatError, turnId: turn.id, duration: Date.now() - turn.started, part: createErrorResponsePart({ errorType: 'opencode', message: localize('opencode.failed', "OpenCode: {0}", message) }) });
	}

	private _onNotification(n: IAcpNotification): void {
		if (n.method !== 'session/update') {
			return;
		}
		const sessionId = n.params['sessionId'];
		const update = n.params['update'] as IAcpSessionUpdate | undefined;
		// Dispatch IDE: OpenCode's command list, for the slash menu. Kept by session before the session is
		// bound: after `session/new` it can arrive ahead of the answer.
		if (update?.sessionUpdate === 'available_commands_update' && typeof sessionId === 'string') {
			const commands = readAvailableCommands(update['availableCommands']);
			this._availableCommands.set(sessionId, commands);
			const bound = this._chatsBySession.get(sessionId);
			if (bound?.cwd) {
				this._availableCommandsByCwd.set(bound.cwd, commands);
			}
			return;
		}
		const state = typeof sessionId === 'string' ? this._chatsBySession.get(sessionId) : undefined;
		if (!state || !update || state.disposed) {
			return;
		}
		if (state.replay) {
			state.replay.push(update);
			return;
		}
		if (update.sessionUpdate === 'config_option_update') {
			this._readOptions(state, update['configOptions'] as IAcpConfigOption[] | undefined);
			return;
		}
		const text = update.content && typeof update.content === 'object' && !Array.isArray(update.content) ? (update.content as { text?: unknown }).text : undefined;
		let turn = state.turn;
		if (!turn) {
			turn = this._ownTurnFor(state, update, text);
			if (!turn) {
				return;
			}
		}
		if (turn.cancelled) {
			return;
		}
		if (turn.own) {
			this._armOwnTurnEnd(state, turn, update.sessionUpdate === 'usage_update' ? OWN_TURN_QUIET_AFTER_USAGE_MS : OWN_TURN_QUIET_MS);
		}
		turn.timing.firstUpdate ??= Date.now() - turn.started;
		if (update.sessionUpdate === 'tool_call') {
			turn.timing.firstTool ??= Date.now() - turn.started;
		}
		switch (update.sessionUpdate) {
			case 'agent_message_chunk': {
				if (typeof text !== 'string' || !text) {
					return;
				}
				turn.reasoningPartId = undefined;
				if (!turn.markdownPartId) {
					turn.markdownPartId = `opencode-md-${++partCounter}`;
					this._fire(state, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Markdown, id: turn.markdownPartId, content: text } });
				} else {
					this._fire(state, { type: ActionType.ChatDelta, turnId: turn.id, partId: turn.markdownPartId, content: text });
				}
				return;
			}
			case 'agent_thought_chunk': {
				if (typeof text !== 'string' || !text) {
					return;
				}
				turn.markdownPartId = undefined;
				if (!turn.reasoningPartId) {
					turn.reasoningPartId = `opencode-rs-${++partCounter}`;
					this._fire(state, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Reasoning, id: turn.reasoningPartId, content: text } });
				} else {
					this._fire(state, { type: ActionType.ChatReasoning, turnId: turn.id, partId: turn.reasoningPartId, content: text });
				}
				return;
			}
			case 'tool_call':
			case 'tool_call_update':
				this._onToolUpdate(state, turn, update);
				return;
			default:
				return; // usage_update, available_commands_update, plan: nothing the chat shows
		}
	}

	/**
	 * OpenCode can run a turn nobody here asked for: a plugin going on with its to-do list (oh-my-openagent's
	 * todo continuation), a background task reporting back. What it was told arrives first as
	 * `user_message_chunk`; its first word or tool call opens the turn in the host (a provider-promoted
	 * turn) with that message. Updates that trail a turn of ours (stopped, or a late tool status) open none.
	 */
	private _ownTurnFor(state: IChatState, update: IAcpSessionUpdate, text: unknown): ITurnState | undefined {
		if (state.inflight || state.creating || state.attaching) {
			return undefined; // our own prompt is still winding down
		}
		if (update.sessionUpdate === 'user_message_chunk') {
			if (typeof text === 'string') {
				state.ownPrompt = (state.ownPrompt ?? '') + text;
			}
			return undefined;
		}
		const starts = ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') && typeof text === 'string' && text.trim().length > 0)
			|| (update.sessionUpdate === 'tool_call' && !!update.toolCallId && !state.pastTools.has(update.toolCallId));
		if (!starts) {
			return undefined;
		}
		const turn: ITurnState = { id: `opencode-own-${Date.now()}-${++partCounter}`, started: Date.now(), timing: {}, cancelled: false, markdownPartId: undefined, reasoningPartId: undefined, tools: new Map(), own: { quiet: undefined } };
		state.turn = turn;
		state.modified = Date.now();
		const message = openCodeOwnTurnMessage(state.ownPrompt?.trim() ?? '');
		state.ownPrompt = undefined;
		this._logService.info(`[OpenCode] ${state.sessionId} runs a turn of its own: ${message.text.slice(0, 80)}`);
		this._fire(state, { type: ActionType.ChatTurnStarted, turnId: turn.id, startedAt: new Date(turn.started).toISOString(), message });
		return turn;
	}

	/** A turn of OpenCode's own ends once OpenCode is quiet and no tool of it still runs. */
	private _armOwnTurnEnd(state: IChatState, turn: ITurnState, ms: number): void {
		const own = turn.own;
		if (!own) {
			return;
		}
		if (own.quiet) {
			clearTimeout(own.quiet);
		}
		own.quiet = setTimeout(() => {
			own.quiet = undefined;
			if (state.turn !== turn || turn.cancelled || state.disposed) {
				return;
			}
			if ([...turn.tools.values()].some(tool => !tool.done) || state.permissions.size || state.questions.size) {
				this._armOwnTurnEnd(state, turn, OWN_TURN_QUIET_MS);
				return;
			}
			this._closeOpenTools(state, turn, false);
			state.turn = undefined;
			state.modified = Date.now();
			this._logTiming(state, turn, 'of its own');
			this._fire(state, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration: Date.now() - turn.started });
		}, ms);
	}

	private _startTool(state: IChatState, turn: ITurnState, update: IAcpSessionUpdate): IToolState | undefined {
		const toolCallId = update.toolCallId;
		if (!toolCallId) {
			return undefined;
		}
		let tool = turn.tools.get(toolCallId);
		if (!tool) {
			const view = toolView(update);
			tool = { view, ready: false, done: false };
			turn.tools.set(toolCallId, tool);
			turn.markdownPartId = undefined;
			turn.reasoningPartId = undefined;
			const meta = toolMeta(view);
			this._fire(state, { type: ActionType.ChatToolCallStart, turnId: turn.id, toolCallId, toolName: view.name, displayName: toolDisplayName(view), ...(meta ? { _meta: meta } : {}) });
		} else {
			tool.view = toolView(update, tool.view);
		}
		return tool;
	}

	private _makeReady(state: IChatState, turn: ITurnState, toolCallId: string, tool: IToolState): void {
		if (tool.ready) {
			return;
		}
		tool.ready = true;
		this._fire(state, {
			type: ActionType.ChatToolCallReady, turnId: turn.id, toolCallId,
			invocationMessage: toolInvocationMessage(tool.view),
			toolInput: toolInputString(tool.view),
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}

	private _onToolUpdate(state: IChatState, turn: ITurnState, update: IAcpSessionUpdate): void {
		const tool = this._startTool(state, turn, update);
		const toolCallId = update.toolCallId;
		if (!tool || !toolCallId || tool.done) {
			return;
		}
		const status = update.status;
		// ready once OpenCode has sent the input (the first tool_call often has none yet), so the row
		// names the command or file instead of a bare tool name
		if (toolHasInput(tool.view) || status === 'completed' || status === 'failed') {
			this._makeReady(state, turn, toolCallId, tool);
		}
		this._startSubagent(state, toolCallId, tool);
		if (status === 'completed' || status === 'failed') {
			tool.done = true;
			const output = toolOutputText(update);
			const success = status === 'completed';
			const child = tool.subagent ? childSessionOfUpdate(update, output) : undefined;
			if (child) {
				this._subagents.remember(toolCallId, child);
			}
			this._endSubagent(state, turn, toolCallId, tool, subagentAnswer(output));
			const result: ToolCallResult = {
				success,
				pastTenseMessage: toolPastTenseMessage(tool.view, success, output),
				content: output ? [{ type: ToolResultContentType.Text, text: output }] : [],
			};
			this._fire(state, { type: ActionType.ChatToolCallComplete, turnId: turn.id, toolCallId, result });
		}
	}

	/**
	 * Dispatch IDE: a subagent task (OpenCode's `task` tool) becomes a sub-agent of the session, as Claude Code's and
	 * Codex's are: a chat of its own started by the tool, which the sessions list shows under the session while it
	 * works and after (kanban design/terminal-merge A3, patches/135-sub-agent-rows.patch). OpenCode runs it in a
	 * child session whose steps the ACP stream does not carry, so its chat holds the prompt and, once back, its answer.
	 */
	private _startSubagent(state: IChatState, toolCallId: string, tool: IToolState): void {
		const task = tool.subagent ? undefined : subagentTask(tool.view);
		if (!task) {
			return;
		}
		tool.subagent = true;
		this._onDidChatProgress.fire({
			kind: 'subagent_started',
			chat: state.chat,
			toolCallId,
			agentName: task.agentName,
			agentDisplayName: task.agentDisplayName,
			...(task.description ? { taskDescription: task.description } : {}),
			...(task.prompt ? { taskPrompt: task.prompt } : {}),
		});
	}

	private _endSubagent(state: IChatState, turn: ITurnState, toolCallId: string, tool: IToolState, answer: string): void {
		if (!tool.subagent) {
			return;
		}
		tool.subagent = false;
		// Dispatch IDE: its own words are in its chat already when its steps came through (opencodeSubagentMirror.ts)
		const spoke = this._subagents.spoke(toolCallId);
		this._subagents.done(toolCallId);
		if (answer && !spoke) {
			this._onDidChatProgress.fire({
				kind: 'action',
				resource: state.chat,
				parentToolCallId: toolCallId,
				action: { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Markdown, id: `opencode-subagent-${toolCallId}`, content: answer } },
			});
		}
		this._onDidChatProgress.fire({ kind: 'subagent_completed', chat: state.chat, toolCallId });
	}

	/** A turn that ends leaves no tool spinning and no permission waiting. */
	private _closeOpenTools(state: IChatState, turn: ITurnState, cancelled: boolean): void {
		if (turn.own?.quiet) {
			clearTimeout(turn.own.quiet);
			turn.own.quiet = undefined;
		}
		for (const toolCallId of turn.tools.keys()) {
			state.pastTools.add(toolCallId);
		}
		if (state.pastTools.size > 500) {
			state.pastTools.clear();
			turn.tools.forEach((_tool, id) => state.pastTools.add(id));
		}
		for (const [toolCallId, tool] of turn.tools) {
			if (tool.done) {
				continue;
			}
			tool.done = true;
			this._makeReady(state, turn, toolCallId, tool);
			this._endSubagent(state, turn, toolCallId, tool, '');
			const displayName = toolDisplayName(tool.view);
			const pastTenseMessage = cancelled ? localize('opencode.tool.cancelled', "\"{0}\" was cancelled", displayName) : toolPastTenseMessage(tool.view, true);
			this._fire(state, { type: ActionType.ChatToolCallComplete, turnId: turn.id, toolCallId, result: { success: !cancelled, pastTenseMessage, content: [] } });
		}
		for (const resolve of [...state.permissions.values()]) {
			resolve(undefined);
		}
		state.permissions.clear();
		for (const [id, question] of [...state.questions]) {
			if (question.turnId === turn.id) {
				state.questions.delete(id);
				void this._process.server?.reject(id, question.directory).catch(() => { /* already gone with the stopped tool */ });
			}
		}
	}

	// ---- permissions ----------------------------------------------------------

	private async _onAgentRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (method !== 'session/request_permission') {
			throw new AcpError(-32601, `${method} is not supported by this client`);
		}
		const request = params as unknown as IAcpPermissionRequest;
		const state = this._chatsBySession.get(request.sessionId);
		const optionId = state ? await this._askPermission(state, request) : undefined;
		return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
	}

	/** OpenCode asks before a tool runs: the host's confirmation card, answered with the person's choice. */
	private _askPermission(state: IChatState, request: IAcpPermissionRequest): Promise<string | undefined> {
		const turn = state.turn;
		const update = request.toolCall;
		const toolCallId = update?.toolCallId;
		if (!turn || turn.cancelled || !toolCallId) {
			return Promise.resolve(undefined);
		}
		const tool = this._startTool(state, turn, { ...update, sessionUpdate: 'tool_call_update' });
		if (!tool) {
			return Promise.resolve(undefined);
		}
		const allow = request.options.find(o => o.kind === 'allow_once') ?? request.options.find(o => o.kind.startsWith('allow'));
		const reject = request.options.find(o => o.kind === 'reject_once') ?? request.options.find(o => o.kind.startsWith('reject'));
		const permission = toolPermission(tool.view, update);
		const meta = toolMeta(tool.view);
		return new Promise<string | undefined>(resolve => {
			state.permissions.set(toolCallId, approved => {
				state.permissions.delete(toolCallId);
				resolve(approved === undefined ? undefined : approved ? allow?.optionId : reject?.optionId);
			});
			this._onDidChatProgress.fire({
				kind: 'pending_confirmation',
				chat: state.chat,
				state: {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId,
					toolName: tool.view.name,
					displayName: toolDisplayName(tool.view),
					invocationMessage: toolInvocationMessage(tool.view),
					toolInput: toolInputString(tool.view),
					confirmationTitle: permission.title,
					...(meta ? { _meta: meta } : {}),
				},
				permissionKind: permission.kind,
				...(permission.path ? { permissionPath: permission.path } : {}),
				...(permission.kind === 'shell' ? { shellLanguage: 'bash' as const } : {}),
			});
		});
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		for (const state of this._chats.values()) {
			const resolve = state.permissions.get(requestId);
			if (resolve) {
				resolve(approved);
				return;
			}
		}
	}

	respondToUserInputRequest(requestId: string, response: ChatInputResponseKind, answers?: Record<string, ChatInputAnswer>): void {
		for (const state of this._chats.values()) {
			const question = state.questions.get(requestId);
			if (!question) {
				continue;
			}
			state.questions.delete(requestId);
			const server = this._process.server;
			if (!server || question.generation !== this._process.generation) {
				return;
			}
			const answered = response === ChatInputResponseKind.Accept
				? server.reply(requestId, question.directory, toOpenCodeAnswers(question.asked, answers))
				: server.reject(requestId, question.directory);
			answered.catch(error => this._logService.warn(`[OpenCode] could not answer question ${requestId}: ${String(error)}`));
			return;
		}
	}

	// ---- OpenCode's questions ---------------------------------------------------

	/** OpenCode asks (its question tool): the host's question card; answered elsewhere: the card goes. */
	private _onQuestion(generation: number, event: IOpenCodeQuestionEvent): void {
		const props = event.properties;
		const state = props.sessionID ? this._chatsBySession.get(props.sessionID) : undefined;
		if (event.type !== OpenCodeQuestionEventType.Asked) {
			const id = props.requestID;
			if (state && id && state.questions.delete(id)) {
				this._fire(state, { type: ActionType.ChatInputCompleted, requestId: id, response: event.type === OpenCodeQuestionEventType.Replied ? ChatInputResponseKind.Accept : ChatInputResponseKind.Cancel });
			}
			return;
		}
		const id = props.id;
		if (!id || state?.questions.has(id)) {
			return;
		}
		const asked = (props.questions ?? []).filter(q => q && typeof q === 'object');
		const turn = state?.turn;
		if (!state || state.disposed || !turn || turn.cancelled || !asked.length) {
			// nobody here to answer it (no turn of ours): OpenCode goes on without an answer
			void this._process.server?.reject(id, event.directory).catch(() => { });
			return;
		}
		state.questions.set(id, { directory: event.directory, generation, asked, turnId: turn.id });
		this._logService.info(`[OpenCode] ${state.sessionId} asks ${asked.length} question(s)`);
		this._fire(state, { type: ActionType.ChatInputRequested, request: withChatInputRequestPurpose({ id, questions: toChatInputQuestions(asked) }, ChatInputRequestPurpose.AskUser) });
	}

	/** After the question events were (re)connected: questions OpenCode asked meanwhile in a running turn. */
	private async _syncQuestions(generation: number): Promise<void> {
		const server = this._process.server;
		if (!server || generation !== this._process.generation) {
			return;
		}
		const folders = new Set<string>();
		for (const state of this._chats.values()) {
			if (state.turn && state.cwd && state.attachedGeneration === generation) {
				folders.add(state.cwd);
			}
		}
		for (const folder of folders) {
			let pending: Awaited<ReturnType<OpenCodeServer['pending']>>;
			try {
				pending = await server.pending(folder);
			} catch {
				continue;
			}
			for (const properties of pending) {
				this._onQuestion(generation, { type: OpenCodeQuestionEventType.Asked, directory: folder, properties });
			}
		}
	}

	// ---- chats ----------------------------------------------------------------

	readonly chats: IAgentChats = {
		createChat: async (chat: URI, context: URI | IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> => {
			const { configurationResource } = resolveAgentChatContext(context, chat);
			if (options?.fork) {
				throw new Error(localize('opencode.noFork', "OpenCode chats cannot be forked here."));
			}
			const state = this._state(chat);
			state.session = configurationResource;
			state.model = options?.model ?? state.model;
			const folder = options?.workingDirectories?.[0];
			if (folder?.scheme === 'file' && !state.sessionId) {
				state.cwd = folder.fsPath;
			}
			// the process and the folder start while the person writes the first message
			this._warm(state.cwd ?? os.homedir());
			if (state.sessionId) {
				return { providerData: this._persisted(state), ...(state.cwd ? { resolvedWorkingDirectory: URI.file(state.cwd) } : {}) };
			}
			return { provisional: true, ...(state.cwd ? { resolvedWorkingDirectory: URI.file(state.cwd) } : {}) };
		},
		disposeChat: async (chat: URI): Promise<void> => this._disposeChat(chat, true),
		canReleaseChat: async (chat: URI): Promise<boolean> => !this._chats.get(chat.toString())?.turn,
		releaseChat: async (chat: URI): Promise<void> => this._disposeChat(chat, false),
		sendMessage: async (chat: URI, prompt: string, workingDirectoriesOrDirectory: readonly URI[] | URI | undefined, attachments?: readonly MessageAttachment[], turnId?: string, _senderClientId?: string, _clientTypeOrContext?: AgentHostClientType | URI | IAgentChatContext, _context?: URI | IAgentChatContext): Promise<void> => {
			const workingDirectories = URI.isUri(workingDirectoriesOrDirectory) ? [workingDirectoriesOrDirectory] : workingDirectoriesOrDirectory;
			await this._sendMessage(chat, prompt, workingDirectories, attachments, turnId);
		},
		abort: async (chat: URI): Promise<void> => {
			const state = this._chats.get(chat.toString());
			const turn = state?.turn;
			if (!state || !turn) {
				return;
			}
			turn.cancelled = true;
			this._closeOpenTools(state, turn, true);
			state.turn = undefined;
			const client = this._process.running;
			if (client && state.sessionId && state.attachedGeneration === this._process.generation) {
				client.notify('session/cancel', { sessionId: state.sessionId });
			}
		},
		getModel: (chat: URI): ModelSelection | undefined => this._chats.get(chat.toString())?.model,
		changeModel: async (chat: URI, model: ModelSelection): Promise<void> => {
			const state = this._state(chat);
			const changed = JSON.stringify(state.model) !== JSON.stringify(model);
			state.model = model;
			if (changed && state.sessionId) {
				const providerData = this._persisted(state);
				if (providerData) {
					this._onDidChangeChatData.fire({ chat, providerData });
				}
			}
		},
		changeAgent: async (_chat: URI, _agent: AgentSelection | undefined): Promise<void> => { },
		getMessages: (chat: URI, context: AgentChatOperationContext): Promise<readonly Turn[]> => isSubagentChatUri(chat) ? this._getSubagentMessages(chat, context) : this._getMessages(chat),
	};

	private async _disposeChat(chat: URI, destructive: boolean): Promise<void> {
		const key = chat.toString();
		const state = this._chats.get(key);
		if (!state || (!destructive && state.turn)) {
			return;
		}
		if (state.turn) {
			await this.chats.abort(chat, chat);
		}
		const client = this._process.running;
		if (client && state.sessionId && state.attachedGeneration === this._process.generation) {
			// frees the session in OpenCode's process; its history stays in OpenCode's own storage
			client.request('session/close', { sessionId: state.sessionId }, 10_000).catch(() => { /* older OpenCode: the session just stays loaded */ });
		}
		state.attachedGeneration = undefined;
		if (destructive) {
			state.disposed = true;
			this._chats.delete(key);
			if (state.sessionId) {
				this._chatsBySession.delete(state.sessionId);
			}
		}
	}

	/** The history of a restored chat: OpenCode replays the session while loading it into the process. */
	private async _getMessages(chat: URI): Promise<readonly Turn[]> {
		const state = this._chats.get(chat.toString());
		if (!state?.sessionId || state.turn) {
			return [];
		}
		const sessionId = state.sessionId;
		const started = Date.now();
		let client: OpenCodeAcpClient;
		try {
			client = await this._process.ensure(() => this._idle(state));
		} catch (error) {
			this._logService.warn(`[OpenCode] could not start to load ${sessionId}: ${String(error)}`);
			return [];
		}
		const generation = this._process.generation;
		const replay: IAcpSessionUpdate[] = [];
		state.replay = replay;
		try {
			const loaded = await client.request<{ configOptions?: IAcpConfigOption[] }>('session/load', { sessionId, cwd: state.cwd ?? os.homedir(), mcpServers: [] }, REQUEST_TIMEOUT_MS);
			state.attachedGeneration = generation;
			state.applied = {};
			this._readOptions(state, loaded?.configOptions);
		} catch (error) {
			this._logService.warn(`[OpenCode] could not load session ${sessionId}: ${String(error)}`);
			return [];
		} finally {
			if (state.replay === replay) {
				state.replay = undefined;
			}
		}
		// Dispatch IDE: each task names its sub-agent's chat, so the host lists it under the session again (and reads its steps)
		const session = state.session;
		const turns = mapReplayToTurns(replay, `opencode-${sessionId}`, session ? (toolCallId => buildSubagentChatUri(session, toolCallId)) : undefined);
		for (const update of replay) {
			if (update.toolCallId && update.status === 'completed') {
				const child = childSessionOfUpdate(update, toolOutputText(update));
				if (child) {
					this._subagents.remember(update.toolCallId, child);
				}
			}
		}
		this._logService.info(`[OpenCode] loaded ${sessionId}: ${turns.length} turns from ${replay.length} updates in ${Date.now() - started} ms`);
		return turns;
	}

	/**
	 * Dispatch IDE: a sub-agent's chat after a restart: the steps of the child session its task ran in, read from
	 * OpenCode's server (the task's metadata or output names the child; else the parent's messages say it).
	 */
	private async _getSubagentMessages(chat: URI, context: AgentChatOperationContext): Promise<readonly Turn[]> {
		const origin = URI.isUri(context) ? undefined : context.origin;
		const toolCallId = origin?.kind === ChatOriginKind.Tool ? origin.toolCallId : decodeURIComponent(chat.path.split('/').pop() ?? '');
		const parent = origin?.kind === ChatOriginKind.Tool ? this._chats.get(URI.parse(origin.chat).toString()) : undefined;
		const parentState = parent ?? [...this._chats.values()].find(s => s.session && !URI.isUri(context) && isEqual(s.session, context.configurationResource));
		if (!toolCallId || !parentState?.sessionId) {
			return [];
		}
		try {
			await this._process.ensure(() => this._idle(parentState));
		} catch (error) {
			this._logService.warn(`[OpenCode] could not start to read a sub-agent: ${String(error)}`);
			return [];
		}
		const server = this._process.server;
		if (!server) {
			return [];
		}
		try {
			let child = this._subagents.childOf(toolCallId);
			if (!child) {
				const messages = await server.messages(parentState.sessionId, parentState.cwd);
				const part = messages.flatMap(m => m.parts ?? []).find(p => p.type === 'tool' && p.callID === toolCallId);
				child = part ? childSessionOf(part) : undefined;
				if (child) {
					this._subagents.remember(toolCallId, child);
				}
			}
			if (!child) {
				return [];
			}
			const updates = messagesToUpdates(await server.messages(child, parentState.cwd));
			const turns = mapReplayToTurns(updates, `opencode-${child}`);
			this._logService.info(`[OpenCode] sub-agent ${child} of ${parentState.sessionId}: ${turns.length} turns from ${updates.length} steps`);
			return turns;
		} catch (error) {
			this._logService.warn(`[OpenCode] could not read the sub-agent of ${toolCallId}: ${String(error)}`);
			return [];
		}
	}

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const { configurationResource } = resolveAgentChatContext(context, chat);
		let persisted = decodeOpenCodeChat(providerData);
		let adopted = false;
		const own = persisted ? undefined : this._ownSessionId(chat, configurationResource);
		if (own) {
			// a session of OpenCode's own that discovery listed: the chat goes on in it
			const row = await this._findOpenCodeSession(own);
			persisted = { opencodeSessionId: own, ...(row?.directory ? { cwd: row.directory } : {}), ...(row?.model ? { model: row.model } : {}) };
			adopted = true;
		}
		if (!persisted) {
			return;
		}
		const state = this._state(chat);
		state.session = configurationResource;
		if (!state.sessionId) {
			this._bindSession(state, persisted.opencodeSessionId);
			state.cwd = persisted.cwd ?? state.cwd;
			state.model = persisted.model ?? state.model;
		}
		return {
			...(adopted ? { providerData: this._persisted(state) } : {}),
			...(state.cwd ? { resolvedWorkingDirectory: URI.file(state.cwd) } : {}),
			...this._backing(state),
		};
	}

	/** The OpenCode session behind a chat, when it is not the chat's own session (one discovery listed). */
	private _backing(state: IChatState): { backingSession?: URI } {
		if (!state.sessionId) {
			return {};
		}
		const backing = AgentSession.uri(this.id, state.sessionId);
		return state.session && isEqual(state.session, backing) ? {} : { backingSession: backing };
	}

	/** The id of OpenCode's session when the chat is the default chat of a session discovery listed (`opencode:/ses_…`). */
	private _ownSessionId(chat: URI, session: URI): string | undefined {
		if (AgentSession.provider(session) !== this.id || !isDefaultChatUri(chat.toString())) {
			return undefined;
		}
		const id = AgentSession.id(session);
		return OPENCODE_SESSION_ID.test(id) ? id : undefined;
	}

	// ---- OpenCode's own sessions ------------------------------------------------

	/**
	 * Lists OpenCode's recent sessions of every project, from the index (on disk, so at once after a restart);
	 * a session OpenCode gets later (its terminal UI, `opencode run`) is listed when the index reads it. The host
	 * drops the ones it knows or created.
	 */
	startChatDiscovery(): Promise<void> {
		this._discovery ??= (async () => {
			const index = this._index();
			await index.loaded;
			if (this._store.isDisposed) {
				return;
			}
			this._register(toDisposable(index.onDidRead(rows => this._discover(rows))));
			const rows = index.rows;
			if (rows) {
				this._discover(rows);
			}
			index.check();
		})();
		return this._discovery;
	}

	private _discover(rows: readonly IOpenCodeSessionRow[]): void {
		const fresh = openCodeDiscoverable(rows).filter(row => !this._discovered.has(row.id));
		if (!fresh.length || this._store.isDisposed) {
			return;
		}
		for (const row of fresh) {
			this._discovered.add(row.id);
		}
		this._logService.info(`[OpenCode] ${fresh.length} sessions of OpenCode's own to list`);
		this._onDidDiscoverChats.fire(fresh.map(row => ({ ...this._sessionMetadata(URI.parse(buildDefaultChatUri(AgentSession.uri(this.id, row.id))), row), external: true })));
	}

	/** Dispatch IDE: History's Continue in chat; by id, so one started since the index was read is found too (one read of the whole index). */
	async dispatchFindChat(id: string): Promise<IAgentChatMetadata | undefined> {
		let row = await this._findOpenCodeSession(id);
		if (!row && OPENCODE_SESSION_ID.test(id)) {
			await raceTimeout(this._index().refresh(), 15_000);
			row = this._index().get(id);
		}
		return row ? this._sessionMetadata(URI.parse(buildDefaultChatUri(AgentSession.uri(this.id, row.id))), row) : undefined;
	}

	private _sessionMetadata(chat: URI, row: IOpenCodeSessionRow): IAgentChatMetadata {
		return {
			chat,
			startTime: row.created,
			modifiedTime: row.updated,
			...(row.title ? { summary: row.title } : {}),
			workingDirectories: [URI.file(row.directory)],
			...(row.model ? { model: row.model } : {}),
		};
	}

	/**
	 * A session of OpenCode's by id, from the index: the row, null when OpenCode has no such session, undefined
	 * while the index has never been read. Waits only for the index from disk (or, on the very first start, the
	 * first read); a change to the database is read in the background.
	 */
	private async _findOpenCodeSession(id: string): Promise<IOpenCodeSessionRow | null | undefined> {
		const index = this._index();
		await raceTimeout(index.loaded, 10_000);
		index.check();
		return index.get(id);
	}

	private _index(): OpenCodeSessionIndex {
		if (!this._sessionIndex) {
			const index = this._sessionIndex = new OpenCodeSessionIndex({
				databasePath: () => this._findDatabase(),
				readDatabase: (database, since) => readOpenCodeDatabase(database, openCodeSessionIndexQuery(since)),
				readCli: since => this._readSessionsWithCli(since),
			}, {
				cacheFile: path.join(this._environmentService.userDataPath, 'agent-host', 'opencode-sessions.json'),
				log: (level, message) => level === 'warn' ? this._logService.warn(message) : this._logService.info(message),
			});
			this._register(toDisposable(() => index.dispose()));
		}
		return this._sessionIndex;
	}

	/**
	 * OpenCode's database: where OpenCode keeps it by default (`$XDG_DATA_HOME/opencode/opencode.db`), else what
	 * `opencode db path` said (one process, once per start). Undefined while there is none yet: the usual place is
	 * looked at again on the next call (a file check), so a first OpenCode session later is still found.
	 */
	private async _findDatabase(): Promise<string | undefined> {
		const env = this._env();
		const usual = path.join(env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
		if (fs.existsSync(usual)) {
			return usual;
		}
		this._databasePath ??= this._binary().then(binary => new Promise<string | undefined>(resolve => execFile(binary, ['db', 'path'], { env, cwd: os.homedir(), timeout: 30_000 }, (error, stdout) => {
			const said = error ? '' : stdout.trim().split('\n').pop() ?? '';
			this._logService.info(`[OpenCode] its database: ${said || 'none'}`);
			resolve(said.startsWith('/') ? said : undefined);
		}).stdin?.end()), () => undefined);
		const said = await this._databasePath;
		return said && fs.existsSync(said) ? said : undefined;
	}

	/**
	 * The index through `opencode db <query> --format json` (one process; the index never runs two). Its answer goes
	 * to a file, not a pipe: OpenCode exits before a pipe takes more than 64 KB, and 0.9.2 read the cut-off list as
	 * none (kanban task-mpidn).
	 */
	private async _readSessionsWithCli(since?: number): Promise<IOpenCodeSessionRow[]> {
		await raceTimeout(this._quickListed, 15_000); // Dispatch IDE (opencode-first-run): the model list first
		const binary = await this._binary();
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dispatch-opencode-db-'));
		const file = path.join(dir, 'sessions.json');
		try {
			const out = await fs.promises.open(file, 'w');
			try {
				await new Promise<void>((resolve, reject) => {
					const child = spawn(binary, ['db', openCodeSessionIndexQuery(since), '--format', 'json'], { env: this._env(), cwd: os.homedir(), stdio: ['ignore', out.fd, 'pipe'] });
					let stderr = '';
					child.stderr?.on('data', chunk => stderr = (stderr + String(chunk)).slice(-400));
					const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
					child.on('error', error => { clearTimeout(timer); reject(error); });
					child.on('exit', (code, signal) => {
						clearTimeout(timer);
						if (code === 0) {
							resolve();
						} else {
							reject(new Error(`\`opencode db\` ${signal ? `stopped (${signal})` : `exited ${code}`}: ${stderr.trim().split('\n').pop() ?? ''}`));
						}
					});
				});
			} finally {
				await out.close();
			}
			const stdout = await fs.promises.readFile(file, 'utf8');
			const rows = parseOpenCodeSessionRows(stdout);
			if (!rows) {
				throw new Error(`\`opencode db\` did not answer with a list: ${stdout.trim().slice(0, 120)}`);
			}
			return rows;
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	}

	async setWorkingDirectory(): Promise<void> {
		throw new Error('OpenCode chats cannot change their folder.');
	}

	getOrCreateActiveClient(_chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		// OpenCode runs its own tools; tools and plugins a client contributes are not passed to it
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		return {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
	}

	removeActiveClient(): void { }

	onClientToolCallComplete(): void { }

	/**
	 * Dispatch IDE: OpenCode's asks come to the host as confirmation cards, so the host's approval level is the one
	 * that answers them: the chat carries the platform's Approvals (and the tools allowed in it). Without it the
	 * window's level (Full auto by default) never reached an OpenCode chat, which asked before every command.
	 */
	async resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		const values = opencodeChatConfigSchema.validateOrDefault(params.config, { [SessionConfigKey.AutoApprove]: 'default' satisfies AutoApproveLevel });
		return { schema: opencodeChatConfigSchema.toProtocol(), values: { ...params.config, ...values } };
	}

	getInheritedChatConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		const inherited: Record<string, unknown> = {};
		for (const key of [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions]) {
			if (config[key] !== undefined) {
				inherited[key] = config[key];
			}
		}
		return Object.keys(inherited).length > 0 ? inherited : undefined;
	}

	async chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	/**
	 * Dispatch IDE: OpenCode's commands and skills for the Agents window's slash menu, from its own
	 * `available_commands_update` (the chat's session, else the last list for its folder, else the
	 * process's `GET /command` before any session exists).
	 */
	async getSlashCommands(chat: URI, options: { readonly hasHistory: boolean }): Promise<readonly IAgentSlashCommand[]> {
		const state = this._chats.get(chat.toString());
		const cwd = state?.cwd;
		let list = (state?.sessionId ? this._availableCommands.get(state.sessionId) : undefined) ?? (cwd ? this._availableCommandsByCwd.get(cwd) : undefined);
		let sources: Map<string, string> | undefined;
		if (!list && cwd && !this._process.server) {
			// the process starts with the new chat (see _warm) and takes a few seconds: wait a little
			await raceTimeout(this._process.ensure().then(() => undefined, () => undefined), 2500);
		}
		const server = this._process.server;
		if (server && cwd) {
			try {
				const known = await server.commands(cwd);
				sources = new Map(known.filter(c => typeof c.name === 'string').map(c => [c.name, c.source ?? 'command']));
				list ??= known.map(c => ({ name: c.name, description: (c as { description?: string }).description ?? '' }));
			} catch (err) {
				this._logService.info(`[OpenCode] GET /command failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return list ? openCodeSlashCommandsForMenu(list, sources, options.hasHistory) : [];
	}

	/**
	 * Dispatch IDE: `/clear` as in Claude Code's terminal: the chat moves to a new OpenCode session right
	 * away, so the next message has no history and a restart resumes the new one; the old session stays
	 * in OpenCode's storage. The host keeps the turns on screen.
	 */
	async clearChatContext(chat: URI): Promise<boolean> {
		const state = this._chats.get(chat.toString());
		const previous = state?.sessionId;
		if (!state || !previous || state.turn || state.creating || state.disposed) {
			return false;
		}
		const client = this._process.running;
		if (client && state.attachedGeneration === this._process.generation) {
			client.request('session/close', { sessionId: previous }, 10_000).catch(() => { /* older OpenCode: the session just stays loaded */ });
		}
		this._chatsBySession.delete(previous);
		state.sessionId = undefined;
		state.attachedGeneration = undefined;
		state.applied = {};
		state.hasEffort = false;
		state.ownPrompt = undefined;
		state.pastTools.clear();
		await this._ensureSession(state);
		this._logService.info(`[OpenCode] /clear: chat ${chat.toString()} moved from ${previous} to ${state.sessionId}`);
		return true;
	}

	async getChatCustomizations(): Promise<readonly Customization[]> {
		return [];
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		return [];
	}

	async getChatMetadata(chat: URI, context: URI | IAgentChatContext, providerData?: string, options?: IAgentChatMetadataOptions): Promise<IAgentChatMetadata | undefined> {
		const state = this._chats.get(chat.toString());
		if (state?.sessionId) {
			return {
				chat, startTime: state.created, modifiedTime: state.modified,
				...(state.model ? { model: state.model } : {}),
				...(state.cwd ? { workingDirectories: [URI.file(state.cwd)] } : {}),
			};
		}
		const persisted = decodeOpenCodeChat(providerData);
		if (!persisted) {
			const own = this._ownSessionId(chat, resolveAgentChatContext(context, chat).configurationResource);
			if (own) {
				// a session of OpenCode's own that discovery listed and nobody opened yet
				const row = await this._findOpenCodeSession(own);
				if (row) {
					return this._sessionMetadata(chat, row);
				}
				const fallback = options?.registryFallback;
				return row === null || !fallback ? undefined : { chat, startTime: fallback.startTime, modifiedTime: fallback.modifiedTime };
			}
			// a chat whose first message never went out has nothing to restore
			return state ? { chat, startTime: state.created, modifiedTime: state.modified } : undefined;
		}
		const fallback = options?.registryFallback;
		return {
			chat,
			startTime: fallback?.startTime ?? 0,
			modifiedTime: fallback?.modifiedTime ?? 0,
			...(persisted.model ? { model: persisted.model } : {}),
			...(persisted.cwd ? { workingDirectories: [URI.file(persisted.cwd)] } : {}),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	async shutdown(): Promise<void> {
		for (const state of this._chats.values()) {
			if (state.turn) {
				await this.chats.abort(state.chat, state.chat);
			}
		}
		this._process.dispose();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}
}
