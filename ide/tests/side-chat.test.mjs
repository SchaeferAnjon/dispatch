// A side chat split off a reply (kanban, 2026-10-10): its answer is not lost to a result the CLI produced for a turn
// of its own, it starts without the person's MCP servers and the session brief, and its changes pill counts only
// what it changed itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const at = rel => import(pathToFileURL(path.join(vs, rel)));
const { isResultForSentPrompt } = await at('platform/agentHost/node/claude/claudeResultOwner.ts');
const { sideChatLaunch, DISPATCH_SIDE_CHAT_ENV } = await at('platform/agentHost/node/claude/claudeSideChatLaunch.ts');
const { sumChatOwnChanges } = await at('sessions/contrib/chat/common/dispatchChatOwnChanges.ts');

test('the result of a task notification the CLI queued on resume does not end our prompt', () => {
	// what Claude Code 2.1.296 printed resuming a forked conversation whose source had three background agents running:
	// this result came first, then the one for the prompt we sent
	const notification = { type: 'result', subtype: 'success', num_turns: 0, origin: { kind: 'task-notification' }, user_message_uuid: null };
	const ours = { type: 'result', subtype: 'success', num_turns: 0, origin: null, user_message_uuid: null };
	assert.equal(isResultForSentPrompt(notification), false);
	assert.equal(isResultForSentPrompt(ours), true);
	assert.equal(isResultForSentPrompt({}), true, 'an older CLI says nothing: ours, as before');
	assert.equal(isResultForSentPrompt({ origin: { kind: 'human' } }), true);
	assert.equal(isResultForSentPrompt({ origin: { kind: 'auto-continuation' } }), false);
});

test('a side chat starts with only the MCP servers passed in and tells the hooks it is one', () => {
	assert.deepEqual(sideChatLaunch(true), { strictMcpConfig: true, env: { [DISPATCH_SIDE_CHAT_ENV]: '1' } });
	assert.deepEqual(sideChatLaunch(false), { env: {} });
	assert.deepEqual(sideChatLaunch(undefined), { env: {} });
	assert.equal(DISPATCH_SIDE_CHAT_ENV, 'DISPATCH_SIDE_CHAT', 'app/cli/hook.py reads this name');
});

test('a chat that changed nothing shows no changes; a file changed in two turns counts once', () => {
	assert.deepEqual(sumChatOwnChanges([]), { files: 0, insertions: 0, deletions: 0 });
	assert.deepEqual(sumChatOwnChanges([[], []]), { files: 0, insertions: 0, deletions: 0 });
	const a = { toString: () => 'file:///p/a.ts' }, b = { toString: () => 'file:///p/b.ts' };
	assert.deepEqual(sumChatOwnChanges([
		[{ modifiedURI: a, added: 10, removed: 2 }],
		[{ modifiedURI: a, added: 3, removed: 0 }, { modifiedURI: b, added: 1, removed: 1 }],
	]), { files: 2, insertions: 14, deletions: 3 });
});

test('the hook skips the brief by that name', async () => {
	const { readFileSync } = await import('node:fs');
	const hook = readFileSync(new URL('../../app/cli/hook.py', import.meta.url), 'utf8');
	assert.match(hook, /os\.environ\.get\("DISPATCH_SIDE_CHAT"\)/);
});
