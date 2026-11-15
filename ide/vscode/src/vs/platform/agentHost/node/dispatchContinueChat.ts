/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: History's "Continue in chat" (kanban task-b1ppr). A conversation an agent kept on its own
 *  (Claude Code's ~/.claude, Codex's ~/.codex, OpenCode's database) that the Agents window never listed joins its
 *  sessions as an ordinary session: the window shows its history and the next message goes on in the same
 *  conversation, the way the Agent Host already continues the external sessions it lists (AgentService
 *  `dispatchContinueChat`).
 *
 *  The window asks through a file, so nothing new crosses the Agent Host's protocol: it writes
 *  `<userData>/dispatch-continue/<request>.json` ({ provider, id }); this watcher answers with
 *  `<request>.done.json` ({ ok, session } or { ok: false, error }) and removes the request. Answers nobody
 *  collected are removed after ten minutes.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';

export const DISPATCH_CONTINUE_DIR = 'dispatch-continue';
const STALE_MS = 10 * 60 * 1000;
const PROVIDER = /^[a-z][a-z0-9-]{1,30}$/;
const NATIVE_ID = /^[\w.-]{4,120}$/;

export interface IDispatchContinueRequest {
	readonly provider: string;
	readonly id: string;
}

export interface IDispatchContinueAnswer {
	readonly ok: boolean;
	readonly session?: string;
	readonly error?: string;
}

/** A request as written by the window, or undefined when it is not one. */
export function parseContinueRequest(text: string): IDispatchContinueRequest | undefined {
	try {
		const v = JSON.parse(text);
		return v && typeof v.provider === 'string' && PROVIDER.test(v.provider) && typeof v.id === 'string' && NATIVE_ID.test(v.id)
			? { provider: v.provider, id: v.id }
			: undefined;
	} catch {
		return undefined;
	}
}

/** Watches `<userData>/dispatch-continue` and answers each request with `continueChat`. */
export function watchDispatchContinueRequests(
	userDataPath: string,
	continueChat: (provider: string, id: string) => Promise<string>,
	logService: ILogService,
): IDisposable {
	const dir = path.join(userDataPath, DISPATCH_CONTINUE_DIR);
	const busy = new Set<string>();
	let disposed = false;

	const answer = (name: string, a: IDispatchContinueAnswer) => {
		const out = path.join(dir, name.replace(/\.json$/, '.done.json'));
		try {
			fs.writeFileSync(`${out}.tmp`, JSON.stringify(a));
			fs.renameSync(`${out}.tmp`, out);
		} catch (err) {
			logService.warn(`[DispatchContinue] could not answer ${name}`, err);
		}
	};

	const handle = async (name: string) => {
		const file = path.join(dir, name);
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
			fs.unlinkSync(file);
		} catch {
			return; // another pass took it
		}
		const req = parseContinueRequest(text);
		if (!req) {
			answer(name, { ok: false, error: 'not a request' });
			return;
		}
		try {
			const session = await continueChat(req.provider, req.id);
			logService.info(`[DispatchContinue] ${req.provider}:${req.id} is session ${session}`);
			answer(name, { ok: true, session });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			logService.warn(`[DispatchContinue] ${req.provider}:${req.id}: ${error}`);
			answer(name, { ok: false, error });
		}
	};

	const scan = () => {
		if (disposed) {
			return;
		}
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		const now = Date.now();
		for (const name of names) {
			if (name.endsWith('.done.json')) {
				try {
					if (now - fs.statSync(path.join(dir, name)).mtimeMs > STALE_MS) {
						fs.unlinkSync(path.join(dir, name));
					}
				} catch {
					// gone already
				}
				continue;
			}
			if (!name.endsWith('.json') || busy.has(name)) {
				continue;
			}
			busy.add(name);
			void handle(name).finally(() => busy.delete(name));
		}
	};

	let watcher: fs.FSWatcher | undefined;
	try {
		fs.mkdirSync(dir, { recursive: true });
		watcher = fs.watch(dir, () => scan());
		watcher.on('error', err => logService.warn('[DispatchContinue] watcher stopped', err));
	} catch (err) {
		logService.warn(`[DispatchContinue] cannot watch ${dir}`, err);
	}
	// a request written while the host was starting, and a safety net for a missed change
	scan();
	const timer = setInterval(scan, 5000);
	return toDisposable(() => {
		disposed = true;
		clearInterval(timer);
		watcher?.close();
	});
}
