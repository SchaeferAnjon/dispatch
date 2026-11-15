import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchOnboarding/browser/dispatchOnboardingModel.ts'));
const ranges = await import(moduleAt('platform/chat/common/dispatchExternalRange.ts'));

test('recent projects are selected, risky and older folders stay optional', () => {
 const rows = [{ dir: '/recent', days: 3, reason: '' }, { dir: '/icloud', days: 2, reason: 'iCloud' }, { dir: '/older', days: 70, reason: '' }, { dir: '/archive', days: 300, reason: '' }];
 assert.deepEqual([...model.defaultFolderSelection(rows, 'last30Days')], ['/recent']);
 assert.deepEqual([...model.defaultFolderSelection(rows, 'last90Days')], ['/recent', '/older']);
 assert.deepEqual([...model.defaultFolderSelection(rows, 'allTime')], ['/recent', '/older', '/archive']);
});
test('uncertain preferences require an explicit choice', () => {
 const plan = { groups: [{ id: 'writing', items: [{ n: 1 }, { n: 2 }] }], look_items: [{ n: 3 }] };
 assert.deepEqual(model.prefPicks(plan, new Set(), new Set([2]), new Set()), [1]);
 assert.deepEqual(model.prefPicks(plan, new Set(['writing']), new Set(), new Set([3])), [3]);
 assert.equal(model.picksString([5, 2, 1, 2, 3]), '1-3,5');
});
test('90 days and all time affect both visibility and catalog retention', () => {
 const now = 400 * 86400000;
 assert.equal(ranges.externalSessionCutoff('last90Days', now), 310 * 86400000);
 assert.equal(ranges.externalCatalogCutoff('last90Days', now), 310 * 86400000);
 assert.equal(ranges.externalSessionCutoff('allTime', now), -Infinity);
 assert.equal(ranges.externalCatalogCutoff('allTime', now), -Infinity);
 assert.equal(ranges.externalCatalogCutoff('last7Days', now), 370 * 86400000);
});
const choices = { agents: [], range: 'last30Days', folders: [{ dir: '/one', name: 'one' }], picks: '' };
function host(answer) { return { ask: async (op, arg) => answer(op, arg), refresh: async () => {}, setExternalRange: async () => {} }; }
test('partial project failures are reported and can be retried', async () => {
 const states = [];
 const failures = await model.runSetup(host(op => op === 'register' ? { added: [{}], failed: [{ message: 'Board unavailable' }] } : { ok: true }), choices, (...s) => states.push(s), async () => {});
 assert.deepEqual(failures, ['projects']);
 assert.ok(states.some(s => s[0] === 'projects' && s[1] === 'failed'));
});
test('an interrupted index does not run dependent mutations', async () => {
 const calls = [];
 const failed = await model.runSetup(host(op => { calls.push(op); return { ok: true }; }), choices, () => {}, async () => { throw new Error('interrupted'); });
 assert.deepEqual(failed, ['index']); assert.deepEqual(calls, []);
});
test('a retry does not rerun successful steps', async () => {
 const calls = [];
 const failed = await model.runSetup(host(op => { calls.push(op); return { added: [{}], failed: [] }; }), choices, () => {}, async () => {}, new Set(['index', 'prepare', 'command']));
 assert.deepEqual(failed, []); assert.deepEqual(calls, ['register']);
});

test('first use has five pages while an explicit preference review stays reachable', () => {
 assert.deepEqual(model.onboardingSteps(true), ['agents', 'autonomy', 'appearance', 'notifications', 'rules']);
 assert.deepEqual(model.onboardingSteps(false), ['agents', 'projects', 'prefs', 'autonomy', 'appearance', 'notifications', 'rules']);
 assert.deepEqual(model.onboardingSteps(true, 'prefs'), ['agents', 'projects', 'prefs', 'autonomy', 'appearance', 'notifications', 'rules']);
});

