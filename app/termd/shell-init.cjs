// Dispatch terminal daemon: Dispatch's own variables survive the person's shell startup files.
//
// A terminal in Dispatch starts the person's login shell, and that shell reads their startup files (~/.zshrc,
// ~/.bash_profile, config.fish …). Those may set the same variables Dispatch gave the terminal: a ~/.zshrc with
// `export BEADS_DIR=~/tasks/.beads` put a test instance's terminal back on the person's real task board, and what an
// agent in it noted went there (10-06). So every shell Dispatch starts reads the person's files first and then puts
// Dispatch's variables back, the way VS Code's shell integration wraps the same startup files:
//   zsh   ZDOTDIR points at a folder of Dispatch's whose .zshenv / .zprofile / .zshrc / .zlogin each read the
//         person's own file of that name and then set the variables again; an interactive shell gets the person's
//         ZDOTDIR back at the end, so their plugins and history keep their places;
//   bash  --init-file reads what a login bash reads (/etc/profile, then ~/.bash_profile, ~/.bash_login or ~/.profile)
//         and then sets them;
//   fish  --init-command, which fish runs after its config files;
//   sh, ksh, dash  ENV, the file an interactive one reads last (the person's own ENV first).
// A command started as the terminal's program (`shell -l -c "cmd; exec shell -l"`) gets them before it runs.
// Which variables: BEADS_DIR (the task board), every DISPATCH_* the terminal got, and the names listed in
// DISPATCH_TERMINAL_KEEP (a test instance lists its own CODEX_HOME, XDG_* … there). Their values travel in
// DISPATCH_PIN_<name>, the names in DISPATCH_TERMINAL_PIN; nobody's startup file sets those.
'use strict';

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// what this file sets itself, and what would make no sense to hold on to
const NOT_PINNED = new Set(['DISPATCH_TERMINAL_PIN', 'DISPATCH_TERMINAL_KEEP', 'DISPATCH_USER_ZDOTDIR', 'DISPATCH_USER_ENV', 'DISPATCH_TERMD_TOKEN']);

/** The names of the variables in `env` that the shell's startup files must not change. */
function pinnedNames(env) {
	const keep = String(env.DISPATCH_TERMINAL_KEEP || '').split(/[\s:,]+/).filter(Boolean);
	const out = [];
	for (const k of Object.keys(env)) {
		if (typeof env[k] !== 'string' || !NAME_RE.test(k) || NOT_PINNED.has(k) || k.startsWith('DISPATCH_PIN_')) {
			continue;
		}
		if (k === 'BEADS_DIR' || k.startsWith('DISPATCH_') || keep.includes(k)) {
			out.push(k);
		}
	}
	return out.sort();
}

/** `env` with the copies the startup wrappers put back: DISPATCH_PIN_<name> and the list in DISPATCH_TERMINAL_PIN. */
function pinEnv(env) {
	const out = { ...env };
	for (const k of Object.keys(out)) {
		if (k.startsWith('DISPATCH_PIN_')) {
			delete out[k];
		}
	}
	const names = pinnedNames(out);
	for (const k of names) {
		out[`DISPATCH_PIN_${k}`] = out[k];
	}
	out.DISPATCH_TERMINAL_PIN = names.join(' ');
	return out;
}

function sq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const PIN_SH = `# Dispatch: its variables back after the person's startup files (made by Dispatch's terminal, app/termd/shell-init.cjs)
for __dispatch_k in $DISPATCH_TERMINAL_PIN; do
	eval "__dispatch_v=\\\${DISPATCH_PIN_$__dispatch_k}"
	export "$__dispatch_k=$__dispatch_v"
done
unset __dispatch_k __dispatch_v
`;

const PIN_ZSH = `# Dispatch: its variables back after the person's startup files (made by Dispatch's terminal, app/termd/shell-init.cjs)
for __dispatch_k in \${=DISPATCH_TERMINAL_PIN}; do
	__dispatch_s="DISPATCH_PIN_$__dispatch_k"
	export "$__dispatch_k=\${(P)__dispatch_s}"
done
unset __dispatch_k __dispatch_s
`;

const PIN_FISH = `# Dispatch: its variables back after the person's startup files (made by Dispatch's terminal, app/termd/shell-init.cjs)
for __dispatch_k in (string split -n ' ' -- "$DISPATCH_TERMINAL_PIN")
	set -l __dispatch_s DISPATCH_PIN_$__dispatch_k
	set -gx $__dispatch_k "$$__dispatch_s"
end
`;

