// The terminal daemon's parts that need no pseudo-terminal: the escape tail, the WebSocket frames, the kept
// files and the shell's environment. (The whole daemon runs on Dispatch IDE's Electron; the end-to-end run is
// the terminal scenario in scripts/ide-e2e.)
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { extractPartialEscapeTail, advancePartialEscapeTail } = require('./escape-tail.cjs');
const { encodeFrame, decodeFrames, encodeClientFrame, acceptKey } = require('./ws.cjs');
const { SessionStore } = require('./store.cjs');
const { shellEnv, shellCommand, startsDirectly, rings } = require('./session.cjs');
const { pinnedNames, writeShellInit, shellLaunch } = require('./shell-init.cjs');
const { spawnSync } = require('child_process');
const { osc7Folder } = require('./emulator.cjs');
const { saveImage, takeLock } = require('./termd.cjs');

describe('escape tail', () => {
	it('is empty for a clean stream', () => {
		expect(extractPartialEscapeTail('hello \x1b[31mred\x1b[0m')).toBe('');
	});
	it('keeps an unfinished CSI and OSC', () => {
		expect(extractPartialEscapeTail('abc\x1b[3')).toBe('\x1b[3');
		expect(extractPartialEscapeTail('x\x1b]0;tit')).toBe('\x1b]0;tit');
	});
	it('folds across chunks', () => {
		const a = 'one\x1b[3';
		const b = '1mtwo\x1b]7;file://h/tmp';
		expect(advancePartialEscapeTail(advancePartialEscapeTail('', a), b)).toBe(extractPartialEscapeTail(a + b));
	});
	it('gives up on an endless OSC', () => {
		expect(advancePartialEscapeTail('', '\x1b]52;c;' + 'A'.repeat(5000))).toBe('');
	});
});

describe('websocket frames', () => {
	it('accept key follows RFC 6455', () => {
		expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
	});
	it('decodes masked client frames of every length, and keeps an unfinished one', () => {
		for (const n of [5, 300, 70000]) {
			const payload = Buffer.from('x'.repeat(n));
			const frame = encodeClientFrame(1, payload);
			const { frames, rest } = decodeFrames(Buffer.concat([frame, frame.subarray(0, 3)]));
			expect(frames).toHaveLength(1);
			expect(frames[0].payload.toString()).toBe(payload.toString());
			expect(rest.length).toBe(3);
		}
	});
	it('refuses an unmasked client frame', () => {
		expect(() => decodeFrames(encodeFrame(1, Buffer.from('hi')))).toThrow();
	});
	it('server frames are unmasked with the right length', () => {
		const f = encodeFrame(1, Buffer.from('你好'));
		expect(f[0]).toBe(0x81);
		expect(f[1]).toBe(6);
	});
});

describe('kept terminals', () => {
	it('saves and loads meta and screen, oldest first, and removes', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termd-'));
		const store = new SessionStore(dir);
		store.saveMeta('b', { cwd: '/b', createdAt: 2 });
		store.saveMeta('a', { cwd: '/a', createdAt: 1 });
		store.saveScreen('a', '\x1b[1mhi 你好\x1b[0m');
		const kept = store.load();
		expect(kept.map(k => k.id)).toEqual(['a', 'b']);
		expect(kept[0].screen).toContain('你好');
		expect(kept[1].screen).toBe('');
		expect(fs.statSync(path.join(dir, 'sessions', 'a', 'meta.json')).mode & 0o077).toBe(0);
		store.remove('a');
		expect(store.load().map(k => k.id)).toEqual(['b']);
	});
	it('refuses an id that could leave its folder', () => {
		const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'termd-')));
		expect(() => store.saveMeta('../x', {})).toThrow();
	});
});

describe('the shell', () => {
	it('drops what belongs to the app and sets a UTF-8 terminal', () => {
		const env = shellEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '3', HOME: '/h' }, 's1');
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(env.VSCODE_PID).toBeUndefined();
		expect(env.TERM).toBe('xterm-256color');
		expect(env.LANG).toBe('en_US.UTF-8');
		expect(env.DISPATCH_TERMINAL_SESSION).toBe('s1');
		expect(shellEnv({ LANG: 'zh_CN.UTF-8' }, 's').LANG).toBe('zh_CN.UTF-8');
	});
	it('starts the person\'s shell as a login shell', () => {
		expect(shellCommand({ SHELL: '/opt/homebrew/bin/fish' })).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'] });
	});
	it('starts an agent as the terminal\'s own program, then the person\'s shell', () => {
		expect(startsDirectly({ file: '/bin/zsh', args: ['-l'] }, "'/x/claude' --session-id u")).toEqual({ file: '/bin/zsh', args: ['-l', '-c', "'/x/claude' --session-id u; exec '/bin/zsh' -l"] });
		expect(startsDirectly({ file: '/bin/tcsh', args: ['-l'] }, 'x')).toBeUndefined();
	});
	it('keeps the task board, Dispatch\'s variables and the ones a test instance lists', () => {
		const env = { BEADS_DIR: '/b', DISPATCH_DIR: '/d', DISPATCH_TERMINAL_KEEP: 'CODEX_HOME XDG_DATA_HOME', CODEX_HOME: '/c', HOME: '/h', PATH: '/bin', DISPATCH_PIN_OLD: 'x' };
		expect(pinnedNames(env)).toEqual(['BEADS_DIR', 'CODEX_HOME', 'DISPATCH_DIR']);
	});
	it('hears a bell, not the end of a title', () => {
		expect(rings('done\x07')).toBe(true);
		expect(rings('\x1b]0;my title\x07prompt')).toBe(false);
		expect(rings('\x1b]8;;file:///a\x1b\\a\x1b]8;;\x1b\\')).toBe(false);
	});
	it('reads the folder from OSC 7', () => {
		expect(osc7Folder('file://mac.local/Users/me/My%20Project')).toBe('/Users/me/My Project');
		expect(osc7Folder('nonsense')).toBeNull();
	});
});

