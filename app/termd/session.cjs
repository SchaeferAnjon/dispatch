// Dispatch terminal daemon: one terminal. A shell in a pseudo-terminal, the screen kept beside it, the
// windows watching it, and what is saved to bring it back.
//
// The lifecycle follows Orca (https://github.com/stablyai/orca), src/main/daemon/session.ts and
// terminal-host.ts: the daemon owns the process, so closing the app leaves it running; a window that comes
// back attaches and first gets the screen as it is now, then the live output. When the daemon itself was
// gone (the Mac restarted), the terminal comes back from disk with its last screen and starts again in the
// same folder the first time a window opens it. Copyright (c) 2026 Lovecast Inc. MIT License, full text in
// ORCA-LICENSE.txt next to this file.
'use strict';

const os = require('os');
const { HeadlessEmulator } = require('./emulator.cjs');
const { shellLaunch } = require('./shell-init.cjs');

const SCREEN_SAVE_MS = 4000;
const SAVED_SCROLLBACK_ROWS = 5000;
const STARTUP_QUIET_MS = 400;
const STARTUP_MAX_MS = 6000;
const FLUSH_MS = 4;
const HIGH_WATER = 4 * 1024 * 1024;
/**
 * Flow control with the windows, as VS Code's terminal and Orca do it: a window says how much output its screen
 * has drawn ('ack'); while one is more than UNACKED_HIGH characters behind, the program is paused (its writes
 * wait), and it goes on once every window is back under UNACKED_LOW. A flood (cat of a huge file, a runaway log)
 * then never piles up in the window faster than it can draw, which would stall it or drop output.
 */
const UNACKED_HIGH = 512 * 1024;
const UNACKED_LOW = 64 * 1024;
const QUIET_MS = 2500;
const AWAY_MS = 3000;
const ECHO_MS = 200;
const RESIZE_MS = 800;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DRAFT_MIN_MS = 1500;
const DRAFT_QUIET_MS = 1200;
const DRAFT_MAX_MS = 25000;
/** What an agent says about its turn (app/cli/terminal_hook.py posts it): the inbox's kinds plus working. */
const TURN_STATES = ['working', 'finished', 'needs_you', 'stopped'];
/** Agents whose own hooks say when they need the person; a bell from them is not passed on again. */
const ASKS_THROUGH_HOOKS = new Set(['claude', 'opencode']);
/**
 * A long paste goes to the program in pieces, one turn of the event loop apart, as Orca does
 * (terminal-paste-limits.ts: written directly up to 64 KB, else 16 KB pieces), so a megabyte of text neither
 * holds up the daemon's other terminals nor reaches the program as one huge write.
 */
const PASTE_DIRECT_MAX = 64 * 1024;
const PASTE_CHUNK = 16 * 1024;

/** Text pasted as one block: bracketed when the program asked for it, so a newline does not send it. */
function pasteBytes(text, bracketed) {
	const body = String(text).replace(/\r?\n/g, '\r');
	return bracketed ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : body;
}

const RESTARTED_NOTE = '\r\n\x1b[2mThis terminal had stopped (the Mac restarted), so it started again in the same folder. What it showed before is above.\x1b[0m\r\n';

/** A bell the program rang to call the person (a BEL that does not end an OSC title or link). */
function rings(data) {
	return data.includes('\x07') && data.replace(OSC_RE, '').includes('\x07');
}

/** The environment a shell in Dispatch's terminal starts with: the daemon's own, minus what belongs to the app. */
function shellEnv(base, id) {
	const env = {};
	for (const [k, v] of Object.entries(base || {})) {
		if (typeof v !== 'string') {
			continue;
		}
		if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('ELECTRON_') || k.startsWith('VSCODE_') || k === 'DISPATCH_TERMD_TOKEN') {
			continue;
		}
		env[k] = v;
	}
	env.TERM = 'xterm-256color';
	env.COLORTERM = 'truecolor';
	env.TERM_PROGRAM = 'Dispatch';
	env.DISPATCH_TERMINAL_SESSION = id;
	if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
		// without it Chinese and emoji arrive as question marks
		env.LANG = 'en_US.UTF-8';
	}
	return env;
}

/**
 * The shell started with `command` as its job and then the person's own shell in its place (`-c "cmd; exec
 * shell -l"`), for the shells that read -c the same way; undefined for others (the command is then typed).
 */
function startsDirectly(shell, command) {
	const l = shellLaunch(shell, {}, undefined, command);
	return l && { file: l.file, args: l.args };
}

