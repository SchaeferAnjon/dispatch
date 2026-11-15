import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const c = await import(moduleAt('platform/agentHost/node/opencode/opencodeQuestionChoices.ts'));

test('a "Type your own answer" choice is the text box, not an empty answer (task-e04j)', () => {
	for (const label of ['Type your own answer', 'type your own answer…', 'Enter your own value', 'Write my own answer', 'Other', 'Other (please specify)', 'Something else', 'Custom answer', '其他', '自定义']) {
		assert.ok(c.isTypeYourOwnChoice(label), label);
	}
	for (const label of ['Test User <test@example.com>', 'Use my GitHub name', 'Other people can see it', 'Add a footer', 'Enter key submits', 'Customize later']) {
		assert.ok(!c.isTypeYourOwnChoice(label), label);
	}
});