describe('the daemon', () => {
	it('saves a pasted picture where only this user can read it', () => {
		const file = saveImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), 'image/png');
		expect(file.endsWith('.png')).toBe(true);
		expect(fs.statSync(file).mode & 0o077).toBe(0);
		fs.rmSync(file);
		expect(() => saveImage('', 'image/png')).toThrow();
	});
	it('one daemon per folder', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termd-'));
		fs.writeFileSync(path.join(dir, 'termd.lock'), String(process.ppid));
		expect(takeLock(dir)).toBeUndefined();
		fs.writeFileSync(path.join(dir, 'termd.lock'), '999999');
		expect(takeLock(dir)).toBe(path.join(dir, 'termd.lock'));
	});
});

// a Session without a pseudo-terminal or an emulator: what it does with what comes in and goes out
function bareSession({ agent, onAgentBell } = {}) {
	const { Session } = require('./session.cjs');
	const s = Object.create(Session.prototype);
	const writes = [];
	const changes = [];
	Object.assign(s, {
		id: 't1', meta: { agent: agent ? { id: agent } : undefined }, pending: [], turn: undefined, bell: false, busy: false,
		proc: { write: d => writes.push(d) }, clients: new Set(), deps: { onChange: x => changes.push(x.info ? 1 : 1), onAgentBell },
		emulator: { cwd: '/tmp/p' }, state: 'running', cols: 80, rows: 24,
	});
	return { s, writes, changes };
}

describe('an agent\'s turn', () => {
	it('takes the agent\'s own word and shows it in the info', () => {
		const { s } = bareSession({ agent: 'claude' });
		expect(s.setTurn('nonsense')).toBe(false);
		expect(s.setTurn('finished')).toBe(true);
		expect(s.info().turn).toBe('finished');
		expect(typeof s.info().turnAt).toBe('number');
	});
	it('goes back to working when the person answers a question', () => {
		const { s } = bareSession({ agent: 'claude' });
		s.setTurn('needs_you');
		s.write('y');
		expect(s.info().turn).toBe('working');
	});
	it('passes a bell on for agents without hooks only', () => {
		const rang = [];
		const codex = bareSession({ agent: 'codex', onAgentBell: (x, a) => rang.push(a) }).s;
		codex._activity('\x07');
		const claude = bareSession({ agent: 'claude', onAgentBell: (x, a) => rang.push(a) }).s;
		claude._activity('\x07');
		const shell = bareSession({ onAgentBell: (x, a) => rang.push(a) }).s;
		shell._activity('\x07');
		expect(rang).toEqual(['codex']);
	});
});

describe('a long paste', () => {
	it('reaches the program in order, in pieces, emoji whole', async () => {
		const { s, writes } = bareSession();
		const big = 'a'.repeat(100000) + '😀' + 'b'.repeat(50000);
		s._writePty(big);
		s._writePty('typed');
		// the pieces go one per turn of the event loop: wait until the last one went, not a fixed 50 ms (a busy Mac
		// let the timer fire with pieces still to go)
		while (s.pumping) {
			await new Promise(r => setImmediate(r));
		}
		expect(writes.join('')).toBe(big + 'typed');
		expect(writes.length).toBeGreaterThan(5);
		expect(writes.every(w => w.length <= 16 * 1024)).toBe(true);
		expect(writes.some(w => /[\ud800-\udbff]$/.test(w))).toBe(false);
	});
	it('a short one goes at once', () => {
		const { s, writes } = bareSession();
		s._writePty('ls\r');
		expect(writes).toEqual(['ls\r']);
	});
});