const agents = await import(moduleAt('sessions/contrib/dispatchAgents/browser/dispatchAgentsModel.ts'));
const row = (id, runnable, installed, enabled) => ({ id, name: id, runnable, installed, enabled, path: '', version: '', account: '', install: '', sessions: null });
const rows = [row('claude', true, true, true), row('codex', true, true, true), row('opencode', true, false, true), row('gemini', false, true, false), row('aider', false, false, false)];
test('only the agents Dispatch runs, and the others found, are listed', () => {
 assert.deepEqual(agents.listedAgents(rows).map(r => r.id), ['claude', 'codex', 'opencode', 'gemini']);
});
test('switching one agent gives the two lists to save', () => {
 assert.deepEqual(agents.choiceAfterToggle(rows, 'codex', false), { off: ['codex'], on: [] });
 assert.deepEqual(agents.choiceAfterToggle(rows, 'gemini', true), { off: [], on: ['gemini'] });
});
test('the last agent Dispatch runs cannot be switched off', () => {
 const one = [row('claude', true, true, true), row('codex', true, true, false), row('opencode', true, false, false)];
 assert.equal(agents.isLastRunnable(one, 'claude'), true);
 assert.equal(agents.isLastRunnable(rows, 'claude'), false);
 assert.equal(agents.isLastRunnable(rows, 'gemini'), false);
});
test('the picker offers every agent until the choice says otherwise', () => {
 assert.equal(agents.isProviderEnabled(undefined, 'codex'), true);
 assert.equal(agents.isProviderEnabled({ off: ['codex'], on: [], saved: true }, 'codex'), false);
 assert.equal(agents.isProviderEnabled({ off: ['codex'], on: [], saved: true }, 'claude'), true);
 assert.equal(agents.isProviderEnabled({ off: ['codex'], on: [], saved: true }, 'copilotcli'), true);
 // kanban task-6vw2: with OpenCode the only one here, Claude Code and Codex are not offered; with none here, all are
 const onlyOpenCode = { off: [], on: [], default: '', saved: false, installed: ['opencode'], effective: 'opencode' };
 assert.deepEqual(['claude', 'codex', 'opencode', 'copilotcli'].map(id => agents.isProviderEnabled(onlyOpenCode, id)), [false, false, true, true]);
 const none = { off: [], on: [], default: '', saved: false, installed: [], effective: '' };
 assert.deepEqual(['claude', 'codex', 'opencode'].map(id => agents.isProviderEnabled(none, id)), [true, true, true]);
 assert.equal(agents.noAgentInstalled(none), true);
 assert.equal(agents.noAgentInstalled(onlyOpenCode), false);
 assert.equal(agents.noAgentInstalled({ off: [], on: [], default: '', saved: false }), false);
});
test('the wizard saves what was unticked and what was ticked, only for agents that are here', () => {
 assert.deepEqual(agents.wizardChoice(rows, new Set(['codex', 'opencode']), new Set(['gemini', 'aider'])), { off: ['codex'], on: ['gemini'], default: '' });
 assert.deepEqual(agents.wizardChoice(rows, new Set(), new Set()), { off: [], on: [], default: '' });
});
test('setup saves the choice of agents right after preparing, and a retry does not repeat it', async () => {
 const calls = [];
 const use = { off: ['codex'], on: ['gemini'], default: 'claude' };
 const states = [];
 await model.runSetup(host((op, arg) => { calls.push([op, arg]); return { ok: true }; }), { ...choices, folders: [], use }, (...s) => states.push(s), async () => {});
 assert.deepEqual(calls.slice(0, 2), [['apply-dir', undefined], ['agents-use', use]]);
 assert.ok(model.setupSteps({ ...choices, folders: [], use }).some(s => s.id === 'agents'));
 assert.ok(!model.setupSteps({ ...choices, folders: [] }).some(s => s.id === 'agents'));
 const again = [];
 await model.runSetup(host(op => { again.push(op); return { ok: true }; }), { ...choices, folders: [], use }, () => {}, async () => {}, new Set(['index', 'prepare', 'agents']));
 assert.ok(!again.includes('agents-use'));
});
test('a refused choice fails its step and stops nothing else', async () => {
 const failed = await model.runSetup(host(op => op === 'agents-use' ? { ok: false, message: 'Keep at least one agent on.' } : { ok: true }), { ...choices, folders: [], use: { off: ['claude', 'codex', 'opencode'], on: [], default: '' } }, () => {}, async () => {});
 assert.deepEqual(failed, ['agents']);
});
test('the default agent is the one chosen while it is here and on, else the first', () => {
 assert.equal(agents.effectiveDefault(['claude', 'codex'], 'codex'), 'codex');
 assert.equal(agents.effectiveDefault(['claude', 'codex'], 'opencode'), 'claude');
 assert.equal(agents.effectiveDefault([], 'codex'), '');
 // the wizard keeps the chosen default only when that agent is still ticked and here
 assert.equal(agents.wizardChoice(rows, new Set(), new Set(), 'codex').default, 'codex');
 assert.equal(agents.wizardChoice(rows, new Set(['codex']), new Set(), 'codex').default, '');
 assert.equal(agents.wizardChoice(rows, new Set(), new Set(), 'opencode').default, '');
});
test('rows follow the default after a switch', () => {
 const flagged = rows.map(r => ({ ...r, is_default: r.id === 'claude' }));
 assert.deepEqual(agents.recomputeDefault(flagged.map(r => r.id === 'claude' ? { ...r, enabled: false } : r), '').filter(r => r.is_default).map(r => r.id), ['codex']);
 assert.deepEqual(agents.recomputeDefault(flagged, 'codex').filter(r => r.is_default).map(r => r.id), ['codex']);
});

