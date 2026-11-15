/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the state behind the Changes tab's card (dispatchFixCard.ts). One card per session:
 *  the agent writing the commit message, what it wrote, or what went wrong with the one button that
 *  hands it to the session's agent. Problems come from a failed operation (commit, sync, merge) and,
 *  every 20 s while a Changes tab is on screen, from `dispatch fix status` (conflicts in the folder,
 *  the pull request's failed checks and open review comments through gh).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri, LOCAL_AGENT_HOST_AUTHORITY } from '../../../../platform/agentHost/common/agentHostUri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getAgentSessionProvider, getAgentSessionProviderIcon, getAgentSessionProviderName } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { writerOf } from './dispatchFixitWriter.js';
import { openCodeIcon } from '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { VIEW_SESSION_CHANGES_COMMAND_ID } from '../../changes/common/changes.js';
import { DISPATCH_COMMIT_MESSAGE_META, dispatchChangesetHooks, failureKind, IDispatchChangesetHooks, IDispatchProblem, IDispatchSettled, IDispatchWritten, writesCommitMessage } from '../common/dispatchFixit.js';

export type DispatchFixCardState =
	| { readonly kind: 'writing' }
	| { readonly kind: 'committing'; readonly written: IDispatchWritten }
	| { readonly kind: 'written'; readonly written: IDispatchWritten }
	| { readonly kind: 'explaining' }
	| { readonly kind: 'problem'; readonly problem: IDispatchProblem }
	| { readonly kind: 'sent'; readonly problem: IDispatchProblem; readonly agent: string }
	/**
	 * What went wrong is behind us: committed or sent (the card goes after a moment), fixed and ready to try again,
	 * or answered: the agent's turn ended and git cannot tell whether that fixed it, so the person tries again.
	 */
	| { readonly kind: 'fixed'; readonly problem: IDispatchProblem; readonly how: 'committed' | 'sent' | 'ready' | 'answered'; readonly subject?: string; readonly agent?: string };

export const IDispatchFixitService = createDecorator<IDispatchFixitService>('dispatchFixitService');

export interface IDispatchFixitService {
	readonly _serviceBrand: undefined;
	/** The card of each session, by session id. */
	readonly cards: IObservable<ReadonlyMap<string, DispatchFixCardState>>;
	/** A Changes tab is on screen: keep the status fresh (returns the release). */
	watch(): { dispose(): void };
	/** A card is on screen (or not): a failed Commit from the title bar brings the Changes tab forward when none is. */
	setOnScreen(card: object, onScreen: boolean): void;
	fix(sessionId: string): Promise<void>;
	dismiss(sessionId: string): void;
	agentOf(session: ISession | undefined): { label: string; icon: ThemeIcon | undefined };
}

const POLL_MS = 20_000;
const WRITTEN_MS = 12_000;

/** The engine mark of an agent Dispatch names by id (`dispatch write` answers with it). */
export function writerIcon(by: string | undefined): ThemeIcon | undefined {
	switch (by) {
		case 'claude': return Codicon.claude;
		case 'codex': return Codicon.openai;
		case 'opencode': return openCodeIcon;
		default: return undefined;
	}
}

export class DispatchFixitService extends Disposable implements IDispatchFixitService, IDispatchChangesetHooks {
	declare readonly _serviceBrand: undefined;

	private readonly _cards = observableValue<ReadonlyMap<string, DispatchFixCardState>>(this, new Map());
	readonly cards: IObservable<ReadonlyMap<string, DispatchFixCardState>> = this._cards;

	/** Problem keys the person closed or handed to the agent: not shown again until the problem changes. */
	private readonly closed = new Set<string>();
	private readonly sentKeys = new Map<string, string>(); // key → agent label
	/** When each problem went to the agent: a turn that ended after it is the agent's answer. */
	private readonly sentAt = new Map<string, number>();
	/** The agent-written message of the operation in flight, per session. */
	private readonly pending = new Map<string, IDispatchWritten>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private watchers = 0;
	private poll: ReturnType<typeof setInterval> | undefined;
	private readonly onScreen = new Set<object>();

	constructor(
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		dispatchChangesetHooks.current = this;
		// the agent answered (its turn ended): whether the failed commit is behind us is worth asking at once
		let wasWorking = false;
		this._register(autorun(reader => {
			const status = this.sessionsService.activeSession.read(reader)?.status.read(reader);
			const working = status === SessionStatus.InProgress;
			if (wasWorking && !working && this.watchers > 0) {
				void this.refresh();
			}
			wasWorking = working;
		}));
		this._register(toDisposable(() => {
			if (dispatchChangesetHooks.current === this) {
				dispatchChangesetHooks.current = undefined;
			}
			this.stopPolling();
			this.timers.forEach(t => clearTimeout(t));
		}));
	}

