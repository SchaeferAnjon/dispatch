import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerHooks } from 'node:module';

// the words go through VS Code's nls, which needs the workbench: English as written, {n} filled in
const NLS = 'data:text/javascript,' + encodeURIComponent('export function localize(_k, s, ...a) { return s.replace(/\\{(\\d+)\\}/g, (_, i) => String(a[i])); }');
registerHooks({ resolve: (spec, ctx, next) => /(^|\/)nls\.js$/.test(spec) ? { url: NLS, shortCircuit: true } : next(spec, ctx) });

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchStatusBar/browser/dispatchAwakeWords.ts'));

const held = { mode: 'system', holding: true, reason: 'working', working: 1 };

test('the cup says it holds while agents work, never while a window is open', () => {
	const w = m.awakeWords(held, 1);
	assert.equal(w.head, 'Your Mac stays awake while agents work');
	assert.ok(!/window/.test(w.head + w.why));
	assert.match(w.why, /screen still dims/);
	assert.equal(w.count, '1 agent is working now.');
});

test('screen on too, and a phone as the reason', () => {
	assert.equal(m.awakeWords({ ...held, mode: 'display', working: 2 }, 0).head, 'Your Mac and its screen stay awake while agents work');
	const p = m.awakeWords({ mode: 'system', holding: true, reason: 'phone', working: 0 }, 0);
	assert.equal(p.head, 'Your Mac stays awake while your phone is connected');
	assert.equal(p.count, '');
});

test('the cup panel switches lead: its words follow the setting before the background service does', () => {
	assert.equal(m.awakeWords(held, 0, 'display').head, 'Your Mac and its screen stay awake while agents work');
	assert.match(m.awakeWords(held, 0, 'display').why, /screen stays on/);
	const off = m.awakeWords(held, 0, 'off');
	assert.equal(off.head, 'Your Mac sleeps as usual');
	assert.match(off.why, /Agents stop while it sleeps/);
	assert.equal(off.count, '1 agent is working now.');
	assert.equal(m.awakeWords({ mode: 'system', holding: true, reason: 'phone' }, 0, 'off').head, 'Your Mac sleeps as usual');
	assert.equal(m.awakeWords({ ...held, mode: 'off' }, 0, 'system').head, 'Your Mac stays awake while agents work');
});

test('agents working: the larger of this window and the whole Mac', () => {
	assert.equal(m.awakeWorking({ mode: 'system', holding: true, working: 3 }, 1), 3);
	assert.equal(m.awakeWorking({ mode: 'system', holding: true }, 2), 2);
	assert.equal(m.awakeWorking(undefined, 0), 0);
	assert.equal(m.awakeWords({ mode: 'system', holding: true, working: 3 }, 1).count, '3 agents are working now.');
});

test('the setting as a mode: anything unknown is the Mac only', () => {
	assert.equal(m.awakeMode('display'), 'display');
	assert.equal(m.awakeMode('off'), 'off');
	assert.equal(m.awakeMode('system'), 'system');
	assert.equal(m.awakeMode(undefined), 'system');
	assert.equal(m.awakeMode(2), 'system');
});
