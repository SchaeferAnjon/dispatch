// Dispatch terminal daemon ("termd"): the process that owns the Agents window's terminals.
//
//   ELECTRON_RUN_AS_NODE=1 "<Dispatch IDE binary>" termd.cjs --state <dir> --app-root <Resources/app>
//
// Started by `dispatch terminal daemon start` (app/cli/terminal_daemon.py) in its own process group, so
// quitting Dispatch leaves the terminals and whatever runs in them going; the next Dispatch attaches to them
// again. It runs on the Electron that comes with Dispatch IDE and uses that app's node-pty and headless
// xterm, so a new Mac needs nothing installed.
//
// The design follows Orca's terminal daemon (https://github.com/stablyai/orca, src/main/daemon:
// daemon-server.ts, terminal-host.ts, types.ts): one long-lived process, sessions keyed by id, attach =
// snapshot then live output, cold restore from disk when the daemon itself was gone.
// Copyright (c) 2026 Lovecast Inc. MIT License, full text in ORCA-LICENSE.txt next to this file.
// Dispatch's differences: the window connects over a local WebSocket with a token instead of a Unix socket
// from the main process, and there is no Windows, SSH or mobile side.
//
// Files in <state>: daemon.json { pid, port, token, version, startedAt } (0600, written once listening),
// termd.lock (this process's pid), termd.log, sessions/<id>/ (store.cjs).
//
// Messages are JSON text frames. A request carries `id` and `type`; the answer has the same `id` and `ok`.
// Events (no id): { type: 'data', session, data }, { type: 'exit', session, code },
// { type: 'changed', session } (title or state changed), { type: 'removed', session }.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { acceptUpgrade } = require('./ws.cjs');
const { Session } = require('./session.cjs');
const { SessionStore, ID_RE } = require('./store.cjs');
const { writeShellInit } = require('./shell-init.cjs');

