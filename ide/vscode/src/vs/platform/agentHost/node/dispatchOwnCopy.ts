/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session changes the project folder itself, and takes a copy of its own only while another agent
 *  is working in that folder (patches/295-own-copy.patch, kanban task-lj06.16; the person's choice of 2026-10-07:
 *  "default: change the project folder directly"). The copy goes back into the folder by itself when the session's
 *  turn ends; when both changed the same lines, a question card asks what to do. The git work is the dispatch
 *  command's (kanban app/cli/own_copy.py: `worktree busy | mark | land`); this file decides when and says it.
 *
 *  - A new session in a folder (Separate copy not picked) has its working directory held back until its first
 *    message, like a Separate copy session, so no agent starts in the folder before Dispatch looked.
 *  - First message: another session of this window has a turn running in the same folder, or an agent the person
 *    started in a terminal works there (`worktree busy`): the session becomes a Separate copy session, marked to go
 *    back by itself. Otherwise it works in the folder as picked.
 *  - Each turn of a copy session ends: a marked copy is brought back (`worktree land`), a copy the person picked
 *    themselves only gets a line saying its changes are not in the folder yet.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { ChatInputRequestPurpose, withChatInputRequestPurpose } from '../common/meta/agentChatInputRequestMeta.js';
import { SessionConfigKey } from '../common/sessionConfigKeys.js';
import { ActionType, type ActionEnvelope } from '../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, type ChatInputAnswer } from '../common/state/protocol/state.js';
import { buildDefaultChatUri, ChatOriginKind, isSubagentSession, MessageKind, ResponsePartKind, withMessageRequestHiddenFromTranscript } from '../common/state/sessionState.js';
import type { IAgentConfigurationService } from './agentConfigurationService.js';
import type { AgentHostLocalTurns } from './agentHostLocalTurns.js';
import type { AgentHostStateManager } from './agentHostStateManager.js';
import type { AgentSideEffects } from './agentSideEffects.js';
import { combinePrompt, copyNotice, firstMessageDecides, fsPath, landNotice, question, waitNotice, type ILand, type QuestionKind } from './dispatchOwnCopyWords.js';
import { dispatchCli } from './shared/dispatchCopyReady.js';
import type { IAgentHostWorktreeIsolation } from './shared/worktreeIsolation.js';

const CLI_TIMEOUT_MS = 60_000;
const BUSY_TIMEOUT_MS = 20_000; // usually half a second; a Mac under load took more than 5 s
/** How long the first message waits for the look at the folder's agents (asked when the session was made). */
const BUSY_WAIT_MS = 1_500;
/** A look older than this is asked again at the first message. */
const BUSY_FRESH_MS = 60_000;
/** A folder in the middle of something (another agent's commit, staged files): try again this often, this many times. */
const RETRY_MS = 30_000;
const RETRIES = 20;
const QUESTION_PREFIX = 'dispatch-own-copy:';

export interface IDispatchOwnCopyOptions {
	readonly stateManager: AgentHostStateManager;
	readonly configuration: IAgentConfigurationService;
	readonly worktree: IAgentHostWorktreeIsolation;
	readonly localTurns: AgentHostLocalTurns;
	readonly sideEffects: AgentSideEffects;
	readonly log: ILogService;
}

interface IBusy {
	readonly busy?: boolean;
	readonly git?: boolean;
	readonly branch?: string;
	readonly agents?: readonly { readonly name: string }[];
}

interface IQuestion {
	readonly session: string;
	readonly chat: string;
	readonly turnId: string;
	readonly copy: string;
	readonly kind: QuestionKind;
	readonly land: ILand;
}

function cli<T>(args: string[], cwd: string, timeout = CLI_TIMEOUT_MS): Promise<T | undefined> {
	const target = dispatchCli();
	if (!target) {
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		execFile(target.cmd, [...target.pre, ...args, '--json'], { cwd, timeout, env: { ...process.env, DISPATCH_CALLER: 'agent-host' } }, (error, stdout) => {
			const line = String(stdout || '').trim().split('\n').pop() || '';
			try {
				resolve(line ? JSON.parse(line) as T : undefined);
			} catch {
				resolve(undefined);
			}
		});
	});
}

