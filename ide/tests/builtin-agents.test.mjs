import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchCustomizations/browser/dispatchBuiltinAgentsModel.ts'));

const home = '/Users/someone';
const agent = (name, states, enabled = true) => ({
	name, description: `${name} does things`, enabled, builtin: states.claude === 'current', path: `${home}/.dispatch/agents/${name}.md`, yours: [],
	engines: {
		claude: { state: states.claude, path: `${home}/.dispatch/agents/${name}.md` },
		codex: { state: states.codex, path: `${home}/.codex/agents/${name}.toml` },
		opencode: { state: states.opencode, path: `${home}/.config/opencode/agents/${name}.md` },
	},
});
const all = { claude: 'current', codex: 'current', opencode: 'current' };

test('the list marks Dispatch copies as Built-in, read through ~/.claude/agents too (task-wfpr5)', () => {
	const agents = [agent('engineer', all), agent('designer', { ...all, claude: 'yours' }), agent('tester', all, false)];
	assert.equal(model.builtinAgentFor(`${home}/.dispatch/agents/engineer.md`, agents)?.name, 'engineer');
	assert.equal(model.builtinAgentFor(`${home}/.claude/agents/engineer.md`, agents)?.name, 'engineer', 'Claude Code lists the link');
	assert.equal(model.builtinAgentFor(`${home}/.config/opencode/agents/engineer.md`, agents)?.name, 'engineer');
	assert.equal(model.builtinAgentFor(`${home}/.claude/agents/designer.md`, agents), undefined, 'your own designer is not marked');
	assert.equal(model.builtinAgentFor(`${home}/.config/opencode/agents/designer.md`, agents)?.name, 'designer', 'Dispatch\'s copy for OpenCode is');
	assert.equal(model.builtinAgentFor(`${home}/.dispatch/agents/tester.md`, agents), undefined, 'an agent that is off is not marked');
	assert.equal(model.builtinAgentFor(`${home}/.claude/agents/notes.md`, agents), undefined);
	assert.equal(model.builtinAgentFor(`${home}/.claude/agents/engineer.md`, undefined), undefined);
});

test('each card row says in plain words where the agent is (task-wfpr5)', () => {
	assert.equal(model.builtinAgentStatus(agent('engineer', all)), 'For Claude Code, Codex, OpenCode');
	assert.equal(model.builtinAgentStatus(agent('designer', { ...all, claude: 'yours' })), 'For Codex, OpenCode · your own designer is kept for Claude Code');
	assert.equal(model.builtinAgentStatus(agent('tester', { ...all, codex: 'removed' })), 'For Claude Code, OpenCode · you deleted it from Codex');
	assert.equal(model.builtinAgentStatus(agent('tester', all, false)), 'Off. Turn it on to add it to Claude Code, Codex, OpenCode.');
	assert.equal(model.builtinAgentStatus(agent('tester', { claude: 'yours', codex: 'yours', opencode: 'yours' })), 'Your own tester is kept for Claude Code, Codex, OpenCode');
});