const firstRun = await import(moduleAt('sessions/contrib/dispatchAgents/browser/dispatchFirstRunModel.ts'));
const autonomy = { level: 'ask-every', saved: false, ide_approvals: 'manual', levels: [{ id: 'ask-every' }, { id: 'ask-risky' }, { id: 'auto' }] };
test('how much agents may do on their own: the chosen level, else the saved one, else the default (Full auto, the user\'s call on 2026-10-01)', () => {
 assert.equal(firstRun.DEFAULT_AUTONOMY, 'auto');
 assert.equal(firstRun.chosenAutonomy('', autonomy), autonomy.level);
 assert.equal(firstRun.chosenAutonomy('auto', autonomy), 'auto');
 assert.equal(firstRun.chosenAutonomy('yolo', autonomy), autonomy.level);
 assert.equal(firstRun.chosenAutonomy('', { ...autonomy, level: 'ask-risky', saved: true }), 'ask-risky');
 assert.equal(firstRun.chosenAutonomy('auto', undefined), 'auto');
 assert.equal(firstRun.chosenAutonomy('', undefined), 'auto');
});
test('the first-run texts are plain words', () => {
 const words = [firstRun.NOTIFY_TEXT.title, firstRun.NOTIFY_TEXT.detail, firstRun.AWAKE_TEXT.title, firstRun.AWAKE_TEXT.detail, ...firstRun.THEME_CHOICES.flatMap(t => [t.title, t.detail])].join(' ');
 assert.ok(!/\b(PATH|CLI|daemon|caffeinate|YOLO|chatd)\b/.test(words), words);
 assert.ok(firstRun.AWAKE_TEXT.detail.includes('Closing the lid still puts a MacBook to sleep'));
 assert.deepEqual(firstRun.THEME_CHOICES.map(t => t.mode), ['system', 'light', 'dark']);
});
test('setup saves autonomy, notifications and keep awake only as asked, after the agents', async () => {
 const calls = [];
 const c = { ...choices, folders: [], use: { off: [], on: [], default: '' }, autonomy: 'auto', notify: true, awake: false };
 await model.runSetup(host((op, arg) => { calls.push([op, arg]); return { ok: true }; }), c, () => {}, async () => {});
 assert.deepEqual(calls.slice(0, 5).map(x => x[0]), ['apply-dir', 'agents-use', 'autonomy-set', 'notify-set', 'awake-set']);
 assert.deepEqual(calls[2][1], { level: 'auto' });
 assert.deepEqual(calls[4][1], { on: false });
 assert.deepEqual(model.setupSteps(c).map(s => s.id).slice(0, 6), ['index', 'prepare', 'agents', 'autonomy', 'notify', 'awake']);
 const plain = model.setupSteps({ ...choices, folders: [], autonomy: 'ask-every', notify: false, awake: true }).map(s => s.id);
 assert.ok(plain.includes('autonomy') && !plain.includes('notify') && !plain.includes('awake'));
});
test('the name on commits is saved after the permissions, only when it was asked for (task-pog4t)', async () => {
 const calls = [];
 const who = { name: 'Ada Lovelace', email: 'ada@lovelace.dev' };
 const c = { ...choices, folders: [], use: { off: [], on: [], default: '' }, autonomy: 'auto', gitIdentity: who };
 await model.runSetup(host((op, arg) => { calls.push([op, arg]); return { ok: true }; }), c, () => {}, async () => {});
 assert.deepEqual(calls.slice(0, 4).map(x => x[0]), ['apply-dir', 'agents-use', 'autonomy-set', 'git-identity-set']);
 assert.deepEqual(calls[3][1], who);
 assert.deepEqual(model.setupSteps(c).map(s => s.id).slice(0, 5), ['index', 'prepare', 'agents', 'autonomy', 'identity']);
 assert.ok(!model.setupSteps({ ...c, gitIdentity: undefined }).some(s => s.id === 'identity'));
});