	// --- the card -------------------------------------------------------------------------------

	private set(sessionId: string, state: DispatchFixCardState | undefined): void {
		const next = new Map(this._cards.get());
		if (state) {
			next.set(sessionId, state);
		} else {
			next.delete(sessionId);
		}
		const t = this.timers.get(sessionId);
		if (t) {
			clearTimeout(t);
			this.timers.delete(sessionId);
		}
		if (state?.kind === 'written' || (state?.kind === 'fixed' && (state.how === 'committed' || state.how === 'sent'))) {
			// the marker stays long enough to read, then the tab is the diff again
			this.timers.set(sessionId, setTimeout(() => {
				if (this._cards.get().get(sessionId) === state) {
					this.set(sessionId, undefined);
				}
			}, WRITTEN_MS));
		}
		this._cards.set(next, undefined);
	}

	private active(): ISession | undefined {
		return this.sessionsService.activeSession.get();
	}

	/** The folder the session works in on this Mac (its worktree when it has one), else undefined. */
	private folderOf(session: ISession | undefined): string | undefined {
		const folder = session?.workspace.get()?.folders[0];
		for (const uri of [folder?.workingDirectory, folder?.gitRepository?.workTreeUri, folder?.root]) {
			const local = uri?.scheme === AGENT_HOST_SCHEME && uri.authority === LOCAL_AGENT_HOST_AUTHORITY ? fromAgentHostUri(uri) : uri;
			if (local?.scheme === Schemas.file && local.path) {
				return local.fsPath;
			}
		}
		this.logService.info(`[DispatchFixit] no local folder for session ${session?.sessionId}: ${folder?.workingDirectory?.toString()} ${folder?.root?.toString()}`);
		return undefined;
	}

	agentOf(session: ISession | undefined): { label: string; icon: ThemeIcon | undefined } {
		const provider = session ? getAgentSessionProvider(session.resource) : undefined;
		if (!provider) {
			return { label: localize('dispatchFixit.theAgent', "the agent"), icon: undefined };
		}
		return { label: getAgentSessionProviderName(provider), icon: getAgentSessionProviderIcon(provider) };
	}

	// --- the hooks AgentHostSessionChangesets calls -----------------------------------------------

