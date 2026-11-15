import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/providers/agentHost/browser/dispatchSwitchModel.ts'));

test('a first switch to a harness starts on the model its chip shows, not the harness default (task-lj06.22)', () => {
	const from = { from: 'agent-host-opencode:/a', type: 'agent-host-opencode', model: 'opencode:deepseek/deepseek-v4.1-flash' };
	assert.equal(m.dispatchSwitchModel({}, from, 'codex', 'codex:gpt-5.6-luna'), 'codex:gpt-5.6-luna');
	assert.equal(m.dispatchSwitchModel({}, undefined, 'codex', undefined), undefined);
});

test('switching back to a harness starts on the model the conversation ran on there', () => {
	const links = { 'codex:/b': { from: 'agent-host-opencode:/a', type: 'agent-host-opencode', model: 'opencode:deepseek/deepseek-v4.1-flash' } };
	const from = { from: 'codex:/b', type: 'codex', model: 'codex:gpt-5.6-luna' };
	assert.equal(m.dispatchSwitchModel(links, from, 'opencode', 'opencode:big-pickle'), 'opencode:deepseek/deepseek-v4.1-flash');
	// and on to Codex again: the Luna it ran on, not the chip's remembered one
	const links2 = { ...links, 'agent-host-opencode:/c': from };
	assert.equal(m.dispatchSwitchModel(links2, { from: 'agent-host-opencode:/c', type: 'agent-host-opencode', model: 'x' }, 'codex', 'codex:gpt-6-astra'), 'codex:gpt-5.6-luna');
});

test('a loop in the links ends', () => {
	const links = { a: { from: 'b', type: 'x' }, b: { from: 'a', type: 'y' } };
	assert.equal(m.dispatchSwitchModel(links, { from: 'a', type: 'y' }, 'codex', 'r'), 'r');
});

test('with no model named, a switched-to session starts on the model its harness declares the default, set before the first message', () => {
	const models = [
		{ identifier: 'codex:gpt-5.6-luna', metadata: { isDefaultForLocation: {} } },
		{ identifier: 'codex:gpt-6-astra', metadata: { isDefaultForLocation: { panel: true } } },
	];
	assert.equal(m.dispatchDefaultModel(models).identifier, 'codex:gpt-6-astra');
	assert.equal(m.dispatchDefaultModel([models[0]]).identifier, 'codex:gpt-5.6-luna');
	assert.equal(m.dispatchDefaultModel([]), undefined);
});
