import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { DispatchAgentSleep } = await import(moduleAt('platform/agentHost/node/dispatchAgentSleep.ts'));

test('Let idle agents sleep: a session quiet since before the ask is due at once, whatever the minutes (task-uymr9)', () => {
 let now = 1_000_000, asked = 0;
 const sleep = new DispatchAgentSleep(() => now, () => 0, () => { }, () => asked);
 sleep.note('a');
 now += 60_000;
 assert.equal(sleep.isDue('a', false), false, 'sleep off and nobody asked');
 asked = now;
 now += 6_000; // past the few seconds the ask is cached for
 assert.equal(sleep.isDue('a', false), true);
 assert.equal(sleep.isDue('a', true), false, 'never while it waits for the person');
 sleep.note('b'); // touched after the ask
 assert.equal(sleep.isDue('b', false), false);
});

test('the minutes still put a quiet session to sleep without an ask', () => {
 let now = 0;
 const sleep = new DispatchAgentSleep(() => now, () => 30, () => { }, () => 0);
 sleep.note('a');
 now += 29 * 60_000;
 assert.equal(sleep.isDue('a', false), false);
 now += 61_000;
 assert.equal(sleep.isDue('a', false), true);
});
