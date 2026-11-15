/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the agent host's engines and the network (patches/270-network.patch; kanban app/cli/net.py).
 *
 *  Proxy: Claude Code, Codex and OpenCode run under this process and take its environment. Before anything else starts
 *  (agentHostMain.ts, one call), and every minute after, the host asks `dispatch net env` (this Mac's proxy settings with its PAC file, or the proxy set in Dispatch's
 *  Settings > Network) and puts the answer into process.env, so the next engine started goes out through it. The CLI is
 *  asked with the variables the app started with, so an answer never feeds the next one; a proxy the person exported
 *  in their own shell stays as it is (the CLI leaves those alone).
 *
 *  Reconnect: a person's message whose turn ended with a connection error (the engine already tried on its own) goes
 *  out again after 3, 10, 30 and 60 seconds. Meanwhile the conversation shows one line in plain words ("Lost the
 *  connection to Claude's servers. Trying again in 3 seconds (2 of 5)…"), as a turn of its own that is waiting; when
 *  it is time, that turn carries the person's words to the engine with one line in front. Stopping it stops the tries;
 *  a turn that works, or fails for another reason, ends them. chatd does the same for its sessions (chat_retry.py).
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IOutgoingTurn, type ISendContribution, type ITurnEnd } from '../../../../platform/agentHost/common/agentHostChatContributionsService.js';
import { MessageKind, type Message } from '../../../../platform/agentHost/common/state/sessionState.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../../../platform/agentHost/node/agentHostStateManager.js';
import { IAgentHostTurnService, type IDeferredAgentHostTurn } from '../../../../platform/agentHost/node/agentHostTurnService.js';
import { gaveUpNotice, INetEnv, isNetworkError, PROXY_KEYS, proxyVariables, reconnectNotice, RETRY_DELAYS, RETRY_PREFIX } from '../common/dispatchNetModel.js';

const REFRESH_MS = 60_000;
const STALE_MS = 15_000;
/** The first turn waits this long at most for the first answer about the proxy. */
const FIRST_ANSWER_MS = 4000;
const SUPPORTED = /^(claude|codex|opencode):/;

function command(args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
	const local = join(homedir(), '.local', 'bin', 'dispatch');
	const target = process.env.DISPATCH_BIN || process.env.DISPATCH_CLI || (existsSync(local) ? local : 'dispatch');
	const python = target.endsWith('.py');
	const withPath = { ...env, PATH: [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || ''].join(delimiter) };
	return { file: python ? process.env.DISPATCH_PYTHON || 'python3' : target, args: python ? [target, ...args] : args, env: withPath };
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const c = command(args, env);
		execFile(c.file, c.args, { env: c.env, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
			if (err) { reject(new Error(stderr.trim() || err.message)); } else { resolve(stdout); }
		});
	});
}

/** The proxy variables as the app started, before Dispatch put anything there. */
const started: Record<string, string | undefined> = Object.fromEntries(PROXY_KEYS.map(k => [k, process.env[k]]));
let refreshing: Promise<void> | undefined;
let answered = false;
let logged = false;
let lastAnswer = 0;

/** The environment the CLI is asked with: the proxy variables as the app started, so an answer never feeds the next. */
function askEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of PROXY_KEYS) {
		if (started[k] === undefined) { delete env[k]; } else { env[k] = started[k]; }
	}
	return env;
}

/** Put `dispatch net env`'s answer into process.env; true when something changed. */
function apply(answer: INetEnv): boolean {
	const next = proxyVariables(started, answer);
	let changed = false;
	for (const k of PROXY_KEYS) {
		if (process.env[k] !== next[k]) {
			changed = true;
			if (next[k] === undefined) { delete process.env[k]; } else { process.env[k] = next[k]; }
		}
	}
	return changed;
}

/**
 * At the agent host's start, before any engine can start: the proxy, waiting for the answer (a few hundred
 * milliseconds; a PAC file that cannot be read gives up after four seconds). Never throws.
 */
