import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Turbo hands the engine's own command line a model name it knows (2026-11-12, task-cq11p): the window's picker ids
// ("@provider=anthropic:sonnet") made every plan from the new-session page fail with "unrecognized_model".
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const M = await import(moduleAt('sessions/contrib/dispatchTurbo/browser/dispatchTurboHooks.ts'));

test('the model name Turbo passes on is the engine\'s own', () => {
	assert.equal(M.turboModelOf('claude', '@provider=anthropic:sonnet'), 'sonnet');
	assert.equal(M.turboModelOf('codex', '@provider=openai:gpt-6'), 'gpt-6');
	assert.equal(M.turboModelOf('opencode', '@provider=deepseek:deepseek-flash'), 'deepseek/deepseek-flash');
	assert.equal(M.turboModelOf('opencode', 'deepseek/deepseek-flash'), 'deepseek/deepseek-flash', 'a name already in the engine\'s form stays');
	assert.equal(M.turboModelOf('claude', 'auto'), undefined);
	assert.equal(M.turboModelOf('claude', undefined), undefined);
});
