/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a minimal Agent Client Protocol client for `opencode acp` (JSON-RPC 2.0, one JSON
 *  object per line on stdio, https://agentclientprotocol.com). One process serves every OpenCode
 *  chat of the agent host: ACP sessions are addressed by id, so the notifications
 *  (`session/update`) and the agent's own requests (`session/request_permission`) name the session
 *  they belong to and the harness routes them. Only what the OpenCode harness uses.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export interface IAcpNotification {
	readonly method: string;
	readonly params: Record<string, unknown>;
}

/** An update inside `session/update` (agent_message_chunk, tool_call, tool_call_update, …). */
export interface IAcpSessionUpdate {
	readonly sessionUpdate: string;
	readonly messageId?: string;
	readonly content?: unknown;
	readonly toolCallId?: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	readonly rawInput?: unknown;
	readonly rawOutput?: unknown;
	readonly locations?: readonly { readonly path?: string }[];
	readonly [key: string]: unknown;
}

export interface IAcpPermissionOption {
	readonly optionId: string;
	readonly name?: string;
	readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface IAcpPermissionRequest {
	readonly sessionId: string;
	readonly toolCall: IAcpSessionUpdate;
	readonly options: readonly IAcpPermissionOption[];
}

/** One of a session's config options (`session/new`, `session/load` and `config_option_update`). */
export interface IAcpConfigOption {
	readonly id: string;
	readonly name?: string;
	readonly category?: string;
	readonly type?: string;
	readonly currentValue?: unknown;
	readonly options?: readonly { readonly value: string; readonly name?: string; readonly description?: string }[];
}

export class AcpError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
		this.name = 'AcpError';
	}
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class OpenCodeAcpClient extends Disposable {
	private readonly _child: ChildProcessWithoutNullStreams;
	private readonly _pending = new Map<number, Pending>();
	private _nextId = 0;
	private _buffer = '';
	private _exited = false;

	private readonly _onNotification = this._register(new Emitter<IAcpNotification>());
	readonly onNotification = this._onNotification.event;

	private readonly _onExit = this._register(new Emitter<string>());
	readonly onExit = this._onExit.event;

	/** Answers the agent's requests (`session/request_permission`); unset or throwing means "not supported". */
	requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;

	constructor(binary: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, private readonly _log: (message: string) => void) {
		super();
		this._child = spawn(binary, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', (chunk: string) => this._onData(chunk));
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => this._log(`[OpenCode stderr] ${chunk.trimEnd()}`));
		this._child.on('error', error => this._fail(`opencode acp: ${error.message}`));
		this._child.on('exit', (code, signal) => this._fail(`opencode acp exited (${signal ?? code})`));
		this._child.stdin.on('error', () => { /* the exit handler reports it */ });
	}

	get pid(): number | undefined {
		return this._child.pid;
	}

	get exited(): boolean {
		return this._exited;
	}

	/** A request; `timeoutMs` 0 waits as long as it takes (a prompt runs a whole turn). */
	request<T>(method: string, params: Record<string, unknown>, timeoutMs = 0): Promise<T> {
		if (this._exited) {
			return Promise.reject(new AcpError(-32000, 'opencode acp is not running'));
		}
		const id = ++this._nextId;
		return new Promise<T>((resolve, reject) => {
			const pending: Pending = { resolve: value => resolve(value as T), reject };
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					if (this._pending.delete(id)) {
						reject(new AcpError(-32001, `${method} did not answer within ${Math.round(timeoutMs / 1000)} s`));
					}
				}, timeoutMs);
			}
			this._pending.set(id, pending);
			this._write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		if (!this._exited) {
			this._write({ jsonrpc: '2.0', method, params });
		}
	}

	private _write(message: unknown): void {
		try {
			this._child.stdin.write(JSON.stringify(message) + '\n');
		} catch (error) {
			this._log(`[OpenCode] write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _onData(chunk: string): void {
		this._buffer += chunk;
		let newline: number;
		while ((newline = this._buffer.indexOf('\n')) >= 0) {
			const line = this._buffer.slice(0, newline).trim();
			this._buffer = this._buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } };
			try {
				message = JSON.parse(line);
			} catch {
				this._log(`[OpenCode] not JSON: ${line.slice(0, 200)}`);
				continue;
			}
			if (message.method && message.id !== undefined) {
				void this._onRequest(message.id, message.method, message.params ?? {});
			} else if (message.method) {
				this._onNotification.fire({ method: message.method, params: message.params ?? {} });
			} else if (typeof message.id === 'number') {
				const pending = this._pending.get(message.id);
				this._pending.delete(message.id);
				if (pending?.timer) {
					clearTimeout(pending.timer);
				}
				if (message.error) {
					const detail = message.error.data && typeof message.error.data === 'object' ? ` ${JSON.stringify(message.error.data).slice(0, 300)}` : '';
					pending?.reject(new AcpError(message.error.code, `${message.error.message}${detail}`));
				} else {
					pending?.resolve(message.result);
				}
			}
		}
	}

	private async _onRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
		if (this.requestHandler) {
			try {
				const result = await this.requestHandler(method, params);
				this._write({ jsonrpc: '2.0', id, result });
				return;
			} catch (error) {
				if (!(error instanceof AcpError)) {
					this._log(`[OpenCode] ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				this._write({ jsonrpc: '2.0', id, error: { code: error instanceof AcpError ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } });
				return;
			}
		}
		// fs/* and terminal/* are not advertised in initialize, so OpenCode uses its own tools
		this._write({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported by this client` } });
	}

	private _fail(reason: string): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		this._rejectAll(reason);
		this._onExit.fire(reason);
	}

	private _rejectAll(reason: string): void {
		for (const pending of this._pending.values()) {
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
			pending.reject(new AcpError(-32000, reason));
		}
		this._pending.clear();
	}

	override dispose(): void {
		const wasRunning = !this._exited;
		this._exited = true;
		this._rejectAll('disposed');
		if (wasRunning && this._child.exitCode === null) {
			this._child.kill('SIGTERM');
		}
		super.dispose();
	}
}