export function applyProxyEnvironmentSync(): void {
	try {
		const c = command(['net', 'env', '--json'], askEnv());
		apply(JSON.parse(execFileSync(c.file, c.args, { env: c.env, timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as INetEnv);
		answered = true;
	} catch {
		// no CLI, or it took too long: the contribution asks again shortly
	}
}

/** Ask `dispatch net env` and put the proxy into this process's environment. Never throws. */
export function refreshProxyEnvironment(log: ILogService): Promise<void> {
	refreshing ??= (async () => {
		try {
			const answer = JSON.parse(await cli(['net', 'env', '--json'], askEnv())) as INetEnv & { source?: string; proxy?: string };
			lastAnswer = Date.now();
			if (apply(answer) || !logged) {
				logged = true;
				log.info(`[DispatchNet] engines' proxy: ${answer.source || 'none'}${answer.proxy ? ` (${answer.proxy})` : ''}`);
			}
		} catch (error) {
			log.warn('[DispatchNet] could not read the proxy', error);
		} finally {
			answered = true;
			refreshing = undefined;
		}
	})();
	return refreshing;
}

interface IPending {
	/** The person's words and what they went with. */
	readonly text: string;
	readonly attachments?: Message['attachments'];
	readonly model?: Message['model'];
	readonly agent?: Message['agent'];
	/** How many times they went out. */
	tries: number;
	/** The waiting turn that will carry them again. */
	deferred?: IDeferredAgentHostTurn;
	timer?: ReturnType<typeof setTimeout>;
	/** Set once the tries are over: the closing line's turn is ours too. */
	gaveUp?: boolean;
}

export class DispatchNetContribution extends Disposable implements IAgentHostChatContribution {
	static readonly id = 'dispatchNet';
	/** After the context lifetime (150), before the queue drains (200): a waiting try comes before the next queued message. */
	readonly order = 160;
	private readonly pending = new Map<string, IPending>();

	constructor(
		_context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly state: AgentHostStateManager,
		@IAgentHostTurnService private readonly turns: IAgentHostTurnService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		void refreshProxyEnvironment(log);
		const timer = setInterval(() => void refreshProxyEnvironment(log), REFRESH_MS);
		(timer as unknown as NodeJS.Timeout).unref?.();
		this._register({ dispose: () => { clearInterval(timer); for (const p of this.pending.values()) { this.stopTimer(p); } } });
	}

	async onOutgoingTurn(turn: IOutgoingTurn): Promise<ISendContribution | undefined> {
		if (!answered) {
			// the first engine of this run may start with this turn: give the proxy answer a moment
			await Promise.race([refreshProxyEnvironment(this.log), new Promise(r => setTimeout(r, FIRST_ANSWER_MS))]);
		} else if (Date.now() - lastAnswer > STALE_MS) {
			void refreshProxyEnvironment(this.log); // an engine started for this turn gets a fresh answer next time
		}
		if (!SUPPORTED.test(turn.session)) {
			return undefined;
		}
		const mine = this.pending.get(turn.chat);
		if (mine?.deferred?.turnId === turn.turnId) {
			return undefined; // a try of ours: it already carries the words
		}
		if (turn.message.origin.kind === MessageKind.User) {
			this.clear(turn.chat);
			this.pending.set(turn.chat, { text: turn.message.text, attachments: turn.message.attachments, model: turn.message.model, agent: turn.message.agent, tries: 1 });
		}
		return undefined;
	}

	onTurnEnd(turn: ITurnEnd): void {
		const p = this.pending.get(turn.channel);
		if (!p || !SUPPORTED.test(turn.session)) {
			return;
		}
		if (p.gaveUp) {
			this.pending.delete(turn.channel);
			return;
		}
		if (p.deferred && turn.turnId !== p.deferred.turnId && turn.reason.kind !== 'rejected') {
			return; // another turn (a side chat, a host notice) ended meanwhile
		}
		const r = turn.reason;
		if (r.kind !== 'error' || !isNetworkError(r.error.message)) {
			this.clear(turn.channel);
			return;
		}
		this.stopTimer(p);
		p.deferred = undefined;
		const chat = URI.parse(turn.channel);
		if (p.tries > RETRY_DELAYS.length) {
			p.gaveUp = true;
			this.notice(chat, p, gaveUpNotice(turn.session, p.tries), deferred => {
				this.turns.failDeferredTurnMessage(chat, deferred, { errorType: 'dispatchNetwork', message: 'No connection.' });
			});
			return;
		}
		const delay = RETRY_DELAYS[p.tries - 1];
		this.notice(chat, p, reconnectNotice(turn.session, delay, p.tries), deferred => {
			p.deferred = deferred;
			p.timer = setTimeout(() => this.send(turn.channel, chat, p), delay * 1000);
		});
	}

	/** Start the waiting turn that shows `text`; a turn already running (a queued message went first) means no try. */
	private notice(chat: URI, p: IPending, text: string, then: (deferred: IDeferredAgentHostTurn) => void): void {
		const message: Message = { text, origin: { kind: MessageKind.SystemNotification }, ...(p.model ? { model: p.model } : {}), ...(p.agent ? { agent: p.agent } : {}) };
		try {
			then(this.turns.beginDeferredTurnMessage(chat, message));
		} catch (error) {
			this.log.info(`[DispatchNet] not trying again: ${String(error)}`);
			this.pending.delete(chat.toString());
		}
	}

	private send(channel: string, chat: URI, p: IPending): void {
		p.timer = undefined;
		const deferred = p.deferred;
		if (!deferred || this.pending.get(channel) !== p) {
			return;
		}
		if (this.state.getActiveTurnId(channel) !== deferred.turnId) {
			this.pending.delete(channel); // stopped while it waited
			return;
		}
		p.tries++;
		const text = RETRY_PREFIX + p.text;
		const message: Message = {
			text, origin: { kind: MessageKind.User },
			...(p.attachments ? { attachments: p.attachments } : {}), ...(p.model ? { model: p.model } : {}), ...(p.agent ? { agent: p.agent } : {}),
		};
		if (!this.turns.continueDeferredTurnMessage(chat, deferred, message)) {
			this.pending.delete(channel);
		}
	}

	private stopTimer(p: IPending): void {
		if (p.timer) {
			clearTimeout(p.timer);
			p.timer = undefined;
		}
	}

	private clear(channel: string): void {
		const p = this.pending.get(channel);
		if (p) {
			this.stopTimer(p);
			this.pending.delete(channel);
		}
	}
}
