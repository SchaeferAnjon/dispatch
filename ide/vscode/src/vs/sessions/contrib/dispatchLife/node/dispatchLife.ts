/*---------------------------------------------------------------------------------------------
 *  Dispatch: bounded contexts behind one conversation. CLI owns measurement and handoff files;
 *  this contribution uses the host's existing /clear and deferred-turn admission paths.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IOutgoingTurn, type ISendContribution, type ITurnEnd } from '../../../../platform/agentHost/common/agentHostChatContributionsService.js';
import { ISessionDataService } from '../../../../platform/agentHost/common/sessionDataService.js';
import { MessageKind, withMessageHiddenFromTranscript, withMessageRequestHiddenFromTranscript, type Message } from '../../../../platform/agentHost/common/state/sessionState.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../../../platform/agentHost/node/agentHostStateManager.js';
import { IAgentHostTurnService, type IDeferredAgentHostTurn } from '../../../../platform/agentHost/node/agentHostTurnService.js';

interface Handoff {
	id: string;
	path: string;
	session: string;
	after_message: number;
	cleared?: boolean;
}

// /clear reads this only for an automatic handoff. Ordinary /clear is unchanged.
export const dispatchHandoffBoundaries = new Map<string, Handoff>();

interface Phase {
	stage: 'checking' | 'writing' | 'preparing' | 'clearing' | 'resuming';
	request?: string;
	prompt?: string;
	instruction?: string;
	model?: Message['model'];
}

function cli(args: string[], input?: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const local = join(homedir(), '.local', 'bin', 'dispatch');
		const target = process.env.DISPATCH_BIN || process.env.DISPATCH_CLI || (existsSync(local) ? local : 'dispatch');
		const python = target.endsWith('.py');
		const env = { ...process.env, PATH: [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(delimiter) };
		const child = execFile(python ? process.env.DISPATCH_PYTHON || 'python3' : target, python ? [target, ...args] : args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
			if (err) { reject(new Error(stderr.trim() || err.message)); } else { resolve(stdout); }
		});
		child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
	});
}

export class DispatchLifeContribution extends Disposable implements IAgentHostChatContribution {
	static readonly id = 'dispatchLife';
	readonly order = 150; // a handoff reserves its next turn before QueueDrain (200)
	private readonly phases = new Map<string, Phase>();
	private readonly warned = new Set<string>();
	private readonly registered = new Map<string, string>();
	private readonly pendingWarnings = new Map<string, string>();

	constructor(
		_context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly state: AgentHostStateManager,
		@IAgentHostTurnService private readonly turns: IAgentHostTurnService,
		@ISessionDataService private readonly data: ISessionDataService,
		@ILogService private readonly log: ILogService,
	) { super(); }

	private supports(session: string, channel: string): boolean {
		return /^(claude|codex|opencode):/.test(session) && this.state.getSessionState(session)?.defaultChat === channel;
	}

	private async identity(session: string, channel: string): Promise<{ session: string; native_session: string; cwd: string; messages: number }> {
		const uri = URI.parse(session);
		const agent = uri.scheme === 'claude' ? 'claude-code' : uri.scheme;
		const ref = this.data.openDatabase(uri);
		let native = uri.path.replace(/^\//, '');
		try {
			const raw = await ref.object.getMetadata('defaultChatProviderData');
			const provider = raw ? JSON.parse(raw) : {};
			native = provider.sdkSessionId || provider.threadId || provider.opencodeSessionId || await ref.object.getMetadata('codex.threadId') || native;
		} finally { ref.dispose(); }
		const current = this.state.getSessionState(channel);
		return { session: `${agent}:${uri.path.replace(/^\//, '')}`, native_session: `${agent}:${native}`,
			cwd: current?.workingDirectories?.[0] ? URI.parse(current.workingDirectories[0]).fsPath : process.cwd(),
			messages: (current?.turns.length || 0) * 2 };
	}

	async onOutgoingTurn(turn: IOutgoingTurn): Promise<ISendContribution | undefined> {
		if (!this.supports(turn.session, turn.chat)) { return undefined; }
		try {
			const identity = await this.identity(turn.session, turn.chat);
			if (this.registered.get(turn.chat) !== identity.native_session) {
				await cli(['handoff', 'assess'], { ...identity, register: true });
				this.registered.set(turn.chat, identity.native_session);
			}
		} catch (error) { this.log.warn('[DispatchLife] register', error); }
		const phase = this.phases.get(turn.chat);
		if (phase?.stage === 'writing' && phase.instruction) { return { text: phase.instruction }; }
		if (phase?.stage === 'resuming' && phase.prompt) { return { text: phase.prompt }; }
		const warning = this.pendingWarnings.get(turn.chat);
		this.pendingWarnings.delete(turn.chat);
		return warning ? { instructions: [warning] } : undefined;
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (!this.supports(turn.session, turn.channel)) { return; }
		const phase = this.phases.get(turn.channel);
		if (phase?.stage === 'resuming') {
			this.phases.delete(turn.channel);
			void this.identity(turn.session, turn.channel).then(identity => cli(['handoff', 'assess'], identity))
				.catch(error => this.log.warn('[DispatchLife] refresh after handoff', error));
			return; // do not loop if prime alone exceeds a very low test threshold
		}
		if (phase?.stage === 'clearing') {
			const boundary = dispatchHandoffBoundaries.get(turn.channel);
			dispatchHandoffBoundaries.delete(turn.channel);
			if (!boundary?.cleared) { this.phases.delete(turn.channel); return; }
			phase.stage = 'resuming';
			this.warned.delete(turn.channel);
			this.turns.startTurnMessage(URI.parse(turn.channel), this.message('Continue from context handoff', phase.model, 'request'));
			return;
		}
		if (turn.reason.kind !== 'success') {
			this.phases.delete(turn.channel);
			if (phase?.stage === 'writing') {
				// the turn that was to write the handoff was cancelled or failed: tell the CLI, so the status line does
				// not keep saying "Saving progress"
				void this.identity(turn.session, turn.channel).then(identity => cli(['handoff', 'fail', '--session', identity.session,
					...(phase.request ? ['--request', phase.request] : []), '--reason', turn.reason.kind === 'cancelled' ? 'The handoff turn was cancelled.' : 'The handoff turn did not finish.']))
					.catch(error => this.log.warn('[DispatchLife] report failed handoff', error));
			}
			return;
		}
		if (phase?.stage === 'writing') {
			phase.stage = 'preparing';
			const deferred = this.turns.beginDeferredTurnMessage(URI.parse(turn.channel), this.message('Context handoff', phase.model, 'request'));
			void this.prepare(turn, phase, deferred);
			return;
		}
		if (phase) { return; }
		this.phases.set(turn.channel, { stage: 'checking' });
		void this.check(turn);
	}

	/**
	 * The handoff is seamless in the conversation: the turn that writes the handoff is hidden, the /clear turn
	 * shows only its "Context handed off" line, and the turn that continues shows only the agent's reply.
	 * The turns stay in the session's record; the status line under the input shows the progress.
	 */
	private message(text: string, model: Message['model'] | undefined, hide: 'turn' | 'request'): Message {
		const message: Message = { text, origin: { kind: MessageKind.SystemNotification }, ...(model ? { model } : {}) };
		if (hide === 'turn') { return withMessageHiddenFromTranscript(message, true); }
		// /clear is matched on its text, so it carries the flag without the hidden-text prefix
		return text.startsWith('/') ? { ...message, _meta: { ...message._meta, 'vscode.chat.requestHiddenFromTranscript': true } } : withMessageRequestHiddenFromTranscript(message, true);
	}

	private async check(turn: ITurnEnd): Promise<void> {
		try {
			const identity = await this.identity(turn.session, turn.channel);
			const result: { life: { status: string; percent: number }; request?: string; instruction?: string } = JSON.parse(await cli(['handoff', 'assess'], identity));
			const state = this.state.getSessionState(turn.channel);
			// A user may have started another turn while measurement ran. Let that
			// turn finish; never reset a running context or replace its prompt.
			if (!state || this.state.getActiveTurnId(turn.channel)) { this.phases.delete(turn.channel); return; }
			const model = state.draft?.model ?? state.turns.at(-1)?.message.model;
			if (result.request && result.instruction) {
				this.phases.set(turn.channel, { stage: 'writing', request: result.request, instruction: result.instruction, model });
				this.turns.startTurnMessage(URI.parse(turn.channel), this.message('Preparing context handoff', model, 'turn'));
			} else {
				this.phases.delete(turn.channel);
				if (result.life.status === 'warning' && !this.warned.has(turn.channel)) {
					this.warned.add(turn.channel);
					this.pendingWarnings.set(turn.channel, `Dispatch context lifetime ${result.life.percent}%. Finish a safe step and prepare a concise handoff.`);
					// Warning is attached to the next outgoing turn, without starting
					// a model turn merely to announce a percentage.
					this.log.info(`[DispatchLife] Context lifetime ${result.life.percent}%: ${turn.session}`);
				}
			}
		} catch (error) {
			this.phases.delete(turn.channel);
			this.log.warn('[DispatchLife] measure', error);
		}
	}

	private async prepare(turn: ITurnEnd, phase: Phase, deferred: IDeferredAgentHostTurn): Promise<void> {
		try {
			const identity = await this.identity(turn.session, turn.channel);
			// Include the writer's requests in the old context's cumulative usage
			// before /clear makes that context an archived segment.
			await cli(['handoff', 'assess'], identity);
			const result: { handoff: Handoff; prompt: string } = JSON.parse(await cli(['handoff', 'resume', phase.request!, '--cwd', identity.cwd, '--json']));
			if (result.handoff.session !== identity.session) { throw new Error('Handoff belongs to another conversation'); }
			if (this.state.getActiveTurnId(turn.channel) !== deferred.turnId) { this.phases.delete(turn.channel); return; }
			phase.stage = 'clearing';
			phase.prompt = result.prompt;
			dispatchHandoffBoundaries.set(turn.channel, result.handoff);
			this.turns.continueDeferredTurnMessage(URI.parse(turn.channel), deferred, this.message('/clear', phase.model, 'request'));
		} catch (error) {
			this.phases.delete(turn.channel);
			this.turns.failDeferredTurnMessage(URI.parse(turn.channel), deferred, { errorType: 'handoff', message: `Context retained: ${String(error)}` });
		}
	}
}
