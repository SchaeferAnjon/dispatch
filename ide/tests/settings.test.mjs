import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchSettings/browser/dispatchSettingsModel.ts'));

test('the side bar row of Knowledge takes a preference page back to Knowledge\'s home (task-68ho)', () => {
 assert.equal(model.backToPageStart('knowledge', 'knowledge'), true);
 assert.equal(model.backToPageStart('skills', 'knowledge'), false);
 assert.equal(model.backToPageStart(undefined, 'knowledge'), false);
 assert.equal(model.backToPageStart('skills', 'skills'), false);
});

test('Settings search finds the Mac banner switch (task-3dn4)', () => {
 const hits = model.searchSettings('banner');
 assert.ok(hits.some(h => (h.entry ?? h).page === 'notifications' && (h.entry ?? h).key === 'mac-notify'), JSON.stringify(hits.slice(0, 3)));
});

test('Usage is a page of Settings under Account and usage (task-8eudz)', () => {
 assert.equal(model.pageParent('usage'), 'account');
 assert.equal(model.navOwner('usage'), 'account');
 assert.equal(model.pageTitle('usage'), 'Usage');
 assert.equal(model.isEmbeddedPage('usage'), false);
 const hits = model.searchSettings('usage over time');
 assert.equal((hits[0].entry ?? hits[0]).page, 'usage');
});

test('What Dispatch gives every agent is found on Soul, what is yours on its own page (pref 内置的放 Soul)', () => {
 const top = q => model.searchSettings(q)[0]?.entry;
 assert.deepEqual([top('dispatch.md').page, top('dispatch.md').key], ['soul', 'builtin-rules']);
 assert.deepEqual([top('session brief').page, top('session brief').key], ['soul', 'builtin-brief']);
 assert.equal(top('built-in skills').key, 'builtin-skills');
 assert.equal(top('engineer').key, 'builtin-agents');
 assert.equal(top('global.md').page, 'instructions');
 assert.equal(top('skills').page, 'skills');
});
