import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('workbench/contrib/chat/browser/widget/dispatchCompletedResponse.ts'));

const text = words => ({ text: words });
const step = name => ({ step: name });
const fold = nodes => m.splitCompletedResponseSteps(nodes, node => 'text' in node);

test('a long answer before more tools and a short last line stays outside the fold (task-hlkrw)', () => {
	// What the person saw: "Completed 12 steps" and only "Nothing new …"; the long answer was behind the fold.
	const answer = text('Here is the full plan: A keeps the board, B moves it to the right panel …');
	const before = [step('read'), step('grep'), answer, step('notify'), step('board')];
	const runs = fold(before);
	assert.deepEqual(runs, [[step('read'), step('grep')], [step('notify'), step('board')]]);
	assert.ok(runs.every(run => !run.includes(answer)));
});

test('every text stays outside, in order, and the steps between them fold in runs', () => {
	const nodes = [text('Looking at the renderer.'), step('a'), step('b'), text('Found it.'), step('c'), text('Fixed.'), step('d'), step('e')];
	assert.deepEqual(fold(nodes), [[step('a'), step('b')], [step('c')], [step('d'), step('e')]]);
});

test('nothing to fold when there are only texts, and one run when there are no texts', () => {
	assert.deepEqual(fold([text('a'), text('b')]), []);
	assert.deepEqual(fold([]), []);
	assert.deepEqual(fold([step('a'), step('b')]), [[step('a'), step('b')]]);
});

test('white space is not text for the person', () => {
	assert.equal(m.isTextForPerson('Nothing new from that last notification.'), true);
	assert.equal(m.isTextForPerson('\n\n  '), false);
	assert.equal(m.isTextForPerson(''), false);
});
