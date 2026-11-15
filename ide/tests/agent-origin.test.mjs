// The sub-agent menu and Customizations tell the engine's own agents from the ones someone wrote by what the engine
// reports (dispatchAgentOrigin.ts), not by a list of names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEngineBuiltinAgent, splitAgentsByOrigin, withoutBuiltinPrefix } from '../vscode/src/vs/sessions/contrib/dispatchCustomizations/common/dispatchAgentOrigin.ts';

test('an agent with an engine-internal address is built in, a file is not', () => {
	assert.equal(isEngineBuiltinAgent('claude-internal:/agent/Explore'), true);
	assert.equal(isEngineBuiltinAgent('claude-internal:/agent/claude-code-guide', 'Answers questions'), true);
	assert.equal(isEngineBuiltinAgent('file:///Users/me/.claude/agents/designer.md', 'Interface work'), false);
	assert.equal(isEngineBuiltinAgent('file:///Users/me/project/.claude/agents/Plan.md'), false, 'a file named like a built-in is still the user\'s');
	assert.equal(isEngineBuiltinAgent('vscode-agent-host://host/Users/me/.claude/agents/tester.md'), false);
});

test('a curated stand-in says (Built-In) before a session starts', () => {
	assert.equal(isEngineBuiltinAgent('some:/x', '(Built-In) Read-only search agent'), true);
	assert.equal(withoutBuiltinPrefix('(Built-In) Read-only search agent'), 'Read-only search agent');
	assert.equal(withoutBuiltinPrefix(undefined), undefined);
});

test('the split keeps the order inside each group', () => {
	const agents = ['animation-director', 'claude', 'designer', 'Explore', 'Plan', 'tester'].map(name =>
		({ name, uri: ['claude', 'Explore', 'Plan'].includes(name) ? `claude-internal:/agent/${name}` : `file:///a/${name}.md` }));
	const { builtin, custom } = splitAgentsByOrigin(agents, a => ({ uri: a.uri }));
	assert.deepEqual(builtin.map(a => a.name), ['claude', 'Explore', 'Plan']);
	assert.deepEqual(custom.map(a => a.name), ['animation-director', 'designer', 'tester']);
});

// Dispatch's own helper agents count as built in: the CLI's list (`dispatch builtin-agents`) says which file is
// Dispatch's unchanged copy; one the person edited ("yours") is theirs and stays custom.
const { agentOrigin, localPathOf } = await import('../vscode/src/vs/sessions/contrib/dispatchCustomizations/common/dispatchAgentOrigin.ts');
const { builtinAgentFor } = await import('../vscode/src/vs/sessions/contrib/dispatchCustomizations/browser/dispatchBuiltinAgentsModel.ts');
const home = '/Users/me';
const shipped = (name, state) => ({ name, description: '', enabled: true, builtin: true, path: `${home}/.dispatch/agents/${name}.md`, yours: [],
	engines: { claude: { state, path: `${home}/.dispatch/agents/${name}.md` }, codex: { state: 'current', path: `${home}/.codex/agents/${name}.toml` } } });
const list = [shipped('engineer', 'current'), shipped('tester', 'update'), shipped('designer', 'yours')];
const copy = path => !!builtinAgentFor(path, list);

test('Dispatch\'s copies are built in, an edited one and the person\'s own are custom', () => {
	assert.equal(agentOrigin(`file://${home}/.claude/agents/engineer.md`, 'Builds what a task asks for', copy), 'dispatch');
	assert.equal(agentOrigin(`file://${home}/.dispatch/agents/tester.md`, '', copy), 'dispatch');
	assert.equal(agentOrigin(`file://${home}/.claude/agents/designer.md`, '', copy), 'custom', 'designer was edited: it is the person\'s');
	assert.equal(agentOrigin(`file://${home}/.claude/agents/opus-max.md`, '', copy), 'custom');
	assert.equal(agentOrigin('claude-internal:/agent/Plan', '', copy), 'engine');
	assert.equal(agentOrigin(`file://${home}/.claude/agents/engineer.md`, ''), 'custom', 'without the list nothing is Dispatch\'s');
	assert.equal(agentOrigin(`vscode-agent-host://mini${home}/.claude/agents/engineer.md`, '', copy), 'custom', 'another Mac\'s file is not this Mac\'s copy');
});

test('the menu\'s Built-In group has the engine\'s agents, then Dispatch\'s', () => {
	const names = ['claude', 'designer', 'engineer', 'Explore', 'opus-max', 'tester'];
	const uri = n => ['claude', 'Explore'].includes(n) ? `claude-internal:/agent/${n}` : `file://${home}/.claude/agents/${n}.md`;
	const { builtin, custom } = splitAgentsByOrigin(names, n => ({ uri: uri(n) }), copy);
	assert.deepEqual(builtin, ['claude', 'Explore', 'engineer', 'tester']);
	assert.deepEqual(custom, ['designer', 'opus-max']);
});

test('a file: address is read back to its path, spaces and all', () => {
	assert.equal(localPathOf('file:///Users/me/My%20Agents/x.md'), '/Users/me/My Agents/x.md');
	assert.equal(localPathOf('claude-internal:/agent/Plan'), undefined);
});
