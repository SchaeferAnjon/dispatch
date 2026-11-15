/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's question tool in the Agents window. ACP has no request for it: OpenCode
 *  leaves the tool out of ACP sessions unless OPENCODE_ENABLE_QUESTION_TOOL is set, and even then its
 *  ACP side never asks the client. So the harness starts `opencode acp` with the tool on and gives the
 *  HTTP server inside it (the ACP agent is that server's client too) a port and a password of ours:
 *  `question.asked` arrives on /global/event and becomes the host's question card (ChatInputRequested,
 *  as Claude's AskUserQuestion does); the answer goes to POST /question/<id>/reply, a dismissal to
 *  /question/<id>/reject, and the tool call goes on in the same turn.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, type ChatInputOption, type ChatInputQuestion } from '../../common/state/protocol/state.js';
import type { ChatInputAnswer } from '../../common/state/sessionState.js';
import { isTypeYourOwnChoice } from './opencodeQuestionChoices.js';
import { parseStreamEvent, type IOpenCodeMessage, type OpenCodeStreamEvent } from './opencodeSubagentSteps.js';

/** OpenCode gives the model its `question` tool in an ACP session only with this set (1.18). */
export const OPENCODE_QUESTION_TOOL_ENV = 'OPENCODE_ENABLE_QUESTION_TOOL';
/** The password of OpenCode's own server; its ACP agent sends it too. */
export const OPENCODE_SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

export const enum OpenCodeQuestionEventType {
	Asked = 'question.asked',
	Replied = 'question.replied',
	Rejected = 'question.rejected',
}

/** One question as OpenCode asks it. */
export interface IOpenCodeQuestion {
	readonly question: string;
	readonly header: string;
	readonly options: readonly { readonly label: string; readonly description?: string }[];
	/** several choices may be picked */
	readonly multiple?: boolean;
	/** a typed answer is allowed (OpenCode's default: yes) */
	readonly custom?: boolean;
}

/** A question event from /global/event, with the folder (OpenCode instance) it belongs to. */
export interface IOpenCodeQuestionEvent {
	readonly type: OpenCodeQuestionEventType;
	readonly directory: string;
	readonly properties: {
		readonly id?: string;
		readonly requestID?: string;
		readonly sessionID?: string;
		readonly questions?: readonly IOpenCodeQuestion[];
		readonly tool?: { readonly messageID?: string; readonly callID?: string };
	};
}

const QUESTION_TYPES: ReadonlySet<string> = new Set([OpenCodeQuestionEventType.Asked, OpenCodeQuestionEventType.Replied, OpenCodeQuestionEventType.Rejected]);

/** A free local port (for `opencode acp --port`). */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => port ? resolve(port) : reject(new Error('no free port')));
		});
	});
}

export function newServerPassword(): string {
	return randomBytes(16).toString('hex');
}

/** The question events in one line of /global/event (`data: {directory, payload: {type, properties}}`). */
export function parseQuestionEvent(line: string): IOpenCodeQuestionEvent | undefined {
	if (!line.startsWith('data:') || !line.includes('"question.')) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(line.slice(5));
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const event = value as { directory?: unknown; payload?: { type?: unknown; properties?: unknown } };
	const payload = event.payload && typeof event.payload === 'object' ? event.payload : event as { type?: unknown; properties?: unknown };
	if (typeof payload.type !== 'string' || !QUESTION_TYPES.has(payload.type) || !payload.properties || typeof payload.properties !== 'object') {
		return undefined;
	}
	return { type: payload.type as OpenCodeQuestionEventType, directory: typeof event.directory === 'string' ? event.directory : '', properties: payload.properties as IOpenCodeQuestionEvent['properties'] };
}

/**
 * The HTTP server inside the running `opencode acp`: the question events it streams and the
 * answers it takes. Disposed with the process.
 */
export class OpenCodeServer extends Disposable {
	private readonly _auth: string;
	private _request: http.ClientRequest | undefined;

	constructor(readonly port: number, password: string, private readonly _log: (message: string) => void) {
		super();
		this._auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
	}

	private _path(path: string, directory?: string): string {
		return directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;
	}