/** The shell to start and its arguments: the person's login shell, as a login shell. */
function shellCommand(env) {
	let shell = env.SHELL;
	if (!shell) {
		try {
			shell = os.userInfo().shell || '';
		} catch {
			shell = '';
		}
	}
	shell = shell || '/bin/zsh';
	const name = shell.split('/').pop();
	return { file: shell, args: ['zsh', 'bash', 'fish', 'sh', 'ksh', 'tcsh'].includes(name) ? ['-l'] : [] };
}

class Session {
	/**
	 * @param {object} o
	 * @param {string} o.id
	 * @param {object} o.meta   kept with the terminal: cwd, title, agent, command, restoreCommand, createdAt
	 * @param {object} o.deps   { pty, xterm, store, env, onExit(session), onChange(session) }
	 */
	constructor({ id, meta, cols, rows, deps }) {
		this.id = id;
		this.meta = meta;
		this.deps = deps;
		this.cols = cols;
		this.rows = rows;
		this.emulator = new HeadlessEmulator(deps.xterm, { cols, rows });
		this.proc = undefined;
		this.state = 'new'; // new | running | restored | exited
		this.exitCode = undefined;
		this.clients = new Set();
		this.out = '';
		this.flushTimer = undefined;
		this.saveTimer = undefined;
		this.dirty = false;
		this.paused = false;
		/** { state, at }: the agent's own word on its turn (setTurn), undefined until it says something. */
		this.turn = undefined;
		/** Pieces of a long write still to go, in order (_writePty). */
		this.pending = [];
	}

	/** Brought back from disk: the last screen, no process until a window opens it. */
	static restored({ id, meta, screen, deps }) {
		const cols = Math.max(2, meta.cols || 80);
		const rows = Math.max(1, meta.rows || 24);
		const s = new Session({ id, meta, cols, rows, deps });
		if (screen) {
			s.emulator.writeSync(screen) || s.emulator.write(screen);
		}
		s.state = 'restored';
		return s;
	}

	info() {
		const snap = this.emulator;
		return {
			id: this.id,
			state: this.state,
			pid: this.proc ? this.proc.pid : undefined,
			cwd: snap.cwd || this.meta.cwd,
			title: this.meta.title,
			agent: this.meta.agent,
			agentSession: this.meta.agentSession,
			createdAt: this.meta.createdAt,
			cols: this.cols,
			rows: this.rows,
			exitCode: this.exitCode,
			busy: !!this.busy,
			bell: !!this.bell,
			turn: this.turn ? this.turn.state : undefined,
			turnAt: this.turn ? this.turn.at : undefined,
			seenAt: this.meta.seenAt,
			// a pane of another terminal's session (split), and a session's panes (app/termd keeps them, the window draws them)
			parent: this.meta.parent,
			layout: this.meta.layout,
		};
	}

	/**
	 * Starts the shell. `command` is typed once the shell is up; `note` is written first; `draft` is pasted into
	 * the program `command` starts once that has drawn its screen and gone quiet, and not sent (the person reads
	 * it and presses Enter).
	 */
	spawn({ command, note, draft } = {}) {
		const base = shellEnv(this.deps.env, this.id);
		const shell = shellCommand(base);
		// an agent starts as the terminal's own program (Orca's launch recipes): its screen is the first thing shown,
		// no long command typed at a prompt; when it ends, the person's shell takes over in the same terminal.
		// Either way the shell reads the person's startup files and then gets Dispatch's variables back (shell-init.cjs)
		const direct = command ? shellLaunch(shell, base, this.deps.shellDir, command) : undefined;
		const { file, args, env } = direct ?? shellLaunch(shell, base, this.deps.shellDir);
		if (note) {
			this._output(note);
		}
		const proc = this.deps.pty.spawn(file, args, {
			name: 'xterm-256color',
			cols: this.cols,
			rows: this.rows,
			cwd: this.meta.cwd || os.homedir(),
			env,
		});
		this.proc = proc;
		this.state = 'running';
		this.exitCode = undefined;
		this.turn = undefined;
		this.meta.pid = proc.pid;
		this._saveMeta();
		let firstOutput = 0;
		let lastOutput = 0;
		const started = Date.now();
		proc.onData(data => {
			lastOutput = Date.now();
			firstOutput = firstOutput || lastOutput;
			this._output(data);
		});
		proc.onExit(({ exitCode }) => {
			if (this.proc !== proc) {
				return;
			}
			this.proc = undefined;
			this.state = 'exited';
			this.exitCode = exitCode;
			this.turn = undefined;
			this._flush();
			this.deps.onExit(this);
		});
		if (command && direct) {
			if (draft) {
				this._pasteWhenQuiet(proc, draft, () => lastOutput);
			}
		} else if (command) {
			// typed when the shell has drawn its prompt and gone quiet, so a slow startup file does not eat it
			const timer = setInterval(() => {
				const now = Date.now();
				if (this.proc !== proc) {
					clearInterval(timer);
					return;
				}
				if ((firstOutput && now - lastOutput >= STARTUP_QUIET_MS) || now - started >= STARTUP_MAX_MS) {
					clearInterval(timer);
					proc.write(command + '\r');
					if (draft) {
						this._pasteWhenQuiet(proc, draft, () => lastOutput);
					}
				}
			}, 50);
		}
	}