export class DispatchOwnCopy extends Disposable {

	/** Sessions whose folder this file held back until their first message. */
	private readonly _deferred = new Set<string>();
	/** The look at the folder's agents, started when the session was made so the first message does not wait for it. */
	private readonly _busyChecks = new Map<string, { readonly at: number; readonly answer: Promise<IBusy | undefined> }>();
	/** Copies made because of another agent, not marked in git yet: session → the branch they go back into. */
	private readonly _marks = new Map<string, string>();
	/** A host turn (a line or a question card) running in the session: its id. */
	private readonly _hostTurns = new Map<string, string>();
	private readonly _questions = new Map<string, IQuestion>();
	private readonly _retries = new Map<string, { copy: string; tries: number; timer: ReturnType<typeof setTimeout> | undefined }>();
	private readonly _landing = new Set<string>();
	/** Sessions told that their copy's changes are not in the folder yet, so it is not said after every turn. */
	private readonly _saidManual = new Set<string>();

	constructor(private readonly _o: IDispatchOwnCopyOptions) {
		super();
		this._register(_o.stateManager.onDidChangeSessionActiveTurn(({ session, active }) => {
			if (active || this._hostTurns.has(session)) {
				return;
			}
			void this._turnEnded(session);
			this._retryOthers(session);
		}));
		this._register(_o.stateManager.onDidEmitEnvelope(e => this._onEnvelope(e)));
		this._register({ dispose: () => { for (const r of this._retries.values()) { clearTimeout(r.timer); } } });
	}

	// ---- before the first message ------------------------------------------------------------------------------

	/** createSession: hold a folder session's working directory back until its first message (see the top). */
	shouldDefer(config: Record<string, unknown> | undefined, hasFolder: boolean): boolean {
		return hasFolder && config?.[SessionConfigKey.Isolation] === 'folder';
	}

	noteDeferred(session: string, folder: string | undefined): void {
		this._o.log.info(`[DispatchOwnCopy] ${session}: a folder session, held back until its first message`);
		this._deferred.add(session);
		if (folder) {
			this._busyChecks.set(session, { at: Date.now(), answer: this._askBusy(folder) });
		}
	}

	/**
	 * The first message of a session held back: a copy of its own when another agent works in the folder, else the
	 * folder as picked. Leaves the session pending only when it becomes a copy (the worktree path takes it from there).
	 */
	async beforeFirstSend(session: string, sessionId: string, chat: string, turnId: string, folder: string | undefined): Promise<void> {
		// a side chat only answers a question about its conversation, in that conversation's folder: never a copy
		if (this._o.stateManager.getChatOrigin(chat)?.kind === ChatOriginKind.SideChat) {
			return;
		}
		const deferred = this._deferred.delete(session);
		const pending = this._o.worktree.isWorkingDirectoryPending(sessionId);
		const isolation = this._o.configuration.getSessionConfigValues(session)?.[SessionConfigKey.Isolation];
		// the first message: held back by createSession, or a session that never ran a turn; Separate copy picked (even
		// after the session was held back as a folder session) stays a copy, its working directory still pending
		const first = firstMessageDecides({ deferred, pending, isolation, hasTurns: !!this._o.stateManager.getSessionState(chat)?.turns?.length });
		this._o.log.info(`[DispatchOwnCopy] ${session}: first message? ${first} (held back ${deferred}, pending ${pending}, isolation ${isolation}) in ${folder}`);
		if (!first) {
			if (deferred && isolation === 'worktree' && !pending) {
				this._o.worktree.notePending(sessionId); // the worktree path below makes the copy the person picked
			}
			return;
		}
		let copy = false;
		try {
			copy = !!folder && await this._decideCopy(session, folder, chat, turnId);
		} catch (err) {
			this._o.log.warn(`[DispatchOwnCopy] ${session}: deciding failed, working in the folder: ${err}`);
		}
		if (copy && !this._o.worktree.isWorkingDirectoryPending(sessionId)) {
			this._o.worktree.notePending(sessionId); // the worktree path below makes the copy
		} else if (!copy && deferred) {
			this._o.worktree.clearPending(sessionId);
		}
	}