test('the answer to how much agents may do on their own reaches Claude Code\'s own approvals setting', () => {
 assert.equal(firstRun.claudePermissionModeFor('manual', false), '');
 assert.equal(firstRun.claudePermissionModeFor('assisted', false), 'acceptEdits');
 assert.equal(firstRun.claudePermissionModeFor('allowAll', false), 'bypassPermissions');
 assert.equal(firstRun.claudePermissionModeFor('allowAll', true), '', 'an enterprise policy keeps the safe level');
 assert.equal(firstRun.claudePermissionModeFor(undefined, false), '');
});

test('Full auto reaches Codex\'s own approvals setting too (task-ngwit)', () => {
 assert.equal(firstRun.codexPermissionsPresetFor('allowAll', false), 'full-access');
 assert.equal(firstRun.codexPermissionsPresetFor('assisted', false), '', 'Codex keeps its default: it asks before anything wider than the project');
 assert.equal(firstRun.codexPermissionsPresetFor('manual', false), '');
 assert.equal(firstRun.codexPermissionsPresetFor('allowAll', true), '', 'an enterprise policy keeps the safe level');
});

test('someone who went on before the history was read lands on agent permissions once a new person is known, not on the last page', () => {
 assert.equal(model.stepAfterHistoryRead(true, 'projects'), 'autonomy');
 assert.equal(model.stepAfterHistoryRead(true, 'prefs'), 'autonomy');
 assert.equal(model.stepAfterHistoryRead(true, 'autonomy'), undefined);
 assert.equal(model.stepAfterHistoryRead(false, 'projects'), undefined);
 assert.equal(model.stepAfterHistoryRead(true, 'agents'), undefined);
});

test('the setup steps speak plainly: no PATH, hooks named for what they do (kanban task-d5n3c)', () => {
 const steps = model.setupSteps({ ...choices, use: { off: [], on: [], default: '' }, autonomy: 'auto', notify: true, awake: true });
 const command = steps.find(s => s.id === 'command');
 assert.equal(command.label, 'Making the dispatch command work in Terminal');
 for (const s of steps) {
  assert.doesNotMatch(s.label, /\bPATH\b|\bCLI\b|worktree|daemon|chatd/i, s.label);
 }
});
