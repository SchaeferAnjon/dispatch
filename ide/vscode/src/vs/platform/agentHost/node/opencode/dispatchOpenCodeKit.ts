/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's plugin kit from inside the app before OpenCode starts (patches/230-opencode-kit.patch,
 *  kanban task-lj06.13). When any plugin is loaded (Dispatch's own included), OpenCode installs its plugin kit
 *  (@opencode-ai/plugin) from npm into each config folder it reads and waits for that before it answers: about
 *  five minutes on a new Mac when npm cannot be reached. The app ships the kit (Resources/app/tools,
 *  bundle-opencode-kit.sh) and `dispatch engines opencode-kit` (kanban app/cli/opencode_kit.py) unpacks it into those
 *  folders, so OpenCode finds it installed. Before an OpenCode process starts, before the model list that loads
 *  plugins, and before the first session in a folder, this looks whether a folder still needs it (a few file
 *  checks) and only then runs the CLI; first-run setup has usually done it already.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as path from 'path';
import { FileAccess } from '../../../../base/common/network.js';
import { ILogService } from '../../../log/common/log.js';
import { dispatchCli } from '../shared/dispatchCopyReady.js';
import { needsOpenCodeKit, openCodeConfigDirs, openCodeKitPath } from './dispatchOpenCodeKitModel.js';

const TIMEOUT_MS = 120_000;

export class DispatchOpenCodeKit {

	/** One run of the CLI per folder at a time ('' = the global folders). */
	private readonly _running = new Map<string, Promise<void>>();
	private _noKitLogged = false;

	constructor(
		private readonly _env: () => NodeJS.ProcessEnv,
		private readonly _log: ILogService,
		private readonly _kitPath: () => string | undefined = () => openCodeKitPath(path.dirname(FileAccess.asFileUri('').fsPath)),
	) { }

	/** Puts the kit into OpenCode's config folders for `cwd` that still need it. Never throws. */
	prepare(cwd?: string): Promise<void> {
		const env = this._env();
		let missing: string[];
		try {
			missing = openCodeConfigDirs(env, cwd).filter(needsOpenCodeKit);
		} catch {
			return Promise.resolve();
		}
		if (!missing.length) {
			return Promise.resolve();
		}
		const kit = this._kitPath();
		const cli = dispatchCli(env);
		if (!kit || !cli) {
			if (!this._noKitLogged) {
				this._noKitLogged = true;
				this._log.info(`[OpenCode] ${missing.join(', ')} ha${missing.length === 1 ? 's' : 've'} no plugin kit and ${kit ? 'the dispatch command is not there' : 'this build ships none'}: OpenCode installs it from npm on its first start`);
			}
			return Promise.resolve();
		}
		const key = cwd ?? '';
		let running = this._running.get(key);
		if (!running) {
			const started = Date.now();
			const args = [...cli.pre, 'engines', 'opencode-kit', '--kit', kit, '--json', ...(cwd ? ['--cwd', cwd] : [])];
			running = new Promise<void>(resolve => execFile(cli.cmd, args, { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
				if (error) {
					this._log.warn(`[OpenCode] could not put the plugin kit into ${missing.join(', ')}: ${error.message}`);
				} else {
					try {
						const r = JSON.parse(stdout) as { seeded?: string[]; skipped?: Record<string, string> };
						this._log.info(`[OpenCode] plugin kit from the app in ${Date.now() - started} ms: ${r.seeded?.length ? r.seeded.join(', ') : 'nothing'}${Object.keys(r.skipped ?? {}).length ? ` (left alone: ${Object.entries(r.skipped ?? {}).map(([d, why]) => `${d}: ${why}`).join('; ')})` : ''}`);
					} catch {
						this._log.warn(`[OpenCode] dispatch engines opencode-kit said: ${stdout.slice(0, 200)}`);
					}
				}
				resolve();
			}).stdin?.end()).finally(() => this._running.delete(key));
			this._running.set(key, running);
		}
		return running;
	}
}