	/** Pastes `text` into the program once it has started and stopped drawing (an agent's prompt is up). */
	_pasteWhenQuiet(proc, text, lastOutput) {
		const typedAt = Date.now();
		const timer = setInterval(() => {
			const now = Date.now();
			if (this.proc !== proc) {
				clearInterval(timer);
				return;
			}
			const drewSince = lastOutput() > typedAt;
			if ((drewSince && now - typedAt >= DRAFT_MIN_MS && now - lastOutput() >= DRAFT_QUIET_MS) || now - typedAt >= DRAFT_MAX_MS) {
				clearInterval(timer);
				proc.write(pasteBytes(text, this.emulator.terminal.modes.bracketedPasteMode));
			}
		}, 100);
	}

	/** A window opened a terminal brought back from disk: start it again where it was. */
	restart() {
		if (this.state !== 'restored') {
			return;
		}
		this.spawn({ command: this.meta.restoreCommand || undefined, note: RESTARTED_NOTE });
	}

	_output(data) {
		this.emulator.write(data);
		this._markDirty();
		this._activity(data);
		if (!this.clients.size) {
			return;
		}
		this.out += data;
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
		}
	}

	_flush() {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (!this.out) {
			return;
		}
		const msg = JSON.stringify({ type: 'data', session: this.id, data: this.out });
		const sent = this.out.length;
		this.out = '';
		let behind = false;
		for (const c of this.clients) {
			c.send(msg);
			if (this.unacked && this.unacked.has(c)) {
				this.unacked.set(c, this.unacked.get(c) + sent);
			}
			behind = behind || c.buffered > HIGH_WATER || (this.unacked?.get(c) ?? 0) > UNACKED_HIGH;
		}
		// a window that cannot keep up slows the program down instead of the daemon filling memory
		if (behind && this.proc && !this.paused) {
			this.paused = true;
			this.proc.pause();
			const wait = setInterval(() => {
				if (!this._behind()) {
					clearInterval(wait);
					this.paused = false;
					this.proc?.resume();
				}
			}, 30);
		}
	}

	_behind() {
		return [...this.clients].some(c => c.buffered > HIGH_WATER / 4 || (this.unacked?.get(c) ?? 0) > UNACKED_LOW);
	}

	/** A window drew `chars` characters of output. */
	ack(client, chars) {
		if (this.unacked && this.unacked.has(client)) {
			this.unacked.set(client, Math.max(0, this.unacked.get(client) - (Number(chars) || 0)));
		}
	}

	_markDirty() {
		this.dirty = true;
		if (!this.saveTimer) {
			this.saveTimer = setTimeout(() => {
				this.saveTimer = undefined;
				this.saveScreen();
			}, SCREEN_SAVE_MS);
		}
	}

	saveScreen() {
		if (!this.dirty) {
			return;
		}
		this.dirty = false;
		try {
			const snap = this.emulator.snapshot(SAVED_SCROLLBACK_ROWS);
			this.deps.store.saveScreen(this.id, snap.ansi);
			if (snap.cwd && snap.cwd !== this.meta.lastCwd) {
				this.meta.lastCwd = snap.cwd;
				this._saveMeta();
			}
		} catch (e) {
			process.stderr.write(`termd: could not save ${this.id}: ${e && e.message}\n`);
		}
	}

	_saveMeta() {
		try {
			this.deps.store.saveMeta(this.id, { ...this.meta, cols: this.cols, rows: this.rows });
		} catch (e) {
			process.stderr.write(`termd: could not save ${this.id} meta: ${e && e.message}\n`);
		}
		this.deps.onChange(this);
	}

	setMeta(patch) {
		for (const [k, v] of Object.entries(patch || {})) {
			if (['title', 'agent', 'restoreCommand', 'project', 'agentSession', 'icon', 'seenAt', 'layout'].includes(k)) {
				this.meta[k] = v;
			}
		}
		this._saveMeta();
	}

	write(data) {
		if (this.proc && typeof data === 'string' && data.length) {
			this.lastWriteAt = Date.now();
			let changed = false;
			if (this.bell) {
				// the person answered: it no longer waits for them
				this.bell = false;
				changed = true;
			}
			if (this.turn && this.turn.state === 'needs_you') {
				// answering a permission question lets the agent go on with the same turn
				this.turn = { state: 'working', at: Date.now() };
				changed = true;
			}
			if (changed) {
				this.deps.onChange(this);
			}
			this._writePty(data);
		}
	}

	/** Writes to the program; a long text in pieces that keep their order with what is typed meanwhile. */
	_writePty(data) {
		if (!this.pending.length && data.length <= PASTE_DIRECT_MAX) {
			this.proc.write(data);
			return;
		}
		for (let i = 0; i < data.length; i += PASTE_CHUNK) {
			let end = Math.min(data.length, i + PASTE_CHUNK);
			// never split a surrogate pair (an emoji) between two pieces
			if (end < data.length && /[\ud800-\udbff]/.test(data[end - 1])) {
				end -= 1;
			}
			this.pending.push(data.slice(i, end));
			i = end - PASTE_CHUNK;
		}
		if (this.pending.length && !this.pumping) {
			this.pumping = true;
			const pump = () => {
				const piece = this.pending.shift();
				if (piece === undefined || !this.proc) {
					this.pending = [];
					this.pumping = false;
					return;
				}
				this.proc.write(piece);
				setImmediate(pump);
			};
			pump();
		}
	}

	/** The agent's own word on its turn (its hooks, through terminal_hook.py). Returns false for an unknown state. */
	setTurn(state) {
		if (!TURN_STATES.includes(state)) {
			return false;
		}
		this.turn = { state, at: Date.now() };
		if (state !== 'needs_you') {
			this.bell = false;
		}
		this.deps.onChange(this);
		return true;
	}

	/**
	 * Busy while the program keeps drawing (an agent's spinner, a build's output), quiet after QUIET_MS; the echo of
	 * the person's own typing does not count. A bell (BEL outside an OSC title) means it waits for the person.
	 */
	_activity(data) {
		const now = Date.now();
		let changed = false;
		// the echo of typing and the redraw after a resize are not work
		if (now - (this.lastWriteAt || 0) > ECHO_MS && now - (this.lastResizeAt || 0) > RESIZE_MS && !this.busy) {
			this.busy = true;
			changed = true;
		}
		if (this.busy) {
			clearTimeout(this.quietTimer);
			this.quietTimer = setTimeout(() => {
				this.busy = false;
				this.deps.onChange(this);
			}, QUIET_MS);
		}
		if (!this.bell && rings(data)) {
			this.bell = true;
			changed = true;
			const agent = this.meta.agent && this.meta.agent.id;
			if (agent && !ASKS_THROUGH_HOOKS.has(agent) && this.deps.onAgentBell) {
				// an agent without hooks rang for the person: the inbox hears it as "needs you"
				this.deps.onAgentBell(this, agent);
			}
		}
		if (changed) {
			this.deps.onChange(this);
		}
	}

	resize(cols, rows) {
		cols = Math.max(2, Math.min(1000, Math.floor(cols) || 0));
		rows = Math.max(1, Math.min(500, Math.floor(rows) || 0));
		if (cols === this.cols && rows === this.rows) {
			return;
		}
		this.cols = cols;
		this.rows = rows;
		this.lastResizeAt = Date.now();
		this.emulator.resize(cols, rows);
		if (this.proc) {
			try {
				this.proc.resize(cols, rows);
			} catch { /* the process just ended */ }
		}
	}

	snapshot() {
		this._flush();
		return this.emulator.snapshot();
	}

	clear() {
		this.emulator.clear();
		this._markDirty();
	}

	/** Adds a watching window. Returns { from, to } when no window watched for a while (Dispatch was closed). */
	attach(client, flow = false) {
		if (flow) {
			// this window acknowledges what it drew (flow control); older ones are only watched by their socket
			(this.unacked ??= new Map()).set(client, 0);
		}
		const away = this.awaySince && this.state === 'running' && Date.now() - this.awaySince > AWAY_MS
			? { from: this.awaySince, to: Date.now() } : undefined;
		this.awaySince = undefined;
		this.clients.add(client);
		return away;
	}

	detach(client) {
		this.clients.delete(client);
		this.unacked?.delete(client);
		if (!this.clients.size) {
			this.awaySince = Date.now();
		}
	}

	/** Ends the process (the shell and what runs in it get a hangup, as when a terminal window closes). */
	kill() {
		const proc = this.proc;
		this.proc = undefined;
		if (proc) {
			try {
				proc.kill('SIGHUP');
			} catch { /* already gone */ }
		}
	}

	dispose() {
		clearTimeout(this.quietTimer);
		clearTimeout(this.flushTimer);
		clearTimeout(this.saveTimer);
		this.emulator.dispose();
	}
}

module.exports = { Session, shellEnv, shellCommand, startsDirectly, pasteBytes, rings, RESTARTED_NOTE };
