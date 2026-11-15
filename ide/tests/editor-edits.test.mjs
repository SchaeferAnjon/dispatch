import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('workbench/contrib/dispatchEditorEdits/browser/dispatchEditorEditsModel.ts'));

const facts = (sources, over = {}) => ({ sources, isUndoing: false, isRedoing: false, isFlush: false, ...over });

test('typing, pasting, editor commands and taken suggestions are a person (task-m6hek)', () => {
	for (const s of ['cursor', 'snippet', 'suggest', 'rename', 'codeAction', 'inlineCompletionAccept']) {
		assert.deepEqual(m.editKinds(facts([s])), { hand: true, agent: false }, s);
	}
	assert.deepEqual(m.editKinds(facts(['unknown'], { isUndoing: true })), { hand: true, agent: false });
});

test('a reload from disk, an extension and an agent writing through the editor are not', () => {
	for (const s of ['reloadFromDisk', 'setValue', 'unknown', 'applyEdits', 'eolChange']) {
		assert.deepEqual(m.editKinds(facts([s])), { hand: false, agent: false }, s);
	}
	assert.deepEqual(m.editKinds(facts(['cursor'], { isFlush: true })), { hand: false, agent: false });
	assert.deepEqual(m.editKinds(facts(['Chat.applyEdits'])), { hand: false, agent: true });
	assert.deepEqual(m.editKinds(facts(['Chat.applyEdits'], { isUndoing: true })), { hand: false, agent: true });
	assert.deepEqual(m.editKinds(facts(['cursor', 'inlineChat.applyEdits'])), { hand: true, agent: true });
});
