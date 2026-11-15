import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { taskPhase } = await import(moduleAt('sessions/contrib/dispatchTasks/common/dispatchTaskPhase.ts'));

const steps = (...states) => states.map(state => ({ state }));

test('every step done is wrapping up, whatever the session does', () => {
 assert.equal(taskPhase(steps('done', 'done', 'done', 'done'), true), 'wrapup');
 assert.equal(taskPhase(steps('done', 'done'), false), 'wrapup');
 assert.equal(taskPhase(steps('done'), undefined), 'wrapup');
});

test('steps left and the session working is running', () => {
 assert.equal(taskPhase(steps('done', 'done', 'done', 'done', 'active'), true), 'running');
 assert.equal(taskPhase(steps('done', 'todo'), true), 'running');
});

test('steps left but the session not working is idle', () => {
 assert.equal(taskPhase(steps('done', 'active'), false), 'idle');
});

test('a session the window does not have keeps the ping; no plan at all is not wrapping up', () => {
 assert.equal(taskPhase(steps('done', 'active'), undefined), 'running');
 assert.equal(taskPhase([], true), 'running');
 assert.equal(taskPhase([], false), 'idle');
});
