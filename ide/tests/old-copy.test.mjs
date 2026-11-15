import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('code/electron-main/dispatchOldCopyCheck.ts'));

const installed = '/Applications/Dispatch IDE.app';
const backup = '/Users/me/Dispatch-备份-1001/files/000-Dispatch IDE.app';
const facts = { bundle: backup, installed, ownDate: '2026-10-01T09:00:00+02:00', installedDate: '2026-10-09T07:13:04+02:00', asked: [] };

test('a copy runs from its .app', () => {
	assert.equal(m.dispatchBundleOf(`${backup}/Contents/Resources/app`), backup);
	assert.equal(m.dispatchBundleOf('/Users/me/Projects/kanban/ide/vscode'), undefined);
});

test('an old copy outside Applications is offered the newer installed one, once (task-7ve7v, 10-09)', () => {
	assert.equal(m.dispatchShouldOfferInstalled(facts), true);
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, asked: [backup] }), false, 'asked once already');
});

test('the installed copy, a newer build and dates that cannot be read are left alone', () => {
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, bundle: installed }), false);
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, bundle: '/Applications/Utilities/Dispatch IDE.app' }), false);
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, ownDate: '2026-10-09T08:00:00+02:00' }), false, 'a build newer than the installed one');
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, ownDate: facts.installedDate }), false, 'the same build');
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, ownDate: undefined }), false);
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, installedDate: 'soon' }), false);
	assert.equal(m.dispatchShouldOfferInstalled({ ...facts, bundle: undefined }), false, 'run from source');
});

test('the dialog says when each was built', () => {
	assert.equal(m.dispatchBuiltOn('2026-10-09T07:13:04+02:00'), 'Oct 9, 2026');
	assert.equal(m.dispatchBuiltOn(undefined), '?');
});