describe('the daemon hears hooks', () => {
	it('POST /turn sets the terminal\'s turn and answers its title and folder', () => {
		const { Daemon } = require('./termd.cjs');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termd-'));
		const d = new Daemon({ stateDir: dir, modules: {}, env: {} });
		const { s } = bareSession({ agent: 'claude' });
		s.meta.title = 'Claude Code (terminal)';
		d.sessions.set('t1', s);
		const call = url => {
			const out = {};
			d._http({ url, method: 'POST' }, { writeHead(code) { out.code = code; return this; }, end(body) { out.body = body; } });
			return out;
		};
		expect(call('/turn?token=wrong&session=t1&state=finished').code).toBe(403);
		const ok = call(`/turn?token=${d.token}&session=t1&state=finished`);
		expect(ok.code).toBe(200);
		expect(JSON.parse(ok.body).info).toEqual({ title: 'Claude Code (terminal)', cwd: '/tmp/p', agent: 'claude' });
		expect(s.turn.state).toBe('finished');
		expect(call(`/turn?token=${d.token}&session=nope&state=finished`).code).toBe(404);
		expect(call(`/turn?token=${d.token}&session=t1&state=bogus`).code).toBe(404);
	});
});

describe('flow control', () => {
	it('pauses the program while a window is far behind and resumes once it caught up', async () => {
		const { s } = bareSession();
		let paused = 0;
		let resumed = 0;
		s.proc = { write() { }, pause() { paused++; }, resume() { resumed++; } };
		s.out = '';
		const sent = [];
		const win = { buffered: 0, send: m => sent.push(m) };
		const old = { buffered: 0, send: () => { } };
		s.clients = new Set([win, old]);
		s.unacked = new Map([[win, 0]]);
		s.out = 'x'.repeat(600 * 1024);
		s._flush();
		expect(paused).toBe(1);
		expect(s.paused).toBe(true);
		s.ack(win, 560 * 1024);
		// it looks every 30 ms: wait for it to resume (a fixed 80 ms ran out on a busy Mac), at most 10 s
		for (const end = Date.now() + 10000; s.paused && Date.now() < end;) {
			await new Promise(r => setTimeout(r, 10));
		}
		expect(resumed).toBe(1);
		expect(s.paused).toBe(false);
		// a window that does not acknowledge (older) is only watched by its socket
		s.unacked.delete(win);
		s.out = 'y'.repeat(600 * 1024);
		s._flush();
		expect(paused).toBe(1);
	});
});

// 10-06: a test instance's terminal read the person's ~/.zshrc, which sets BEADS_DIR to their real board, and what an
// agent in it noted went onto that board. Each shell here reads startup files that set BEADS_DIR and DISPATCH_DIR
// elsewhere; the terminal must still have Dispatch's.
describe('the shell\'s startup files do not move Dispatch\'s variables', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termd-shell-'));
	const home = path.join(root, 'home');
	fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
	const hostile = 'export BEADS_DIR=/wrong/board; export DISPATCH_DIR=/wrong/dd\n';
	for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bash_profile', '.profile', '.shrc']) {
		fs.writeFileSync(path.join(home, f), hostile);
	}
	fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'), 'set -gx BEADS_DIR /wrong/board; set -gx DISPATCH_DIR /wrong/dd\n');
	const dir = writeShellInit(path.join(root, 'shell'));
	const base = { HOME: home, USER: 'x', PATH: '/usr/bin:/bin:/opt/homebrew/bin', BEADS_DIR: '/right/board', DISPATCH_DIR: '/right/dd', ENV: path.join(home, '.shrc') };
	const shells = ['/bin/zsh', '/bin/bash', '/bin/sh', '/bin/ksh', '/opt/homebrew/bin/fish'].filter(f => fs.existsSync(f));
	const run = (l, extra, input) => spawnSync(l.file, [...l.args, ...extra], { env: l.env, input, encoding: 'utf8', timeout: 20000 }).stdout || '';

	it.each(shells)('%s as the terminal\'s shell', file => {
		const l = shellLaunch({ file, args: ['-l'] }, base, dir);
		expect(run(l, ['-i'], 'echo "I=$BEADS_DIR $DISPATCH_DIR"\nexit\n')).toContain('I=/right/board /right/dd');
	});
	it.each(shells)('%s running an agent, and the shell after it', file => {
		const l = shellLaunch({ file, args: ['-l'] }, base, dir, 'echo "C=$BEADS_DIR $DISPATCH_DIR"');
		const out = run(l, [], 'echo "A=$BEADS_DIR"\nexit\n');
		expect(out).toContain('C=/right/board /right/dd');
		if (!/\/(sh|ksh)$/.test(file)) {  // an sh reads ENV only when interactive, which a piped one is not
			expect(out).toContain('A=/right/board');
		}
	});
	it('without the wrappers the startup file wins (what the wrappers are for)', () => {
		const l = shellLaunch({ file: '/bin/zsh', args: ['-l'] }, base, undefined);
		expect(run(l, ['-i'], 'echo "I=$BEADS_DIR"\nexit\n')).toContain('I=/wrong/board');
	});
	it('zsh gets the person\'s ZDOTDIR and history file back once it is up', () => {
		const l = shellLaunch({ file: '/bin/zsh', args: ['-l'] }, base, dir);
		const out = run(l, ['-i'], 'echo "Z=$ZDOTDIR H=$HISTFILE"\nexit\n');
		expect(out).toContain(`Z=${home} H=${home}/.zsh_history`);
	});
});
