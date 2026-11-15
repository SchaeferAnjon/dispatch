import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// the patched Code - OSS source: ../vscode, or DISPATCH_VSCODE_SOURCE in a worktree that has none of its own
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { machineWindowTitle, machineIndicator, connectionStep, parsePreparation, connectionHistory } = await import(moduleAt('workbench/services/remote/common/dispatchMachineState.ts'));

test('the two modes name the destination machine', () => {
 assert.equal(machineWindowTitle(true, 'mini'), 'Dispatch Agent · mini');
 assert.equal(machineWindowTitle(false, 'mini'), 'Dispatch IDE · mini');
 assert.equal(machineWindowTitle(true, ''), 'Dispatch Agent');
});
test('the indicator distinguishes connecting, reconnecting, offline and recovery', () => {
 assert.equal(machineIndicator('mini', 'connecting'), '$(vm) Connecting to mini...');
 assert.equal(machineIndicator('mini', 'reconnecting'), '$(vm) Reconnecting to mini...');
 assert.equal(machineIndicator('mini', 'disconnected'), '$(vm) mini · offline');
 assert.equal(machineIndicator('mini', 'connected'), '$(vm) mini');
});
test('shared preparation reports each step and rejects stale or malformed records', () => {
 const r = { name: 'mini', host: 'mini', at: 100, stage: 'starting-server' };
 assert.deepEqual(parsePreparation(JSON.stringify(r), 101), r);
 assert.equal(parsePreparation(JSON.stringify(r), 300101), undefined);
 assert.equal(parsePreparation('{bad', 101), undefined);
 assert.equal(parsePreparation(JSON.stringify({ ...r, stage: 'execute' }), 101), undefined);
 assert.equal(connectionStep('finding'), 'Finding machine');
 assert.equal(connectionStep('connecting'), 'Connecting');
 assert.equal(connectionStep('starting-server'), 'Starting server');
 for (const stage of ['failed', 'cancelled', 'ready']) assert.equal(parsePreparation(JSON.stringify({ ...r, stage }), 101).stage, stage);
});
test('disconnect time is stable while retrying, then clears on recovery', () => {
 let h = { everConnected: false };
 h = connectionHistory('connecting', h, 1);
 assert.deepEqual(h, { everConnected: false });
 h = connectionHistory('connected', h, 2);
 h = connectionHistory('reconnecting', h, 3);
 assert.equal(h.lostAt, 3);
 h = connectionHistory('disconnected', h, 4);
 assert.equal(h.lostAt, 3);
 h = connectionHistory('connected', h, 5);
 assert.equal(h.lostAt, undefined);
 h = connectionHistory('reconnecting', h, 6);
 assert.equal(h.lostAt, 6);
});

const { remoteAgentsWorkspacePath, belongsToMachine, machineStorageKey } = await import(moduleAt('platform/window/common/dispatchRemoteAgents.ts'));
test('Agents workspace identities cannot alias the local window or another remote', () => {
 const base = '/user/agents.code-workspace';
 assert.notEqual(remoteAgentsWorkspacePath(base, 'ssh-remote+mini'), base);
 assert.notEqual(remoteAgentsWorkspacePath(base, 'ssh-remote+mini'), remoteAgentsWorkspacePath(base, 'ssh-remote+studio'));
 assert.ok(!remoteAgentsWorkspacePath(base, '../escape').slice(base.length).includes('/'));
});
test('a remote Agent only accepts directories on its connected machine', () => {
 const remote = { scheme: 'vscode-remote', authority: 'ssh-remote+mini' };
 assert.equal(belongsToMachine(remote, 'ssh-remote+mini'), true);
 assert.equal(belongsToMachine(remote, 'ssh-remote+studio'), false);
 assert.equal(belongsToMachine({ scheme: 'file', authority: '' }, 'ssh-remote+mini'), false);
 assert.equal(belongsToMachine(remote, undefined), false);
 assert.equal(belongsToMachine({ scheme: 'file', authority: '' }, undefined), true);
});

test('remote caches and legacy automations cannot overwrite local application storage', () => {
 for (const key of ['localAgentHost.cachedSessions.v2', 'automation.local']) {
  assert.equal(machineStorageKey(key, undefined), key);
  assert.notEqual(machineStorageKey(key, 'ssh-remote+mini'), key);
  assert.notEqual(machineStorageKey(key, 'ssh-remote+mini'), machineStorageKey(key, 'ssh-remote+studio'));
 }
});
