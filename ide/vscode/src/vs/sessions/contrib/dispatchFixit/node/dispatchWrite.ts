/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the agent host asks the default agent for a branch name through the dispatch CLI
 *  (`dispatch write branch --from <request>`, kanban app/cli/fixit.py) when there is no Copilot to
 *  ask, and for a pull request's title and description (`dispatch write pr`, Create PR's form). The CLI
 *  is the one the person installed, else the one inside the app. Without a GitHub sign-in in the window,
 *  Create PR uses the GitHub login the person already has in the `gh` command (`gh auth token`).
 *--------------------------------------------------------------------------------------------*/

import { execFile, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { FileAccess } from '../../../../base/common/network.js';

const BRANCH_TIMEOUT_MS = 15_000;
const PR_TIMEOUT_MS = 150_000;
const GH_TOKEN_TTL_MS = 10 * 60_000;

function cliTarget(): { cmd: string; pre: string[] } {
	let bundled = '';
	try {
		bundled = join(FileAccess.asFileUri('').fsPath, '..', 'dispatch-cli', 'dispatch', 'cli', 'dispatch.py');
	} catch {
		// no app root in this process: the installed CLI only
	}
	const local = join(homedir(), '.local', 'bin', 'dispatch');
	const target = process.env.DISPATCH_BIN || process.env.DISPATCH_CLI || (existsSync(local) ? local : bundled && existsSync(bundled) ? bundled : 'dispatch');
	return target.endsWith('.py') ? { cmd: process.env.DISPATCH_PYTHON || 'python3', pre: [target] } : { cmd: target, pre: [] };
}

function searchPath(): string {
	return [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(delimiter);
}

export interface IDispatchPullRequestText {
	readonly title: string;
	readonly description: string;
	/** The agent that wrote it ("Codex"), or "" when no agent answered and the text is built from the commits. */
	readonly by: string;
}

/** A pull request's title and description in the project's style, written by the default agent from the commits and
 *  the work not committed yet; undefined when there is nothing to describe or the CLI did not answer. */
export function dispatchPullRequestText(folder: string, base: string, signal?: AbortSignal): Promise<IDispatchPullRequestText | undefined> {
	return new Promise(resolve => {
		const { cmd, pre } = cliTarget();
		const env = { ...process.env, PATH: searchPath() };
		const args = [...pre, 'write', 'pr', '--folder', folder, ...(base ? ['--base', base] : []), '--json'];
		execFile(cmd, args, { env, timeout: PR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', signal }, (err, stdout) => {
			if (err) {
				resolve(undefined);
				return;
			}
			try {
				const ans = JSON.parse(stdout.slice(stdout.indexOf('{')));
				const title = typeof ans?.title === 'string' ? ans.title.trim() : '';
				resolve(ans?.ok && title ? { title, description: typeof ans.body === 'string' ? ans.body : '', by: ans.ai && typeof ans.by_label === 'string' ? ans.by_label : '' } : undefined);
			} catch {
				resolve(undefined);
			}
		});
	});
}

let ghToken: { readonly at: number; readonly token: string | undefined } | undefined;

/** The token of the GitHub login in the person's `gh` command, for the API calls Create PR makes; cached for a while. */
export function dispatchGitHubToken(): string | undefined {
	if (ghToken && Date.now() - ghToken.at < GH_TOKEN_TTL_MS) {
		return ghToken.token;
	}
	let token: string | undefined;
	try {
		const out = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { env: { ...process.env, PATH: searchPath() }, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		token = /^[A-Za-z0-9_]{20,255}$/.test(out) ? out : undefined;
	} catch {
		token = undefined;
	}
	ghToken = { at: Date.now(), token };
	return token;
}

/** A short English slug for the work the request describes, or undefined when no agent answered in time. */
export function dispatchBranchNameHint(request: string, signal?: AbortSignal): Promise<string | undefined> {
	return new Promise(resolve => {
		const { cmd, pre } = cliTarget();
		const env = { ...process.env, PATH: [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(delimiter) };
		execFile(cmd, [...pre, 'write', 'branch', '--from', request.slice(0, 4000), '--json'], { env, timeout: BRANCH_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8', signal }, (err, stdout) => {
			if (err) {
				resolve(undefined);
				return;
			}
			try {
				const ans = JSON.parse(stdout.slice(stdout.indexOf('{')));
				resolve(ans?.ai && typeof ans.name === 'string' ? ans.name : undefined);
			} catch {
				resolve(undefined);
			}
		});
	});
}
