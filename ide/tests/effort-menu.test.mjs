// The Thinking Level menu under the chat input (task-tpnwq): only its options, no prompt-cache banner above them, and
// the grey word after an option says why the checked one is checked ("Default" or "Last picked").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const at = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const dir = 'workbench/contrib/chat/browser/widget/input/modelPicker/';
const { dispatchConfigNote } = await import(at(dir + 'dispatchConfigNote.ts'));

test('a new chat on the default: only the default option says Default', () => {
	const notes = ['low', 'medium', 'high', 'xhigh', 'max'].map(v => dispatchConfigNote(v, 'high', 'high', false));
	assert.deepEqual(notes, [undefined, undefined, 'default', undefined, undefined]);
});

test('a level picked earlier says Last picked, and the default still says Default', () => {
	const notes = ['low', 'medium', 'high', 'xhigh', 'max'].map(v => dispatchConfigNote(v, 'medium', 'high', false));
	assert.deepEqual(notes, [undefined, 'lastPicked', 'default', undefined, undefined]);
});

test('an option already called Default (OpenCode) gets no second Default; a pick still says Last picked', () => {
	assert.equal(dispatchConfigNote('default', 'default', 'default', true), undefined);
	assert.equal(dispatchConfigNote('low', 'low', 'default', false), 'lastPicked');
});

test('a schema without a default names nothing', () => {
	assert.equal(dispatchConfigNote('medium', 'medium', undefined, false), undefined);
});

test('the Thinking Level menu has no prompt-cache banner; the model menu keeps its own', () => {
	const config = readFileSync(at(dir + 'modelPickerConfiguration.ts'), 'utf8');
	assert.doesNotMatch(config, /headerText|cacheBreakHint\b|resets the prompt cache/);
	assert.match(config, /\/\/ Dispatch IDE: the thinking-level menu holds only its options/);
	assert.match(config, /description: noteLabel/);
	const widget = readFileSync(at(dir + 'modelPickerWidget.ts'), 'utf8');
	assert.match(widget, /Switching models mid-session resets the prompt cache/);
});