	private async _decideCopy(session: string, folder: string, chat: string, turnId: string): Promise<boolean> {
		const here = this._sessionsWorkingIn(folder, session);
		let check = this._busyChecks.get(session);
		this._busyChecks.delete(session);
		if (!check || Date.now() - check.at > BUSY_FRESH_MS) {
			check = { at: Date.now(), answer: this._askBusy(folder) };
		}
		// the first message never waits long: no answer in time counts as "no agent started outside this window"
		const busy = await Promise.race([check.answer, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), BUSY_WAIT_MS))]);
		this._o.log.info(`[DispatchOwnCopy] ${session}: a session of this window in the folder ${here}; the folder ${JSON.stringify(busy)}`);
		// the branch from git itself when the command did not answer (another agent of this window is enough reason)
		const branch = busy?.branch || (here ? await gitBranch(folder) : undefined);
		if (!branch || (busy && !busy.git)) {
			return false; // not a git project with a first commit, or on no branch: a copy cannot be made
		}
		if (!here && !busy?.busy) {
			return false;
		}
		this._o.configuration.updateSessionConfig(session, { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: branch });
		this._marks.set(session, branch);
		this._o.stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatResponsePart,
			turnId,
			part: {
				kind: ResponsePartKind.Markdown, id: generateUuid(),
				content: copyNotice(folder) + '\n\n',
			},
		});
		this._o.log.info(`[DispatchOwnCopy] ${session}: ${here ? 'a session of this window' : busy?.agents?.map(a => a.name).join(', ')} works in ${folder}; a copy of its own`);
		return true;
	}

	private _askBusy(folder: string): Promise<IBusy | undefined> {
		return cli<IBusy>(['worktree', 'busy', folder, '--not-under', String(process.pid)], folder, BUSY_TIMEOUT_MS);
	}

	/** Whether another session of this window has a turn running in `folder` (its own copies are other folders). */
	private _sessionsWorkingIn(folder: string, self: string): boolean {
		const want = real(folder);
		for (const other of this._o.stateManager.getSessionUris()) {
			if (other === self || isSubagentSession(other) || !this._o.stateManager.hasActiveTurn(other) || this._hostTurns.has(other)) {
				continue;
			}
			const path = fsPath(this._o.stateManager.getSessionState(other)?.workingDirectories?.[0]);
			const wd = path ? real(path) : undefined;
			if (wd && (wd === want || wd.startsWith(want + '/'))) {
				return true;
			}
		}
		return false;
	}

	/** A copy made because of another agent: marked once its worktree exists, so the mark survives a restart. */
	private async _markIfNew(session: string, copy: string): Promise<void> {
		const into = this._marks.get(session);
		if (!into) {
			return;
		}
		const r = await cli<{ ok?: boolean }>(['worktree', 'mark', copy, '--into', into], copy);
		if (r?.ok) {
			this._marks.delete(session);
		}
	}

	// ---- when a turn ends -------------------------------------------------------------------------------------

	/** The session's working folder when it may be a copy (`worktree land` says for sure: not_copy otherwise). */
	private _copyOf(session: string): string | undefined {
		const state = this._o.stateManager.getSessionState(session);
		const wd = fsPath(state?.workingDirectories?.[0])?.replace(/\/+$/, '');
		const project = fsPath(state?.project?.uri)?.replace(/\/+$/, '');
		if (!wd) {
			return undefined;
		}
		return state?.config?.values?.[SessionConfigKey.Isolation] === 'worktree' || (!!project && wd !== project) ? wd : undefined;
	}

	private async _turnEnded(session: string): Promise<void> {
		if (isSubagentSession(session) || this._landing.has(session)) {
			return;
		}
		const copy = this._copyOf(session);
		if (!copy) {
			return;
		}
		this._landing.add(session);
		try {
			await this._markIfNew(session, copy);
			await this._land(session, copy);
		} finally {
			this._landing.delete(session);
		}
	}

	private async _land(session: string, copy: string): Promise<void> {
		const title = this._o.stateManager.getSessionSummary(session)?.title;
		const r = await cli<ILand>(['worktree', 'land', copy, '--message', title ? `Changes from the session "${title}"` : 'Changes from the agent'], copy);
		if (!r?.state) {
			return;
		}
		this._o.log.info(`[DispatchOwnCopy] ${session}: land ${copy}: ${r.state}`);
		const retrying = this._retries.get(session);
		if (r.state !== 'folder_busy' && r.state !== 'folder_changes' && retrying) {
			clearTimeout(retrying.timer);
			this._retries.delete(session);
		}
		switch (r.state) {
			case 'landed':
			case 'error':
				this._notice(session, landNotice(r));
				return;
			case 'manual': {
				// said once while the copy holds changes the folder does not have, again only after they went in
				const waiting = !!(r.ahead || r.dirty);
				if (waiting && !this._saidManual.has(session)) {
					this._saidManual.add(session);
					this._notice(session, landNotice(r));
				} else if (!waiting) {
					this._saidManual.delete(session);
				}
				return;
			}
			case 'conflict':
				this._ask(session, copy, 'conflict', r);
				return;
			case 'other_branch':
				this._ask(session, copy, 'other_branch', r);
				return;
			case 'folder_busy':
			case 'folder_changes': {
				// another agent is probably in the middle of it: try again when it is done, then ask
				const prev = this._retries.get(session);
				const tries = (prev?.tries ?? 0) + 1;
				clearTimeout(prev?.timer);
				const othersBusy = r.main ? this._sessionsWorkingIn(r.main, session) : false;
				if (tries > RETRIES || (r.state === 'folder_changes' && !othersBusy && tries > 1)) {
					this._retries.delete(session);
					this._ask(session, copy, r.state === 'folder_changes' ? 'folder_changes' : 'waited', r);
					return;
				}
				if (tries === 1) {
					this._notice(session, waitNotice(r));
				}
				const timer = setTimeout(() => void this._retry(session), RETRY_MS);
				this._retries.set(session, { copy, tries, timer });
				return;
			}
		}
	}

	private async _retry(session: string): Promise<void> {
		const r = this._retries.get(session);
		if (!r || this._landing.has(session) || this._o.stateManager.hasActiveTurn(session)) {
			return;
		}
		this._landing.add(session);
		try {
			await this._land(session, r.copy);
		} finally {
			this._landing.delete(session);
		}
	}

	/** Another session's turn ended: a copy waiting for the folder tries again now. */
	private _retryOthers(ended: string): void {
		for (const session of this._retries.keys()) {
			if (session !== ended) {
				void this._retry(session);
			}
		}
	}

	// ---- what the person reads -------------------------------------------------------------------------------

	/** A line in the session, on a finished host turn of its own (as Agent Merge's notices), kept after a restart. */
	private _notice(session: string, content: string | undefined): void {
		if (!content) {
			return;
		}
		const chat = buildDefaultChatUri(session);
		const turnId = this._startHostTurn(session, chat, content);
		this._o.stateManager.dispatchServerAction(chat, { type: ActionType.ChatResponsePart, turnId, part: { kind: ResponsePartKind.SystemNotification, content } });
		this._endHostTurn(session, chat, turnId);
	}

	private _startHostTurn(session: string, chat: string, text: string): string {
		const turnId = generateUuid();
		this._hostTurns.set(session, turnId);
		this._o.stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: withMessageRequestHiddenFromTranscript({ text, origin: { kind: MessageKind.SystemNotification } }, true),
		});
		return turnId;
	}

	private _endHostTurn(session: string, chat: string, turnId: string, cancelled = false): void {
		if (!cancelled) {
			this._o.stateManager.dispatchServerAction(chat, { type: ActionType.ChatTurnComplete, turnId, duration: 0 });
		}
		if (this._hostTurns.get(session) === turnId) {
			this._hostTurns.delete(session);
		}
		const turns = this._o.stateManager.getSessionState(chat)?.turns;
		const recorded = turns?.find(turn => turn.id === turnId);
		if (turns && recorded) {
			this._o.localTurns.record(session, chat, recorded, this._o.localTurns.findAnchorTurnId(chat, turns, turnId));
		}
	}

	/** The question card: on a host turn of its own that stays open until the person answers. */
	private _ask(session: string, copy: string, kind: IQuestion['kind'], r: ILand): void {
		if (this._o.stateManager.hasActiveTurn(session)) {
			return; // the person already wrote again: the next turn's end asks
		}
		const { title, message, options } = question(kind, r);
		const chat = buildDefaultChatUri(session);
		const turnId = this._startHostTurn(session, chat, title); // the sessions list shows this line: the short title
		const id = QUESTION_PREFIX + generateUuid();
		this._questions.set(id, { session, chat, turnId, copy, kind, land: r });
		this._o.stateManager.dispatchServerAction(chat, {
			type: ActionType.ChatInputRequested,
			request: withChatInputRequestPurpose({
				id,
				questions: [{ id: 'what', kind: ChatInputQuestionKind.SingleSelect, title, message, options: [...options], allowFreeformInput: false, required: true }],
			}, ChatInputRequestPurpose.AskUser),
		});
	}

	private _onEnvelope(e: ActionEnvelope): void {
		const action = e.action;
		if (action.type === ActionType.ChatInputCompleted && action.requestId.startsWith(QUESTION_PREFIX)) {
			const q = this._questions.get(action.requestId);
			if (q) {
				this._questions.delete(action.requestId);
				this._endHostTurn(q.session, q.chat, q.turnId);
				void this._answer(q, action.response === ChatInputResponseKind.Accept ? picked(action.answers?.['what']) : 'keep');
			}
			return;
		}
		if (action.type === ActionType.ChatTurnCancelled) {
			for (const [id, q] of this._questions) {
				if (q.turnId === action.turnId) {
					this._questions.delete(id);
					this._endHostTurn(q.session, q.chat, q.turnId, true);
				}
			}
		}
	}

	private async _answer(q: IQuestion, choice: string | undefined): Promise<void> {
		switch (choice) {
			case 'combine':
				this._startAgentTurn(q.session, q.chat, combinePrompt(q.land));
				return;
			case 'here':
				if (q.land.folder_branch) {
					await cli(['worktree', 'mark', q.copy, '--into', q.land.folder_branch], q.copy);
				}
				await this._land(q.session, q.copy);
				return;
			case 'retry':
				await this._land(q.session, q.copy);
				return;
			default:
				this._notice(q.session, landNotice({ ...q.land, state: 'manual', ahead: 1 }));
		}
	}

	/** An agent turn with the person's choice as its message (they picked it on the card). */
	private _startAgentTurn(session: string, chat: string, prompt: string): void {
		if (this._o.stateManager.hasActiveTurn(session)) {
			return;
		}
		const action = { type: ActionType.ChatTurnStarted, turnId: generateUuid(), startedAt: new Date().toISOString(), message: { text: prompt, origin: { kind: MessageKind.User } } } as const;
		this._o.stateManager.dispatchServerAction(chat, action);
		this._o.sideEffects.handleAction(chat, action);
	}
}

/** The branch the folder is on, when it has a first commit; undefined otherwise. */
function gitBranch(folder: string): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('git', ['-C', folder, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 10_000 }, (error, stdout) => {
			const branch = String(stdout || '').trim();
			if (error || !branch) {
				resolve(undefined);
				return;
			}
			execFile('git', ['-C', folder, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 10_000 }, e => resolve(e ? undefined : branch));
		});
	});
}

/** The folder as it really is on disk (/tmp is /private/tmp), without a trailing slash. */
function real(path: string): string {
	try {
		return realpathSync(path).replace(/\/+$/, '');
	} catch {
		return path.replace(/\/+$/, '');
	}
}

function picked(answer: ChatInputAnswer | undefined): string | undefined {
	if (!answer || answer.state === ChatInputAnswerState.Skipped) {
		return undefined;
	}
	return answer.value.kind === ChatInputAnswerValueKind.Selected ? answer.value.value : undefined;
}
