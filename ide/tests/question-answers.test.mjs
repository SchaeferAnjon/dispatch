import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const q = await import(moduleAt('workbench/contrib/chat/browser/widget/chatContentParts/dispatchQuestionAnswer.ts'));

function box(text) {
	const box = { text, read: () => box.text, clear: () => { box.text = ''; } };
	return box;
}

test('what was typed in the message box is the answer, and the box empties (task-lj06.15)', () => {
	const input = box('  Purple ');
	const sent = [];
	assert.equal(q.takeTypedAnswer(input, text => { sent.push(text); return true; }), true);
	assert.deepEqual(sent, ['Purple']);
	assert.equal(input.text, '');
});

test('nothing typed, a slash command, or a card no longer waiting: the card answers as it would', () => {
	for (const text of ['', '   ', '/neat-freak']) {
		const input = box(text);
		assert.equal(q.takeTypedAnswer(input, () => { throw new Error('not an answer'); }), false, JSON.stringify(text));
		assert.equal(input.text, text);
	}
	const input = box('Do not fix anything');
	assert.equal(q.takeTypedAnswer(input, () => false), false);
	assert.equal(input.text, 'Do not fix anything', 'the words stay when the card did not take them');
	assert.equal(q.takeTypedAnswer(undefined, () => true), false);
});

test('the card no longer picks its first option for the person, and Submit reads the message box first', async () => {
	const fs = await import('node:fs');
	const root = src ? path.join(src, 'src/vs') : new URL('../vscode/src/vs/', import.meta.url).pathname;
	const part = fs.readFileSync(path.join(root, 'workbench/contrib/chat/browser/widget/chatContentParts/chatQuestionCarouselPart.ts'), 'utf8');
	assert.ok(!/if no default and no freeform text, select the first answer/.test(part), 'the first option is not selected on its own');
	for (const name of ['handleNextOrSubmit', 'submit']) {
		const body = part.slice(part.indexOf(`private ${name}(): void {`), part.indexOf(`private ${name}(): void {`) + 400);
		assert.match(body, /takeTypedAnswer\(\)[\s\S]*saveCurrentAnswer\(\)[\s\S]*nothingChosen\(\)/, name);
	}
	const input = fs.readFileSync(path.join(root, 'workbench/contrib/chat/browser/widget/input/chatInputPart.ts'), 'utf8');
	assert.match(input, /part\.typedAnswer = \{ read: /);
	assert.match(input, /KeyCode\.Enter && \(e\.metaKey \|\| e\.ctrlKey\) && this\.questionCarousel\?\.takeTypedAnswer\(\)/);
});