const VERSION = 1;
const IDLE_EXIT_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/tiff': 'tiff', 'image/bmp': 'bmp' };

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** node-pty and the headless xterm of the Dispatch IDE this daemon was started from. */
function loadModules(appRoot) {
	const tryRequire = (...names) => {
		let last;
		for (const n of names) {
			try {
				return require(n);
			} catch (e) {
				last = e;
			}
		}
		throw last;
	};
	const nm = p => [path.join(appRoot, 'node_modules.asar', p), path.join(appRoot, 'node_modules', p), p];
	const pty = tryRequire(...nm('node-pty'));
	const { Terminal } = tryRequire(...nm('@xterm/headless'));
	const { SerializeAddon } = tryRequire(...nm('@xterm/addon-serialize'));
	let Unicode11Addon;
	try {
		({ Unicode11Addon } = tryRequire(...nm('@xterm/addon-unicode11')));
	} catch { /* the headless build works without it; widths may differ for emoji */ }
	return { pty, xterm: { Terminal, SerializeAddon, Unicode11Addon } };
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

/** One daemon per state folder: the lock holds the pid of the one running. */
function takeLock(stateDir) {
	const lock = path.join(stateDir, 'termd.lock');
	for (let i = 0; i < 2; i++) {
		try {
			const fd = fs.openSync(lock, 'wx', 0o600);
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return lock;
		} catch (e) {
			if (e.code !== 'EEXIST') {
				throw e;
			}
			const other = parseInt(fs.readFileSync(lock, 'utf8'), 10);
			if (other && other !== process.pid && pidAlive(other)) {
				return undefined;
			}
			fs.rmSync(lock, { force: true });
		}
	}
	return undefined;
}

class Daemon {
	constructor({ stateDir, modules, env, hook }) {
		this.stateDir = stateDir;
		/** { python, script }: app/cli/terminal_hook.py, run when an agent without hooks rings the bell. */
		this.hook = hook;
		this.modules = modules;
		this.env = env;
		this.token = crypto.randomBytes(24).toString('hex');
		this.store = new SessionStore(stateDir);
		this.sessions = new Map();
		this.clients = new Set();
		this.stopping = false;
		this.idleTimer = undefined;
		this.deps = {
			pty: modules.pty,
			xterm: modules.xterm,
			store: this.store,
			env,
			shellDir: this._shellInit(),
			onExit: s => this._exited(s),
			onChange: s => this._broadcast({ type: 'changed', session: s.id, info: s.info() }),
			onAgentBell: (s, agent) => this._runHook(s, agent, 'bell'),
		};
		for (const kept of this.store.load()) {
			try {
				this.sessions.set(kept.id, Session.restored({ ...kept, deps: this.deps }));
			} catch (e) {
				this._log(`could not bring back ${kept.id}: ${e && e.message}`);
			}
		}
	}

	_log(line) {
		process.stderr.write(`${new Date().toISOString()} ${line}\n`);
	}

	listen() {
		this.server = http.createServer((req, res) => this._http(req, res));
		this.server.on('upgrade', (req, socket) => this._upgrade(req, socket));
		return new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', () => {
				this.port = this.server.address().port;
				const info = { pid: process.pid, port: this.port, token: this.token, version: VERSION, startedAt: Date.now() };
				const file = path.join(this.stateDir, 'daemon.json');
				fs.writeFileSync(`${file}.tmp`, JSON.stringify(info), { mode: 0o600 });
				fs.renameSync(`${file}.tmp`, file);
				this._scheduleIdle();
				resolve(info);
			});
		});
	}

	_authorized(url) {
		const token = url.searchParams.get('token') || '';
		return token.length === this.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
	}

	_http(req, res) {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (!this._authorized(url)) {
			res.writeHead(403).end();
			return;
		}
		if (url.pathname === '/health') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, pid: process.pid, version: VERSION, sessions: [...this.sessions.values()].map(s => s.info()) }));
			return;
		}
		if (url.pathname === '/turn' && req.method === 'POST') {
			// an agent's hook (app/cli/terminal_hook.py): its turn started, ended, or it asks the person
			const s = this.sessions.get(url.searchParams.get('session') || '');
			if (!s || !s.setTurn(url.searchParams.get('state') || '')) {
				res.writeHead(404).end('{"ok":false}');
				return;
			}
			const info = s.info();
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, info: { title: info.title, cwd: info.cwd, agent: info.agent && info.agent.id } }));
			return;
		}
		if (url.pathname === '/stop' && req.method === 'POST') {
			res.writeHead(200).end('{"ok":true}');
			this.stop('asked');
			return;
		}
		res.writeHead(404).end();
	}

	_upgrade(req, socket) {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname !== '/ws' || !this._authorized(url)) {
			socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
			return;
		}
		const conn = acceptUpgrade(req, socket);
		if (!conn) {
			return;
		}
		this.clients.add(conn);
		this._scheduleIdle();
		conn.onMessage = text => this._message(conn, text);
		conn.onClose = () => {
			this.clients.delete(conn);
			for (const s of this.sessions.values()) {
				s.detach(conn);
			}
			this._scheduleIdle();
		};
	}

	/** The shell startup wrappers that keep Dispatch's variables (shell-init.cjs), in <state>/shell; undefined when they could not be written. */
	_shellInit() {
		try {
			return writeShellInit(path.join(this.stateDir, 'shell'));
		} catch (e) {
			this._log(`shell init: ${e && e.message}`);
			return undefined;
		}
	}

	/** Runs terminal_hook.py for a terminal, as its agent's own hook would. */
	_runHook(session, agent, event) {
		if (!this.hook || !this.hook.python || !this.hook.script) {
			return;
		}
		try {
			const child = require('child_process').spawn(this.hook.python, [this.hook.script, agent, event], {
				env: { ...this.env, ELECTRON_RUN_AS_NODE: '', DISPATCH_TERMINAL_SESSION: session.id },
				stdio: 'ignore',
			});
			child.on('error', e => this._log(`hook: ${e && e.message}`));
		} catch (e) {
			this._log(`hook: ${e && e.message}`);
		}
	}

	_broadcast(event) {
		const text = JSON.stringify(event);
		for (const c of this.clients) {
			c.send(text);
		}
	}

	_scheduleIdle() {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.clients.size === 0 && this.sessions.size === 0) {
			// nothing to keep: no terminal and no window
			this.idleTimer = setTimeout(() => this.stop('idle'), IDLE_EXIT_MS);
		}
	}

	_exited(session) {
		if (this.stopping) {
			return;
		}
		// the shell ended (exit, or the window closed it): the terminal is gone, its files too
		this._broadcast({ type: 'exit', session: session.id, code: session.exitCode });
		this._remove(session);
	}

	_remove(session) {
		if (!this.sessions.delete(session.id)) {
			return;
		}
		// a session's panes go with it
		for (const other of [...this.sessions.values()]) {
			if (other.meta.parent === session.id) {
				other.kill();
				this._remove(other);
			}
		}
		session.dispose();
		try {
			this.store.remove(session.id);
		} catch { /* already gone */ }
		this._broadcast({ type: 'removed', session: session.id });
		this._scheduleIdle();
	}

	_get(id) {
		const s = this.sessions.get(id);
		if (!s) {
			throw new Error(`No terminal ${id}`);
		}
		return s;
	}

	_message(conn, text) {
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		const reply = body => {
			if (msg.id !== undefined) {
				conn.send(JSON.stringify({ id: msg.id, ok: true, ...body }));
			}
		};
		try {
			this._handle(conn, msg, reply);
		} catch (e) {
			if (msg.id !== undefined) {
				conn.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) }));
			}
		}
	}

	_handle(conn, msg, reply) {
		switch (msg.type) {
			case 'ping':
				return reply({ version: VERSION, pid: process.pid });
			case 'list':
				return reply({ sessions: [...this.sessions.values()].map(s => s.info()) });
			case 'create': {
				const id = msg.session && ID_RE.test(msg.session) ? msg.session : crypto.randomUUID();
				if (this.sessions.has(id)) {
					throw new Error(`Terminal ${id} exists`);
				}
				const cwd = typeof msg.cwd === 'string' && fs.existsSync(msg.cwd) ? msg.cwd : os.homedir();
				const meta = { cwd, createdAt: Date.now(), title: msg.meta?.title, agent: msg.meta?.agent, restoreCommand: msg.meta?.restoreCommand, project: msg.meta?.project, agentSession: msg.meta?.agentSession, icon: msg.meta?.icon, parent: typeof msg.meta?.parent === 'string' ? msg.meta.parent : undefined };
				const s = new Session({ id, meta, cols: clampCols(msg.cols), rows: clampRows(msg.rows), deps: this.deps });
				this.sessions.set(id, s);
				s.spawn({
					command: typeof msg.command === 'string' && msg.command.trim() ? msg.command : undefined,
					draft: typeof msg.draft === 'string' && msg.draft.trim() ? msg.draft : undefined,
				});
				this._scheduleIdle();
				this._broadcast({ type: 'added', session: id, info: s.info() });
				return reply({ info: s.info() });
			}
			case 'attach': {
				const s = this._get(msg.session);
				if (msg.cols && msg.rows) {
					s.resize(msg.cols, msg.rows);
				}
				const snapshot = s.snapshot();
				const away = s.attach(conn, !!msg.flow);
				reply({ info: s.info(), snapshot, away });
				// brought back from disk: it starts again now that someone looks at it
				if (s.state === 'restored') {
					s.restart();
				}
				return;
			}
			case 'ack':
				this.sessions.get(msg.session)?.ack(conn, msg.chars);
				return;
			case 'detach':
				this.sessions.get(msg.session)?.detach(conn);
				return reply({});
			case 'write':
				this.sessions.get(msg.session)?.write(msg.data);
				return reply({});
			case 'resize':
				this.sessions.get(msg.session)?.resize(msg.cols, msg.rows);
				return reply({});
			case 'meta': {
				const s = this._get(msg.session);
				s.setMeta(msg.meta);
				return reply({ info: s.info() });
			}
			case 'clear':
				this._get(msg.session).clear();
				return reply({});
			case 'text':
				return reply({ text: this._get(msg.session).emulator.tailText(Math.min(20000, Math.max(1, msg.lines || 800))) });
			case 'kill': {
				const s = this.sessions.get(msg.session);
				if (s) {
					s.kill();
					this._remove(s);
				}
				return reply({});
			}
			case 'respawn': {
				// "Restart Claude Code": the program ends and starts again in the same terminal, going on with its
				// conversation where it can (the restart line Dispatch keeps for it)
				const s = this._get(msg.session);
				const old = s.proc;
				s.proc = undefined;
				if (old) {
					try {
						old.kill('SIGHUP');
					} catch { /* gone */ }
				}
				s.spawn({ command: typeof msg.command === 'string' && msg.command ? msg.command : s.meta.restoreCommand || undefined });
				return reply({ info: s.info() });
			}
			case 'saveImage':
				return reply({ path: saveImage(msg.data, msg.mime) });
			case 'clipboardImage':
				// the picture on the Mac's clipboard (a screenshot) as a file; answers once the copy is written
				clipboardImage().then(file => reply({ path: file }), e => conn.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) })));
				return;
			default:
				throw new Error(`Unknown request ${msg.type}`);
		}
	}

	/** Saves every screen and ends. `keepFiles`: the terminals come back from disk next time. */
	stop(reason) {
		if (this.stopping) {
			return;
		}
		this.stopping = true;
		this._log(`stopping (${reason})`);
		for (const s of this.sessions.values()) {
			s.dirty = true;
			s.saveScreen();
			if (reason === 'idle') {
				continue;
			}
			s.kill();
		}
		try {
			const file = path.join(this.stateDir, 'daemon.json');
			const info = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (info.pid === process.pid) {
				fs.rmSync(file, { force: true });
			}
		} catch { /* not ours or gone */ }
		try {
			fs.rmSync(path.join(this.stateDir, 'termd.lock'), { force: true });
		} catch { /* gone */ }
		for (const c of this.clients) {
			c.close(1001);
		}
		this.server?.close();
		setTimeout(() => process.exit(0), 200);
	}
}

