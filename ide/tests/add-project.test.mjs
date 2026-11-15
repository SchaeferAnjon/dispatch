import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchAddProject/browser/dispatchAddProjectModel.ts'));

test('Create project says why it is grey (kanban task-lj06.20)', () => {
	// nothing typed yet: nothing to say
	assert.equal(model.createBlocker('', 'ask', { name: '', email: '' }), undefined);
	// a name, git has no email and the field is empty: the button says so instead of staying grey without a word
	assert.match(model.createBlocker('计时器', 'ask', { name: 'Apple', email: '' }), /email/);
	assert.match(model.createBlocker('timer', 'ask', { name: '', email: 'a@b.co' }), /name/);
	assert.match(model.createBlocker('timer', 'ask', { name: 'Ada', email: 'nope' }), /email address/);
	assert.equal(model.createBlocker('timer', 'ask', { name: 'Ada', email: 'ada@example.com' }), undefined);
	assert.equal(model.createBlocker('timer', 'known'), undefined);
});

test('Create project waits until Dispatch knows whether git has a name (kanban task-lj06.20)', () => {
	// the second way the dialog lost a project: pressed before the name and email fields came in, the CLI refused
	assert.match(model.createBlocker('timer', 'checking'), /Checking/);
	// a name with a problem says that problem (in its own line), not this one
	assert.equal(model.createBlocker('a/b', 'checking'), undefined);
});

test('a refusal for want of a name says what to do in the dialog', () => {
	assert.match(model.NO_IDENTITY_MESSAGE, /name and email/);
	assert.doesNotMatch(model.NO_IDENTITY_MESSAGE, /Settings/);
});
