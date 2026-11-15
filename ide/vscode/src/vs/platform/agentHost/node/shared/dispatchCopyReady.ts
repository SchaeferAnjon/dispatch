/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a copy for parallel work gets ready on its own (patches/440-projects.patch,
 *  kanban task-am1t). Right after the agent host makes a session's worktree, `dispatch worktree prepare`
 *  (kanban app/cli/copy_ready.py) copies the files git ignores that the project needs (.env, the person's
 *  local agent settings), links node_modules / .venv to the main checkout's when the lockfile matches and
 *  installs the rest in the background. The person sees none of it; a failure only goes to the log.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

const TIMEOUT_MS = 30_000;

/** The dispatch command, found the way dispatch-bridge finds it (kanban app/ide-ext/src/core/cliOutput.ts cliTarget). */
export function dispatchCli(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists: (p: string) => boolean = existsSync): { cmd: string; pre: string[] } | undefined {
	const python = env['DISPATCH_PYTHON'] || 'python3';
	const viaPython = (p: string) => /\.py$/i.test(p) ? { cmd: python, pre: [p] } : { cmd: p, pre: [] };
	const bin = env['DISPATCH_BIN'] || '';
	if (bin && exists(bin)) {
		return viaPython(bin);
	}
	const cli = env['DISPATCH_CLI'] || '';
	if (cli && exists(cli)) {
		return { cmd: python, pre: [cli] };
	}
	for (const p of [join(home, '.local', 'bin', 'dispatch'), '/opt/homebrew/bin/dispatch', '/usr/local/bin/dispatch']) {
		if (exists(p)) {
			return { cmd: p, pre: [] };
		}
	}
	let bundled = '';
	try {
		bundled = join(URI.joinPath(FileAccess.asFileUri(''), '..').fsPath, 'dispatch-cli', 'dispatch', 'cli', 'dispatch.py');
	} catch {
		// no app root (tests)
	}
	return bundled && exists(bundled) ? { cmd: python, pre: [bundled] } : undefined;
}

/** Gets the copy ready. Never throws: a copy that is not ready is still a copy the agent can work in. */
export function prepareDispatchCopy(main: string, copy: string, log: (message: string) => void): Promise<void> {
	const cli = dispatchCli();
	if (!cli) {
		log('[DispatchCopyReady] no dispatch command: the copy is left as git made it');
		return Promise.resolve();
	}
	const home = homedir();
	const path = [process.env['PATH'] || '/usr/bin:/bin', join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].join(':');
	return new Promise(resolve => {
		execFile(cli.cmd, [...cli.pre, 'worktree', 'prepare', copy, '--from', main, '--json'],
			{ cwd: copy, timeout: TIMEOUT_MS, env: { ...process.env, PATH: path, DISPATCH_CALLER: 'agent-host' } },
			(error, stdout, stderr) => {
				if (error) {
					log(`[DispatchCopyReady] ${copy}: ${error.message} ${String(stderr).trim().slice(-300)}`);
				} else {
					log(`[DispatchCopyReady] ${copy}: ${String(stdout).trim().split('\n').pop()?.slice(0, 400) ?? ''}`);
				}
				resolve();
			});
	});
}