function clampCols(v) {
	return Math.max(2, Math.min(1000, Math.floor(v) || 80));
}

function clampRows(v) {
	return Math.max(1, Math.min(500, Math.floor(v) || 24));
}

/** A pasted picture as a file the agent in the terminal can read; the path goes into the terminal. */
function saveImage(base64, mime) {
	if (typeof base64 !== 'string' || !base64) {
		throw new Error('No picture');
	}
	const bytes = Buffer.from(base64, 'base64');
	if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
		throw new Error('The picture is empty or too big');
	}
	const ext = IMAGE_TYPES[mime] || 'png';
	const dir = path.join(os.tmpdir(), 'dispatch-paste');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
	fs.writeFileSync(file, bytes, { mode: 0o600 });
	return file;
}

/** Writes the clipboard's picture (PNG) to a file with osascript; resolves with its path, or '' when there is none. */
function clipboardImage() {
	const dir = path.join(os.tmpdir(), 'dispatch-paste');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`);
	const script = [
		'try',
		'set img to (the clipboard as «class PNGf»)',
		'on error',
		'return "none"',
		'end try',
		`set f to open for access (POSIX file ${JSON.stringify(file)}) with write permission`,
		'write img to f',
		'close access f',
		'return "ok"',
	];
	return new Promise((resolve, reject) => {
		require('child_process').execFile('/usr/bin/osascript', script.flatMap(l => ['-e', l]), { timeout: 10000 }, (err, stdout) => {
			if (err) {
				reject(new Error('Could not read the picture on the clipboard'));
				return;
			}
			if (String(stdout).trim() !== 'ok') {
				resolve('');
				return;
			}
			try {
				fs.chmodSync(file, 0o600);
			} catch { /* keep it as written */ }
			resolve(file);
		});
	});
}

async function main() {
	const stateDir = arg('--state', path.join(os.homedir(), 'tasks', '.dispatch', 'termd'));
	const appRoot = arg('--app-root', '');
	fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	if (!takeLock(stateDir)) {
		process.stderr.write('termd: another daemon is running for this folder\n');
		process.exit(3);
	}
	const modules = loadModules(appRoot);
	const hook = { python: arg('--hook-python', ''), script: arg('--hook-script', '') };
	const daemon = new Daemon({ stateDir, modules, env: process.env, hook });
	process.on('SIGTERM', () => daemon.stop('SIGTERM'));
	process.on('SIGINT', () => daemon.stop('SIGINT'));
	// the app quitting closes the pipe the daemon was started with: that must not end it
	process.on('SIGHUP', () => { });
	process.on('uncaughtException', e => daemon._log(`uncaught: ${e && e.stack || e}`));
	await daemon.listen();
	daemon._log(`listening on 127.0.0.1:${daemon.port} pid ${process.pid}, ${daemon.sessions.size} terminal(s) kept`);
}

if (require.main === module) {
	main().catch(e => {
		process.stderr.write(`termd: ${e && e.stack || e}\n`);
		process.exit(1);
	});
}

module.exports = { Daemon, saveImage, clipboardImage, loadModules, takeLock, VERSION };
