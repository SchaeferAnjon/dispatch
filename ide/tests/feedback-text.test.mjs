import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const f = await import(moduleAt('workbench/contrib/chat/browser/dispatchFeedbackRequestText.ts'));

const notes = (...texts) => [{ kind: 'file', name: 'app.js' }, { kind: 'agentFeedback', feedbackItems: texts.map((text, i) => ({ id: `f${i}`, text })) }];

test('the Submit Feedback turn shows the notes you wrote (task-et0q)', () => {
	assert.equal(f.feedbackRequestText('/act-on-feedback', notes('Call it Remove, not Delete'), 'Your notes'), 'Call it Remove, not Delete');
	assert.equal(f.feedbackRequestText('/act-on-feedback', notes('One', ' Two '), 'Your notes'), 'One\n\nTwo');
	assert.equal(f.feedbackRequestText('/act-on-feedback for #42 and keep the tests', notes('One'), 'Your notes'), 'One\n\nand keep the tests');
	// read back without its notes: still not the command
	assert.equal(f.feedbackRequestText('/act-on-feedback', [], 'Your notes'), 'Your notes');
	assert.equal(f.feedbackRequestText('/act-on-feedback', undefined, 'Your notes'), 'Your notes');
	// every other message keeps its own text
	assert.equal(f.feedbackRequestText('please /act-on-feedback later', notes('x'), 'Your notes'), undefined);
	assert.equal(f.feedbackRequestText('/act-on-feedbacks', notes('x'), 'Your notes'), undefined);
	assert.equal(f.feedbackRequestText('Fix the header', notes('x'), 'Your notes'), undefined);
});
