/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the window's connection to Dispatch's terminal daemon (kanban app/termd/termd.cjs).
 *
 *  `dispatch.terminal daemon` (dispatch-bridge, then `dispatch terminal daemon start`) starts the daemon when
 *  it is not running and says where it listens: a WebSocket on 127.0.0.1 with a token. The page talks to it
 *  directly, so keystrokes and output do not pass through another process. When the connection drops (the
 *  daemon was stopped, the Mac slept) the client asks again and reconnects; the terminals are still there.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITermdSessionInfo } from './dispatchTerminalModel.js';

export interface ITermdSnapshot {
	readonly ansi: string;
	readonly cols: number;
	readonly rows: number;
	readonly cwd?: string | null;
	readonly title?: string | null;
	readonly alternateScreen?: boolean;
}

export type TermdEvent =
	| { readonly type: 'data'; readonly session: string; readonly data: string }
	| { readonly type: 'exit'; readonly session: string; readonly code?: number }
	| { readonly type: 'added' | 'changed'; readonly session: string; readonly info: ITermdSessionInfo }
	| { readonly type: 'removed'; readonly session: string };

interface IDaemonAddress {
	readonly ok?: boolean;
	readonly url?: string;
	readonly message?: string;
}

const RECONNECT_MS = [500, 1000, 2000, 4000, 8000];

export class TermdClient extends Disposable {
	private _socket: WebSocket | undefined;
	private _connecting: Promise<void> | undefined;
	private _nextId = 1;
	private readonly _pending = new Map<number, DeferredPromise<Record<string, unknown>>>();
	private _attempt = 0;
	private _disposed = false;

	private readonly _onEvent = this._register(new Emitter<TermdEvent>());
	readonly onEvent = this._onEvent.event;
	/** After a reconnect: the window attaches its terminals again. */
	private readonly _onDidReconnect = this._register(new Emitter<void>());
	readonly onDidReconnect = this._onDidReconnect.event;

	constructor(
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
	}

	get connected(): boolean {
		return this._socket?.readyState === WebSocket.OPEN;
	}

	/** Connects (starting the daemon when needed). Rejects with a sentence a person can read. */
	connect(): Promise<void> {
		if (this.connected) {
			return Promise.resolve();
		}
		this._connecting ??= this._open().finally(() => { this._connecting = undefined; });
		return this._connecting;
	}

	private async _open(): Promise<void> {
		let address: IDaemonAddress | undefined;
		try {
			address = await this._commands.executeCommand<IDaemonAddress>('dispatch.terminal', 'daemon');
		} catch (e) {
			throw new Error(`Dispatch could not start its terminal service: ${(e as Error)?.message ?? e}`);
		}
		if (!address?.ok || !address.url) {
			throw new Error(address?.message || 'Dispatch could not start its terminal service.');
		}
		const url = address.url;
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(url);
			let opened = false;
			socket.onopen = () => {
				opened = true;
				this._socket = socket;
				this._attempt = 0;
				resolve();
			};
			socket.onmessage = e => this._message(String(e.data));
			socket.onerror = () => {
				if (!opened) {
					reject(new Error('Dispatch could not reach its terminal service.'));
				}
			};
			socket.onclose = () => {
				if (this._socket === socket) {
					this._socket = undefined;
					this._failPending('The terminal service closed the connection.');
					this._scheduleReconnect();
				} else if (!opened) {
					reject(new Error('Dispatch could not reach its terminal service.'));
				}
			};
		});
	}

	private _scheduleReconnect(): void {
		if (this._disposed) {
			return;
		}
		const delay = RECONNECT_MS[Math.min(this._attempt++, RECONNECT_MS.length - 1)];
		mainWindow.setTimeout(() => {
			if (this._disposed || this.connected) {
				return;
			}
			this.connect().then(() => this._onDidReconnect.fire(), e => {
				this._log.warn('[dispatch terminal] reconnect failed', e);
				this._scheduleReconnect();
			});
		}, delay);
	}

	private _failPending(message: string): void {
		for (const p of this._pending.values()) {
			p.error(new Error(message));
		}
		this._pending.clear();
	}

	private _message(text: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof msg.id === 'number') {
			const p = this._pending.get(msg.id);
			if (p) {
				this._pending.delete(msg.id);
				if (msg.ok) {
					p.complete(msg);
				} else {
					p.error(new Error(String(msg.error ?? 'The terminal service refused.')));
				}
			}
			return;
		}
		if (typeof msg.type === 'string' && typeof msg.session === 'string') {
			this._onEvent.fire(msg as unknown as TermdEvent);
		}
	}

	/** One request; resolves with the answer. */
	async request<T extends Record<string, unknown>>(type: string, body: Record<string, unknown> = {}): Promise<T> {
		await this.connect();
		const id = this._nextId++;
		const deferred = new DeferredPromise<Record<string, unknown>>();
		this._pending.set(id, deferred);
		this._socket!.send(JSON.stringify({ ...body, type, id }));
		return deferred.p as Promise<T>;
	}

	/** Fire and forget (typing, resizing): no answer is waited for. */
	send(type: string, body: Record<string, unknown>): void {
		if (this.connected) {
			this._socket!.send(JSON.stringify({ ...body, type }));
		}
	}

	override dispose(): void {
		this._disposed = true;
		this._socket?.close();
		this._failPending('Closed.');
		super.dispose();
	}
}
