/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which of OpenCode's config folders still need the plugin kit (patches/230-opencode-kit.patch,
 *  kanban task-lj06.13; dispatchOpenCodeKit.ts runs the CLI that puts it there). Only Node's own modules, so
 *  dispatch-ide's tests/opencode-kit.test.mjs loads it as it is.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const OPENCODE_KIT_NAME = 'opencode-plugin-kit.tgz';
/** A folder with any of these has packages already (the person's, or OpenCode's own from an earlier start). */
const OWN = ['node_modules', 'package.json', 'package-lock.json'];

/** The kit inside this app, or undefined (a build without it). */
export function openCodeKitPath(appRoot: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
	const kit = path.join(appRoot, 'tools', OPENCODE_KIT_NAME);
	return exists(kit) ? kit : undefined;
}

function gitRoot(start: string): string | undefined {
	for (let d = path.resolve(start); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, '.git'))) {
			return d;
		}
		if (path.dirname(d) === d) {
			return undefined;
		}
	}
}

/**
 * The folders OpenCode reads its config from for a session in `cwd` (OpenCode 1.18 config/paths.ts): its config
 * folder, the .opencode folders from `cwd` up to the project's git root, ~/.opencode, OPENCODE_CONFIG_DIR. The same
 * list as opencode_kit.config_dirs; only the ones that exist.
 */
export function openCodeConfigDirs(env: NodeJS.ProcessEnv, cwd?: string, home = os.homedir()): string[] {
	const out = [path.join(env['XDG_CONFIG_HOME'] || path.join(home, '.config'), 'opencode')];
	if (cwd && !env['OPENCODE_DISABLE_PROJECT_CONFIG']) {
		const stop = gitRoot(cwd);
		for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
			out.push(path.join(d, '.opencode'));
			if (d === stop || path.dirname(d) === d) {
				break;
			}
		}
	}
	out.push(path.join(home, '.opencode'));
	if (env['OPENCODE_CONFIG_DIR']) {
		out.push(env['OPENCODE_CONFIG_DIR']);
	}
	return [...new Set(out)].filter(d => {
		try {
			return fs.statSync(d).isDirectory();
		} catch {
			return false;
		}
	});
}

/** OpenCode would install its kit from npm into `dir` (it is there, can be written, and has no packages yet). */
export function needsOpenCodeKit(dir: string): boolean {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
	} catch {
		return false;
	}
	return !OWN.some(name => {
		try {
			fs.lstatSync(path.join(dir, name));
			return true;
		} catch {
			return false;
		}
	});
}
