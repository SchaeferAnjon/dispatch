/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which `opencode` the OpenCode harness runs (patches/225-opencode-version.patch).
 *
 *  OpenCode 1.14.x starts `opencode acp` with an internal client that sends no auth header to its own
 *  server, so every new session dies with 401; 1.18 fixed it. More than one copy is normal (the
 *  installer's ~/.opencode/bin next to bun's ~/.bun/bin), and the older one can be first on the path.
 *  So the harness looks at every copy, asks each `--version` once per file, and takes the first one that
 *  is new enough. When none is, the newest one is still returned, flagged as unsupported, so the harness
 *  can say what is installed and what is needed instead of a 401.
 *
 *  No imports from the rest of the workbench: the unit test (tests/opencode-version.test.mjs) loads this
 *  file directly.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The oldest OpenCode the harness can drive. The same number as MIN_VERSIONS["opencode"] in the kanban
 * repo's app/cli/engines.py (chatd, `dispatch engines` and the notice above the input read that one):
 * change both together.
 */
export const OPENCODE_MIN_VERSION: readonly [number, number, number] = [1, 18, 0];

export function openCodeMinVersionText(): string {
	return OPENCODE_MIN_VERSION.join('.');
}

/** '1.18.32' from `opencode --version` output (one line, sometimes with a prefix); undefined without a number. */
export function parseOpenCodeVersion(text: string | undefined): [number, number, number] | undefined {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
	return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function compare(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}

export function isSupportedOpenCodeVersion(version: readonly number[] | undefined): boolean {
	return !!version && compare(version, OPENCODE_MIN_VERSION) >= 0;
}

export interface IOpenCodeCandidate {
	readonly path: string;
	/** what `--version` printed, parsed; undefined when it printed nothing usable */
	readonly version: readonly [number, number, number] | undefined;
}

export interface IOpenCodePick {
	readonly binary: string;
	readonly version: string;
	/** the version reaches {@link OPENCODE_MIN_VERSION} */
	readonly supported: boolean;
	readonly candidates: readonly IOpenCodeCandidate[];
}

/**
 * The copy to run, from the candidates in search order: the first that is new enough; else the newest
 * (flagged unsupported); undefined when there are none.
 */
export function pickOpenCode(candidates: readonly IOpenCodeCandidate[]): IOpenCodePick | undefined {
	if (!candidates.length) {
		return undefined;
	}
	const text = (c: IOpenCodeCandidate) => c.version ? c.version.join('.') : '';
	const good = candidates.find(c => isSupportedOpenCodeVersion(c.version));
	if (good) {
		return { binary: good.path, version: text(good), supported: true, candidates };
	}
	let best = candidates[0];
	for (const c of candidates) {
		if (c.version && (!best.version || compare(c.version, best.version) > 0)) {
			best = c;
		}
	}
	return { binary: best.path, version: text(best), supported: false, candidates };
}

/** The one line that says why a copy cannot be used. */
export function openCodeTooOldMessage(pick: IOpenCodePick): string {
	const installed = pick.version ? `OpenCode ${pick.version}` : 'This OpenCode';
	return `${installed} is older than the ${openCodeMinVersionText()} that Dispatch IDE needs. Upgrade it (dispatch engines upgrade opencode) and try again.`;
}

/** Every executable `opencode` in the directories of a search path, in order, one per real file. */
export function opencodeCandidatePaths(searchPath: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	for (const dir of searchPath.split(path.delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = path.join(dir, 'opencode');
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (!fs.statSync(candidate).isFile()) {
				continue;
			}
			const real = fs.realpathSync(candidate);
			if (!seen.has(real)) {
				seen.add(real);
				found.push(candidate);
			}
		} catch {
			// not here
		}
	}
	return found;
}

const versionCache = new Map<string, Promise<[number, number, number] | undefined>>();

/**
 * `binary --version`, parsed. Asked once per file (path, mtime, size): an upgrade replaces the file and is
 * asked again; a run that failed is not remembered.
 */
export function probeOpenCodeVersion(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<[number, number, number] | undefined> {
	let key: string;
	try {
		const stat = fs.statSync(binary);
		key = `${binary}\u0000${stat.mtimeMs}\u0000${stat.size}`;
	} catch {
		return Promise.resolve(undefined);
	}
	const known = versionCache.get(key);
	if (known) {
		return known;
	}
	const asked = new Promise<[number, number, number] | undefined>(resolve => {
		execFile(binary, ['--version'], { env, timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			resolve(error ? undefined : parseOpenCodeVersion(stdout) ?? parseOpenCodeVersion(stderr));
		}).stdin?.end();
	}).then(version => {
		if (!version) {
			versionCache.delete(key);
		}
		return version;
	});
	versionCache.set(key, asked);
	return asked;
}

/** Looks at every copy on the search path and picks the one to run (see {@link pickOpenCode}). */
export async function resolveOpenCode(searchPath: string, env: NodeJS.ProcessEnv = process.env, probe: (binary: string, env: NodeJS.ProcessEnv) => Promise<[number, number, number] | undefined> = probeOpenCodeVersion): Promise<IOpenCodePick | undefined> {
	const paths = opencodeCandidatePaths(searchPath);
	const candidates = await Promise.all(paths.map(async p => ({ path: p, version: await probe(p, env) })));
	return pickOpenCode(candidates);
}
