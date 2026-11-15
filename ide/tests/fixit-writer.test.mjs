import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchFixit/browser/dispatchFixitWriter.ts'));

const session = (sessionType, scheme, model) => ({ sessionType, resource: { scheme }, modelId: { get: () => model } });

test('the session\'s own agent and model write its commit message (task-dekzn)', () => {
	assert.deepEqual(m.writerOf(session('agent-host-opencode', 'agent-host-opencode', 'agent-host-opencode:deepseek/deepseek-v4-flash')),
		{ engine: 'opencode', model: 'deepseek/deepseek-v4-flash' });
	assert.deepEqual(m.writerOf(session('agent-host-claude', 'agent-host-claude', 'agent-host-claude:claude-sonnet-5')), { engine: 'claude', model: 'claude-sonnet-5' });
	assert.deepEqual(m.writerOf(session('agent-host-codex', 'agent-host-codex', undefined)), { engine: 'codex', model: '' });
	// a model id with a colon of its own keeps it
	assert.deepEqual(m.writerOf(session('agent-host-opencode', 'agent-host-opencode', 'ollama/llama3:8b')), { engine: 'opencode', model: 'ollama/llama3:8b' });
	// another kind of session: nothing, the CLI picks as before
	assert.deepEqual(m.writerOf(session('copilot-cli', 'copilot-cli', 'gpt-5')), { engine: '', model: '' });
});