/** One of the zsh wrappers: the person's own file of that name, read from their ZDOTDIR, then the variables again. */
function zshFile(name, dir) {
	const lines = [
		`# Dispatch's terminal: reads your own ${name}, then sets Dispatch's variables again (app/termd/shell-init.cjs)`,
		'__dispatch_zdotdir="$ZDOTDIR"',
		'ZDOTDIR="${DISPATCH_USER_ZDOTDIR:-$HOME}"',
	];
	if (name === '.zshrc') {
		// /etc/zshrc set HISTFILE from ZDOTDIR while it was Dispatch's folder: history stays in the person's own place
		lines.push('[[ "$HISTFILE" == "$__dispatch_zdotdir/.zsh_history" ]] && HISTFILE="$ZDOTDIR/.zsh_history"');
	}
	lines.push(
		`[[ -r "$ZDOTDIR/${name}" ]] && builtin source "$ZDOTDIR/${name}"`,
		// a .zshenv may move ZDOTDIR: the person's next files are read from there
		'export DISPATCH_USER_ZDOTDIR="$ZDOTDIR"',
		'ZDOTDIR="$__dispatch_zdotdir"',
		'unset __dispatch_zdotdir',
		`builtin source ${sq(path.join(dir, 'pin.zsh'))}`,
	);
	// the last file an interactive shell reads hands ZDOTDIR back (a command's shell keeps it for the shell after it)
	if (name === '.zshrc') {
		lines.push('if [[ -o interactive && ! -o login ]]; then ZDOTDIR="$DISPATCH_USER_ZDOTDIR"; unset DISPATCH_USER_ZDOTDIR; fi');
	} else if (name === '.zlogin') {
		lines.push('if [[ -o interactive ]]; then ZDOTDIR="$DISPATCH_USER_ZDOTDIR"; unset DISPATCH_USER_ZDOTDIR; fi');
	}
	return lines.join('\n') + '\n';
}

function bashProfile(dir) {
	return [
		`# Dispatch's terminal: what a login bash reads, then Dispatch's variables again (app/termd/shell-init.cjs)`,
		'[ -r /etc/profile ] && . /etc/profile',
		'if [ -r ~/.bash_profile ]; then . ~/.bash_profile',
		'elif [ -r ~/.bash_login ]; then . ~/.bash_login',
		'elif [ -r ~/.profile ]; then . ~/.profile',
		'fi',
		`. ${sq(path.join(dir, 'pin.sh'))}`,
	].join('\n') + '\n';
}

function shEnvFile(dir) {
	return [
		`# Dispatch's terminal: an interactive sh reads this (ENV); your own ENV file first, then Dispatch's variables (app/termd/shell-init.cjs)`,
		'if [ -n "$DISPATCH_USER_ENV" ] && [ -r "$DISPATCH_USER_ENV" ]; then . "$DISPATCH_USER_ENV"; fi',
		`. ${sq(path.join(dir, 'pin.sh'))}`,
	].join('\n') + '\n';
}

/** Writes the startup wrappers into `dir` (the daemon's state folder/shell); returns `dir`. */
function writeShellInit(dir) {
	const files = {
		'pin.sh': PIN_SH,
		'pin.zsh': PIN_ZSH,
		'pin.fish': PIN_FISH,
		'bash-profile': bashProfile(dir),
		'sh-env': shEnvFile(dir),
	};
	for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
		files[path.join('zsh', name)] = zshFile(name, dir);
	}
	fs.mkdirSync(path.join(dir, 'zsh'), { recursive: true, mode: 0o700 });
	for (const [name, text] of Object.entries(files)) {
		const p = path.join(dir, name);
		let same = false;
		try {
			same = fs.readFileSync(p, 'utf8') === text;
		} catch { /* not there yet */ }
		if (!same) {
			const tmp = `${p}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, text, { mode: 0o600 });
			fs.renameSync(tmp, p);
		}
	}
	return dir;
}

/**
 * How to start `shell` ({ file, args } from shellCommand) so Dispatch's variables in `env` survive its startup
 * files: { file, args, env }. With `command`, the shell runs it first and then becomes the person's shell
 * (undefined for a shell that does not read -c that way: the command is then typed). Without `dir` (no wrappers
 * written) only the -c form is built, as before.
 */
function shellLaunch(shell, env, dir, command) {
	const name = shell.file.split('/').pop();
	const self = sq(shell.file);
	const pinned = dir ? pinEnv(env) : { ...env };
	let args = shell.args;
	let again = `exec ${self} -l`;
	let first = '';
	if (dir && name === 'zsh') {
		pinned.DISPATCH_USER_ZDOTDIR = env.ZDOTDIR || env.HOME || '';
		pinned.ZDOTDIR = path.join(dir, 'zsh');
	} else if (dir && name === 'bash') {
		const rc = path.join(dir, 'bash-profile');
		args = ['--init-file', rc];
		again = `exec ${self} --init-file ${sq(rc)}`;
		first = `. ${sq(path.join(dir, 'pin.sh'))}; `;
	} else if (dir && name === 'fish') {
		const init = `source ${sq(path.join(dir, 'pin.fish'))}`;
		args = [...shell.args, '-C', init];
		again = `exec ${self} -l -C ${sq(init)}`;
	} else if (dir && ['sh', 'ksh', 'dash'].includes(name)) {
		if (env.ENV) {
			pinned.DISPATCH_USER_ENV = env.ENV;
		}
		pinned.ENV = path.join(dir, 'sh-env');
		first = `. ${sq(path.join(dir, 'pin.sh'))}; `;
	}
	if (!command) {
		return { file: shell.file, args, env: pinned };
	}
	if (!['zsh', 'bash', 'sh', 'ksh', 'dash', 'fish'].includes(name)) {
		return undefined;
	}
	const login = name === 'bash' || name === 'fish' ? shell.args : args;
	const pre = name === 'fish' ? args.slice(shell.args.length) : [];
	return { file: shell.file, args: [...login, ...pre, '-c', `${first}${command}; ${again}`], env: pinned };
}

module.exports = { pinnedNames, pinEnv, writeShellInit, shellLaunch };
