import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('platform/agentHost/node/opencode/opencodeSubagentSteps.ts'));

// recorded from OpenCode 1.18.34 (GLM 5.3 Flash): a task whose general sub-agent ran `ls` and `cat a.txt`
const lines = readFileSync(new URL('./fixtures/opencode-subagent-events.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const child = JSON.parse(readFileSync(new URL('./fixtures/opencode-subagent-child.json', import.meta.url), 'utf8'));
const CHILD = 'ses_eee7e4180ffe36YACxhpQXIaYJ';

test('the server\'s stream names a task\'s child session and carries the child\'s steps (task-4bkhf)', () => {
 const events = lines.map(m.parseStreamEvent).filter(Boolean);
 const tasks = events.filter(e => e.kind === 'part' && e.part.tool === 'task');
 assert.equal(m.childSessionOf(tasks[0].part), undefined, 'not while it is only pending');
 assert.equal(tasks.map(e => m.childSessionOf(e.part)).find(Boolean), CHILD);
 const steps = events.filter(e => e.kind === 'part' && e.sessionID === CHILD);
 assert.ok(steps.some(e => e.part.type === 'tool' && e.part.tool === 'bash' && e.part.state.status === 'completed'));
 assert.ok(events.some(e => e.kind === 'message' && e.sessionID === CHILD && e.role === 'user'));
 assert.equal(m.parseStreamEvent('data: {"payload":{"type":"server.heartbeat","properties":{}}}'), undefined);
});

test('a task\'s output names its child session too, in both OpenCode formats', () => {
 assert.equal(m.childSessionOf({ state: { output: '<task id="ses_abc123" state="completed">\n<task_result>x</task_result>\n</task>' } }), 'ses_abc123');
 assert.equal(m.childSessionOf({ state: { output: 'done\n<task_metadata>\nsession_id: ses_old9\n</task_metadata>' } }), 'ses_old9');
 assert.equal(m.childSessionOfUpdate({ sessionUpdate: 'tool_call_update', rawOutput: { output: 'x', metadata: { sessionId: 'ses_meta1' } } }, 'x'), 'ses_meta1');
 assert.equal(m.childSessionOf({ state: { output: 'nothing here' } }), undefined);
});

test('the child\'s messages become the updates its chat is made of after a restart: the prompt, thinking, two commands, the answer', () => {
 const u = m.messagesToUpdates(child);
 assert.equal(u[0].sessionUpdate, 'user_message_chunk');
 const calls = u.filter(x => x.sessionUpdate === 'tool_call');
 assert.deepEqual(calls.map(c => c.title), ['bash', 'bash']);
 const done = u.filter(x => x.sessionUpdate === 'tool_call_update');
 assert.ok(done.every(x => x.status === 'completed' && typeof x.rawOutput.output === 'string'));
 assert.ok(u.some(x => x.sessionUpdate === 'agent_thought_chunk'));
 assert.match(u.at(-1).content.text, /a\.txt/);
});

test('a failed tool says so and keeps its error as the output', () => {
 const u = m.toolPartUpdate({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', error: 'command not found' } }, false);
 assert.equal(u.status, 'failed');
 assert.equal(u.rawOutput.output, 'command not found');
 assert.equal(m.toolPartUpdate({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending' } }, true).sessionUpdate, 'tool_call');
});