	private _call<T>(method: 'GET' | 'POST', path: string, body?: unknown, directory?: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const req = http.request({
				host: '127.0.0.1', port: this.port, method, path: this._path(path, directory), timeout: 10_000,
				headers: { Authorization: this._auth, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
			}, res => {
				const chunks: Buffer[] = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if ((res.statusCode ?? 500) >= 300) {
						reject(new Error(`${method} ${path}: ${res.statusCode} ${text.slice(0, 200)}`));
						return;
					}
					try {
						resolve((text ? JSON.parse(text) : undefined) as T);
					} catch {
						resolve(undefined as T);
					}
				});
			});
			req.on('timeout', () => req.destroy(new Error(`${method} ${path}: no answer in 10 s`)));
			req.on('error', reject);
			req.end(data);
		});
	}

	/** Dispatch IDE: OpenCode's commands in a folder with where each comes from (the slash menu tells skills apart). */
	commands(directory: string): Promise<readonly { readonly name: string; readonly source?: string }[]> {
		return this._call<readonly { readonly name: string; readonly source?: string }[]>('GET', '/command', undefined, directory).then(list => Array.isArray(list) ? list : []);
	}

	/** Questions OpenCode is waiting on in a folder (after a reconnect, the ones asked meanwhile). */
	pending(directory: string): Promise<readonly NonNullable<IOpenCodeQuestionEvent['properties']>[]> {
		return this._call<readonly NonNullable<IOpenCodeQuestionEvent['properties']>[]>('GET', '/question', undefined, directory).then(list => Array.isArray(list) ? list : []);
	}

	reply(requestId: string, directory: string, answers: readonly (readonly string[])[]): Promise<void> {
		return this._call<void>('POST', `/question/${encodeURIComponent(requestId)}/reply`, { answers }, directory);
	}

	reject(requestId: string, directory: string): Promise<void> {
		return this._call<void>('POST', `/question/${encodeURIComponent(requestId)}/reject`, {}, directory);
	}

	/** Dispatch IDE: a session's messages with their parts (a sub-agent's child session, its steps after a restart). */
	messages(sessionId: string, directory?: string): Promise<readonly IOpenCodeMessage[]> {
		return this._call<readonly IOpenCodeMessage[]>('GET', `/session/${encodeURIComponent(sessionId)}/message`, undefined, directory).then(list => Array.isArray(list) ? list : []);
	}

	/**
	 * Follow /global/event until disposed; a dropped stream is opened again, `onConnect` runs each time.
	 * Dispatch IDE: `onStream` gets the parts and messages of every session (a sub-agent's steps, opencodeSubagentMirror.ts).
	 */
	listen(onEvent: (event: IOpenCodeQuestionEvent) => void, onConnect: () => void, onStream?: (event: OpenCodeStreamEvent) => void): void {
		let delay = 500;
		const connect = () => {
			if (this._store.isDisposed) {
				return;
			}
			const req = http.get({ host: '127.0.0.1', port: this.port, path: '/global/event', headers: { Authorization: this._auth, Accept: 'text/event-stream' } }, res => {
				if ((res.statusCode ?? 500) >= 300) {
					res.resume();
					retry(`status ${res.statusCode}`);
					return;
				}
				delay = 500;
				onConnect();
				let buffer = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk;
					let newline: number;
					while ((newline = buffer.indexOf('\n')) >= 0) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						const event = parseQuestionEvent(line);
						if (event) {
							onEvent(event);
						} else if (onStream) {
							const other = parseStreamEvent(line);
							if (other) {
								onStream(other);
							}
						}
					}
				});
				res.on('end', () => retry('the stream ended'));
				res.on('error', error => retry(String(error)));
			});
			req.on('error', error => retry(String(error)));
			this._request = req;
		};
		const retry = (why: string) => {
			if (this._store.isDisposed) {
				return;
			}
			this._log(`[OpenCode] question events: ${why}; again in ${delay} ms`);
			setTimeout(connect, delay);
			delay = Math.min(delay * 2, 5000);
		};
		connect();
	}

	override dispose(): void {
		this._request?.destroy();
		this._request = undefined;
		super.dispose();
	}
}

/** The card's id of the `idx`-th question: its header (as Claude's cards), else its place. */
function questionIds(questions: readonly IOpenCodeQuestion[]): string[] {
	const seen = new Set<string>();
	return questions.map((q, idx) => {
		let id = q.header || `q-${idx}`;
		if (seen.has(id)) {
			id = `${id}-${idx}`;
		}
		seen.add(id);
		return id;
	});
}

/** OpenCode's questions as the host's question card. */
export function toChatInputQuestions(questions: readonly IOpenCodeQuestion[]): ChatInputQuestion[] {
	const ids = questionIds(questions);
	return questions.map((q, idx): ChatInputQuestion => {
		const all = q.options ?? [];
		const typed = all.some(o => isTypeYourOwnChoice(o.label));
		const options: ChatInputOption[] = all.filter(o => !isTypeYourOwnChoice(o.label)).map(o => ({ id: o.label, label: o.label, ...(o.description ? { description: o.description } : {}) }));
		const base = { id: ids[idx], title: q.header || undefined, message: q.question || q.header };
		if (!options.length) {
			return { ...base, kind: ChatInputQuestionKind.Text };
		}
		const allowFreeformInput = q.custom !== false || typed;
		return q.multiple
			? { ...base, kind: ChatInputQuestionKind.MultiSelect, options, allowFreeformInput }
			: { ...base, kind: ChatInputQuestionKind.SingleSelect, options, allowFreeformInput };
	});
}

/** The card's answers as OpenCode takes them: per question, in order, the labels picked and anything typed. */
export function toOpenCodeAnswers(questions: readonly IOpenCodeQuestion[], answers: Record<string, ChatInputAnswer> | undefined): string[][] {
	const ids = questionIds(questions);
	return questions.map((_q, idx) => {
		const answer = answers?.[ids[idx]];
		if (!answer || answer.state === ChatInputAnswerState.Skipped) {
			return [];
		}
		const value = answer.value;
		const out: string[] = [];
		switch (value.kind) {
			case ChatInputAnswerValueKind.Selected:
				if (value.value) {
					out.push(value.value);
				}
				out.push(...(value.freeformValues ?? []));
				break;
			case ChatInputAnswerValueKind.SelectedMany:
				out.push(...value.value, ...(value.freeformValues ?? []));
				break;
			case ChatInputAnswerValueKind.Text:
				out.push(value.value);
				break;
			case ChatInputAnswerValueKind.Number:
			case ChatInputAnswerValueKind.Boolean:
				out.push(String(value.value));
				break;
		}
		return out.filter(s => s.trim());
	});
}
