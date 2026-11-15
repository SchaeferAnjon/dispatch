import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchStatusBar/browser/dispatchStatusBarModel.ts'));

const o = { narrow: false, newUser: false, usedWord: 'used', resetsWord: w => `resets ${w}` };

test('the bottom bar says how much of an allowance is used, as the account panel and Settings do (task-pss5)', () => {
 assert.deepEqual(model.allowanceWords(83, '01:00', 'Claude', o), { words: '83% used · 01:00', low: true });
 assert.deepEqual(model.allowanceWords(83, '01:00', 'Claude', { ...o, narrow: true }), { words: '83%', low: true });
 assert.equal(model.allowanceWords(79, '', 'Claude', o).low, false);
 assert.equal(model.HIGH_USED, 80);
});

test('the bottom bar shows when an allowance resets even before it runs high', () => {
 assert.deepEqual(model.allowanceWords(12, 'Sun 23:00', 'Codex', o), { words: 'resets Sun 23:00', low: false });
 assert.deepEqual(model.allowanceWords(12, 'Sun 23:00', 'Codex', { ...o, newUser: true }), { words: 'Codex · resets Sun 23:00', low: false });
});

test('the gauge fills with what is used', () => {
 assert.deepEqual(model.gaugeCells(83, 10).map(x => Math.round(x * 10) / 10), [1, 1, 1, 1, 1, 1, 1, 1, 0.3, 0]);
 assert.deepEqual(model.gaugeCells(0, 5), [0, 0, 0, 0, 0]);
});

const words = {
 memory: 'most of its memory', processors: 'its processors',
 agents: n => n === 1 ? '1 agent' : `${n} agents`, builds: n => n === 1 ? 'a build' : `${n} builds`,
 and: (a, b) => `${a} and ${b}`, using: (w, x) => `${w} are using ${x}, so things feel slow.`,
 usingOne: (w, x) => `${w} is using ${x}, so things feel slow.`, others: x => `Apps on this Mac are using ${x}, so things feel slow.`,
};

test('Busy says what uses the Mac in words, never memory numbers (task-uymr9)', () => {
 const b = model.parseBusy({ ok: true, busy: true, why: 'memory', memory_free: 12, agents: 6, builds: 1 });
 assert.deepEqual(b, { busy: true, why: 'memory', agents: 6, builds: 1 });
 assert.equal(model.busyWords(b, words), '6 agents and a build are using most of its memory, so things feel slow.');
 assert.equal(model.busyWords({ busy: true, why: 'processors', agents: 1, builds: 0 }, words), '1 agent is using its processors, so things feel slow.');
 assert.equal(model.busyWords({ busy: true, why: 'processors', agents: 0, builds: 0 }, words), 'Apps on this Mac are using its processors, so things feel slow.');
 assert.equal(model.parseBusy({ ok: false, error: 'unavailable' }), undefined);
 assert.equal(model.parseBusy(undefined), undefined);
});

test("an agent's test builds never turn the bar into a warning: only a build of yours does (task-7ve7v)", () => {
 const b = (name, more = {}) => ({ name, host: 'mini', label: name, ...more });
 const q = model.parseBuildQueue({
  building: [], waiting: [], done: [],
  failed: [b('9999eeeeffff', { kind: 'yours', step: 'build', log: '/Users/apple/dispatch-builds/9999eeeeffff/build.log', retry: 'dispatch build start 9999eeeeffff --rebuild' })],
  agents: { building: [b('1111aaaa2222-dev', { stage: 'build' })], waiting: [], failed: [b('5555cccc6666-dev'), b('7777dddd8888-dev')], done: [] },
 });
 assert.deepEqual(q.failed.map(f => f.name), ['9999eeeeffff']);
 assert.equal(q.agents.failed.length, 2);
 assert.equal(model.agentsBusy(q), 1);
 assert.deepEqual(model.queueBlocks(q, 6, 0), { head: undefined, waiting: 0, more: 0 });
 // an older CLI without the split: its -dev builds are the agents' all the same
 const old = model.parseBuildQueue({ building: [], waiting: [], done: [], failed: [b('5555cccc6666-dev'), b('8888aaaa9999')], recent: { built: 1, failed: 5, checks_failed: 3 } });
 assert.deepEqual([old.failed.map(f => f.name), old.agents.failed.map(f => f.name), old.recent], [['8888aaaa9999'], ['5555cccc6666-dev'], undefined]);
});