	async before(operationId: string, meta: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined> {
		const session = this.active();
		const folder = this.folderOf(session);
		this.logService.info(`[DispatchFixit] before ${operationId} in ${folder ?? '(no folder)'}`);
		if (!session || !folder) {
			return meta;
		}
		const current = this._cards.get().get(session.sessionId);
		if (current && (current.kind === 'problem' || current.kind === 'explaining' || current.kind === 'sent' || current.kind === 'fixed') && (operationId === 'commit' || operationId === 'sync' || operationId === 'merge')) {
			this.set(session.sessionId, undefined); // trying again: the old card goes
		}
		if (!writesCommitMessage(operationId) || meta?.[DISPATCH_COMMIT_MESSAGE_META]) {
			return meta;
		}
		this.set(session.sessionId, { kind: 'writing' });
		let written: IDispatchWritten | undefined;
		try {
			// the session's own agent writes it, with the session's model, on that agent's allowance (task-dekzn)
			const { engine, model } = writerOf(session);
			written = await this.commandService.executeCommand<IDispatchWritten>('dispatch.write', 'commit-message', folder, '', engine, model);
		} catch (e) {
			this.logService.warn('[DispatchFixit] write commit message', e);
		}
		if (!written?.text) {
			this.set(session.sessionId, undefined);
			return meta; // nothing to commit, or the bridge is not there: the host's own path runs
		}
		this.pending.set(session.sessionId, written);
		this.set(session.sessionId, { kind: 'committing', written });
		return { ...meta, [DISPATCH_COMMIT_MESSAGE_META]: written.text };
	}

	succeeded(operationId: string): void {
		const session = this.active();
		if (!session) {
			return;
		}
		const written = this.pending.get(session.sessionId);
		this.pending.delete(session.sessionId);
		if (written && writesCommitMessage(operationId)) {
			this.set(session.sessionId, { kind: 'written', written });
		} else if (this._cards.get().get(session.sessionId)?.kind === 'committing') {
			this.set(session.sessionId, undefined);
		}
	}

	failed(operationId: string, error: unknown): boolean {
		const session = this.active();
		const folder = this.folderOf(session);
		const message = error instanceof Error ? error.message : String(error ?? '');
		const kind = failureKind(operationId, message);
		this.logService.info(`[DispatchFixit] ${operationId} failed (${kind ?? 'left to the host'}): ${message.slice(0, 200)}`);
		if (!session || !kind) {
			if (session && this._cards.get().get(session.sessionId)?.kind === 'committing') {
				this.set(session.sessionId, undefined);
			}
			return false;
		}
		if (!folder) {
			// not a folder on this Mac: no explanation from the CLI, still words instead of a raw error
			this.set(session.sessionId, { kind: 'explaining' });
			this.bringCardForward();
			void this.explain(session.sessionId, kind, '', message, '', '');
			return true;
		}
		const written = this.pending.get(session.sessionId);
		this.pending.delete(session.sessionId);
		this.set(session.sessionId, { kind: 'explaining' });
		this.bringCardForward();
		const base = session.workspace.get()?.folders[0]?.gitRepository?.baseBranchName;
		void this.explain(session.sessionId, kind, folder, message, written?.text ?? '', base ?? '');
		return true;
	}

	setOnScreen(card: object, onScreen: boolean): void {
		if (onScreen) {
			this.onScreen.add(card);
		} else {
			this.onScreen.delete(card);
		}
	}

	/**
	 * The card lives in the Changes tab. Commit in the title bar works from any tab: when it fails while Files,
	 * Docs or Now is in front (or the side pane is closed), the Changes tab comes forward so the person sees
	 * that nothing was committed and can let the agent fix it (kanban task-ljmg).
	 */
	private bringCardForward(): void {
		if (this.onScreen.size) {
			return;
		}
		this.logService.info('[DispatchFixit] no card on screen: opening the Changes tab');
		this.commandService.executeCommand(VIEW_SESSION_CHANGES_COMMAND_ID).catch(e => this.logService.warn('[DispatchFixit] open Changes', e));
	}

	private async explain(sessionId: string, kind: 'commit' | 'push' | 'conflicts', folder: string, error: string, message: string, base: string): Promise<void> {
		let problem: IDispatchProblem | undefined;
		try {
			if (!folder) {
				throw new Error('no local folder');
			}
			const ans = await this.commandService.executeCommand<IDispatchProblem & { error?: string }>('dispatch.fixExplain', kind, folder, error, message, base);
			if (ans && ans.problem && ans.title) {
				problem = ans;
			}
		} catch (e) {
			this.logService.warn('[DispatchFixit] explain', e);
		}
		if (!problem) {
			// no CLI: still no raw error box, the words git gave
			const titles = {
				commit: localize('dispatchFixit.commitFailed', "The commit didn't go through"),
				push: localize('dispatchFixit.pushFailed', "Your work wasn't sent"),
				conflicts: localize('dispatchFixit.conflicts', "Both sides changed the same lines"),
			};
			problem = { kind, problem: true, title: titles[kind], explain: error.split('\n').find(l => l.trim())?.slice(0, 200) ?? '', details: error, fixable: false, key: `${kind}:${error.length}` };
		}
		this.set(sessionId, { kind: 'problem', problem });
	}

	// --- the status of the folder ------------------------------------------------------------------

	watch(): { dispose(): void } {
		this.watchers++;
		if (this.watchers === 1) {
			void this.refresh();
			this.poll = setInterval(() => void this.refresh(), POLL_MS);
		}
		let done = false;
		return {
			dispose: () => {
				if (!done) {
					done = true;
					this.watchers--;
					if (this.watchers === 0) {
						this.stopPolling();
					}
				}
			}
		};
	}

	private stopPolling(): void {
		if (this.poll) {
			clearInterval(this.poll);
			this.poll = undefined;
		}
	}

	private async refresh(): Promise<void> {
		const session = this.active();
		const folder = this.folderOf(session);
		if (!session || !folder) {
			return;
		}
		const current = this._cards.get().get(session.sessionId);
		if (current && (current.kind === 'problem' || current.kind === 'sent' || (current.kind === 'fixed' && (current.how === 'answered' || current.how === 'ready'))) && !this.fromStatus(current.problem)) {
			await this.settle(session.sessionId, folder, current);
			return;
		}
		if (!this.replaceable(current)) {
			return; // the commit marker or a card being worked out is showing: it stays
		}
		let problems: IDispatchProblem[] = [];
		try {
			const ans = await this.commandService.executeCommand<{ problems?: IDispatchProblem[] }>('dispatch.fixStatus', folder);
			problems = ans?.problems ?? [];
		} catch (e) {
			this.logService.warn('[DispatchFixit] status', e);
			return;
		}
		if (this.active()?.sessionId !== session.sessionId) {
			return;
		}
		const now = this._cards.get().get(session.sessionId);
		if (!this.replaceable(now)) {
			return;
		}
		const shown = problems.find(p => p.problem && !this.closed.has(p.key));
		if (!shown) {
			if (now) {
				this.set(session.sessionId, undefined); // fixed (or closed): its card goes
			}
			return;
		}
		const sentTo = this.sentKeys.get(shown.key);
		this.set(session.sessionId, sentTo ? { kind: 'sent', problem: shown, agent: sentTo } : { kind: 'problem', problem: shown });
	}

	/**
	 * A failed commit, push or merge stays on the card until it is behind us (kanban task-mrdg): the agent (or
	 * the person) committed, the work went out, or what stopped it is fixed. Then the card says so: "Committed",
	 * which goes after a moment, or "Fixed. Press Commit again." Asked every 20 s while a card is on screen.
	 */
	private async settle(sessionId: string, folder: string, state: Extract<DispatchFixCardState, { kind: 'problem' | 'sent' | 'fixed' }>): Promise<void> {
		const { problem } = state;
		if (problem.kind !== 'commit' && problem.kind !== 'push' && problem.kind !== 'conflicts') {
			return;
		}
		let ans: IDispatchSettled | undefined;
		try {
			ans = await this.commandService.executeCommand<IDispatchSettled>('dispatch.fixSettled', folder, problem.kind, problem.head ?? '', problem.need ?? '');
		} catch (e) {
			this.logService.warn('[DispatchFixit] settled', e);
			return;
		}
		if (this._cards.get().get(sessionId) !== state) {
			return; // the card changed meanwhile
		}
		if (!ans?.settled) {
			// sent to the agent, and its turn has ended since: it answered in the chat; whether that fixed it shows
			// when the person tries again, so the card stops saying it is still fixing it
			const session = this.active();
			const ended = session?.sessionId === sessionId ? session.lastTurnEnd.get()?.getTime() ?? 0 : 0;
			const sentAt = this.sentAt.get(problem.key) ?? Infinity;
			if (state.kind === 'sent' && ended > sentAt && session?.status.get() !== SessionStatus.InProgress) {
				this.set(sessionId, { kind: 'fixed', problem, how: 'answered', agent: state.agent });
			}
			return;
		}
		this.logService.info(`[DispatchFixit] ${problem.kind} settled: ${ans.how}`);
		const agent = state.kind === 'sent' || state.kind === 'fixed' ? state.agent : undefined;
		if (state.kind === 'fixed' && state.how === ans.how) {
			return; // says so already
		}
		if (ans.how === 'clean') {
			this.set(sessionId, undefined);
		} else if (ans.how === 'committed' || ans.how === 'sent' || ans.how === 'ready') {
			this.set(sessionId, { kind: 'fixed', problem, how: ans.how, subject: ans.subject, agent });
		}
	}

	/** Only cards that came from the status may be replaced by the next status. */
	private replaceable(state: DispatchFixCardState | undefined): boolean {
		return !state || ((state.kind === 'problem' || state.kind === 'sent') && this.fromStatus(state.problem));
	}

	private fromStatus(p: IDispatchProblem): boolean {
		return p.kind === 'checks' || p.kind === 'comments' || (p.kind === 'conflicts' && !!p.files?.length);
	}

	// --- the button --------------------------------------------------------------------------------

	async fix(sessionId: string): Promise<void> {
		const state = this._cards.get().get(sessionId);
		const session = this.active();
		if (!state || state.kind !== 'problem' || !state.problem.prompt || !session || session.sessionId !== sessionId) {
			return;
		}
		const { problem } = state;
		const prompt = problem.prompt;
		if (!prompt) {
			return;
		}
		const agent = this.agentOf(session).label;
		this.sentKeys.set(problem.key, agent);
		this.sentAt.set(problem.key, Date.now());
		this.set(sessionId, { kind: 'sent', problem, agent });
		try {
			// the session's own chat when it is open (it queues behind a running turn), else start the session with it
			const widget = this.chatWidgetService.getWidgetBySessionResource(session.mainChat.get().resource);
			if (widget && session.status.get() !== SessionStatus.Untitled) {
				await widget.acceptInput(prompt);
			} else {
				await this.sessionsManagementService.sendNewChatRequest(session, { query: prompt });
			}
		} catch (e) {
			this.logService.error('[DispatchFixit] send to the agent', e);
			this.sentKeys.delete(problem.key);
			this.set(sessionId, { kind: 'problem', problem });
		}
	}

	dismiss(sessionId: string): void {
		const state = this._cards.get().get(sessionId);
		if (state && (state.kind === 'problem' || state.kind === 'sent' || state.kind === 'fixed')) {
			this.closed.add(state.problem.key);
		}
		this.set(sessionId, undefined);
	}
}

