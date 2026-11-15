import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchTurbo/browser/dispatchTurboModel.ts'));

const NOW = 1_800_000_000;
const min = m => m * 60;

/** A run of `count` parts: the first `combined` went in, the next `working` are at it, the rest wait. */
function run(count, { combined = 0, working = 0, state = 'running', after = {} } = {}) {
	const parts = [];
	const forecast = {};
	for (let n = 1; n <= count; n++) {
		const p = { n, name: `Part ${n}`, est: 20, status: 'waiting', after: after[n] };
		if (n <= combined) {
			Object.assign(p, { status: 'combined', started_at: NOW - min(90) + min(n), combined_at: NOW - min(60) + min(n), combined_n: n, segs: [[NOW - min(90) + min(n), NOW - min(60) + min(n), 'work']] });
		} else if (n <= combined + working) {
			Object.assign(p, { status: 'working', started_at: NOW - min(10), segs: [[NOW - min(10), NOW, 'work']] });
		}
		forecast[String(n)] = n <= combined + working ? [NOW - min(10), NOW + min(10)] : [NOW + min(10 * (n - combined - working)), NOW + min(10 * (n - combined - working) + 20)];
		parts.push(p);
	}
	return { id: 'r1', state, title: 'Big job', parts, finals: [], forecast: { parts: forecast, finals: {}, done_at: NOW + min(300) }, now: NOW, combined, total: count };
}

test('a run with a few parts is one lane a part', () => {
	const items = model.laneItems(run(6, { combined: 2, working: 2 }));
	assert.equal(items.length, 6);
	assert.ok(items.every(i => i.kind === 'part'));
});

test('28 parts fold the combined and the not started into one row each, the working ones stay lanes', () => {
	const items = model.laneItems(run(28, { combined: 12, working: 4 }));
	assert.deepEqual(items.map(i => i.kind === 'fold' ? `fold-${i.key}:${i.parts.length}` : i.part.n), ['fold-combined:12', 13, 14, 15, 16, 'fold-later:12']);
	assert.ok(items.filter(i => i.kind === 'fold').every(i => !i.open));
});

test('an opened fold keeps its row and its parts follow it', () => {
	const items = model.laneItems(run(28, { combined: 12, working: 4 }), new Set(['fold-later']));
	assert.equal(items.length, 1 + 4 + 1 + 12);
	const later = items.findIndex(i => i.kind === 'fold' && i.key === 'later');
	assert.equal(items[later].open, true);
	assert.deepEqual(items.slice(later + 1).map(i => i.part.n), [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
});

test('a plan is never folded: every part is shown before Start', () => {
	const items = model.laneItems(run(28, { state: 'planned' }));
	assert.equal(items.length, 28);
});

test('right after Start, before any part started, nothing is folded', () => {
	const items = model.laneItems(run(28));
	assert.equal(items.length, 28);
	assert.ok(items.every(i => i.kind === 'part'));
});

test('one combined part alone is not a fold', () => {
	const items = model.laneItems(run(12, { combined: 1, working: 2 }));
	assert.equal(items[0].kind, 'part');
	assert.equal(items.at(-1).kind, 'fold');
});

test('a fold sits from the first start to the last one in, the later ones over their forecast', () => {
	const r = run(28, { combined: 12, working: 4 });
	const combined = r.parts.filter(p => p.status === 'combined');
	assert.deepEqual(model.foldSpan(r, combined, 'combined'), [NOW - min(89), NOW - min(48)]);
	const later = r.parts.filter(p => p.status === 'waiting');
	assert.deepEqual(model.foldSpan(r, later, 'later'), [NOW + min(10), NOW + min(140)]);
});

test('a part that waits for another hooks from where the other ends to where it starts', () => {
	const r = run(4, { state: 'planned', after: { 4: [1] } });
	assert.deepEqual(model.dependencies(r), [{ from: 1, to: 4, fromAt: r.forecast.parts['1'][1], toAt: r.forecast.parts['4'][0] }]);
	// once the other went in, the hook starts there
	const r2 = run(4, { combined: 1, after: { 4: [1] } });
	assert.equal(model.dependencies(r2)[0].fromAt, r2.parts[0].combined_at);
	// a part that started needs no hook any more
	r2.parts[3].started_at = NOW;
	assert.deepEqual(model.dependencies(r2), []);
});

test('Turbo plans with the agent picked in the input box (task-o8wx)', async () => {
	const hooks = await import(moduleAt('sessions/contrib/dispatchTurbo/browser/dispatchTurboHooks.ts'));
	assert.equal(hooks.turboEngineOf('agent-host-opencode'), 'opencode');
	assert.equal(hooks.turboEngineOf('agent-host-claude'), 'claude');
	assert.equal(hooks.turboEngineOf('remote-mini.local-codex'), 'codex');
	assert.equal(hooks.turboEngineOf('copilot'), undefined);
	assert.equal(hooks.turboEngineOf(undefined), undefined);
});

test('a plan never says more at a time than it has parts (task-npkp3)', () => {
	const plan = { ...run(2, { state: 'planned' }), slots: 4, plan: { done_words: 'Done around 03:21' } };
	assert.equal(model.runSentence(plan), '2 parts · 2 at a time · Done around 03:21');
	// one part runs alone: no "at a time", and never "1 parts" (task-lj06.29)
	assert.equal(model.runSentence({ ...run(1, { state: 'planned' }), slots: 4, plan: { done_words: 'Done around 03:21' } }), '1 part · Done around 03:21');
	assert.equal(model.runSentence({ ...run(1, { state: 'done' }), summary: { minutes: 3 } }), 'Done · 1 part in 3 min');
	assert.equal(model.runSentence({ ...run(3, { state: 'done' }), summary: { minutes: 12 } }), 'Done · 3 parts in 12 min');
	assert.equal(model.runSentence({ ...run(6, { state: 'planned' }), slots: 4, plan: { done_words: 'Done around 04:00' } }), '6 parts · 4 at a time · Done around 04:00');
});

// ---------------------------------------------------------------- the person's own sessions (design/timeline-design)

function lane(id, project, startMin, endMin, extra = {}) {
	return { id, name: `Session ${id}`, project, status: 'done', kind: 'session', segs: [[NOW - min(startMin), NOW - min(endMin), 'work']], ...extra };
}

test('sessions are grouped by project, the project that worked last first, in the order they started', () => {
	const items = model.sessionItems([
		lane('a', 'notes', 60, 50),
		lane('b', 'kanban', 30, 0, { status: 'working' }),
		lane('c', 'kanban', 90, 70),
	], NOW);
	assert.deepEqual(items.map(i => i.kind === 'group' ? `#${i.project}` : i.lane.id), ['#kanban', 'c', 'b', '#notes', 'a']);
});

test('helpers fold into their session; opened they follow it as rows', () => {
	const lanes = [lane('a', 'kanban', 60, 10, { helpers: 2 }), { ...lane('h1', 'kanban', 50, 40), kind: 'helper', parent: 'a' }, { ...lane('h2', 'kanban', 30, 20), kind: 'helper', parent: 'a' }];
	const shut = model.sessionItems(lanes, NOW);
	assert.deepEqual(shut.map(i => i.kind), ['group', 'session']);
	assert.equal(shut[1].helpers.length, 2);
	const open = model.sessionItems(lanes, NOW, new Set(['h-a']));
	assert.deepEqual(open.map(i => i.kind === 'group' ? 'group' : `${i.kind}:${i.lane.id}`), ['group', 'session:a', 'helper:h1', 'helper:h2']);
});

test('two or more sessions of a project that last worked over two hours ago fold into one row in front of the recent ones', () => {
	const lanes = [lane('old1', 'kanban', 400, 380), lane('old2', 'kanban', 300, 290), lane('new', 'kanban', 50, 5), lane('lone', 'notes', 300, 280)];
	const items = model.sessionItems(lanes, NOW);
	assert.deepEqual(items.map(i => i.kind === 'group' ? `#${i.project}` : i.kind === 'fold' ? `fold:${i.lanes.length}` : i.lane.id), ['#kanban', 'fold:2', 'new', '#notes', 'lone']);
	const open = model.sessionItems(lanes, NOW, new Set(['fold-kanban']));
	assert.deepEqual(open.filter(i => i.kind === 'session').map(i => `${i.lane.id}${i.inFold ? '*' : ''}`), ['old1*', 'old2*', 'new', 'lone']);
});

test('the sessions page says how many sessions, how many work now, helpers and projects', () => {
	const head = model.sessionsHead([lane('a', 'kanban', 60, 0, { status: 'working' }), lane('b', 'notes', 60, 30), { ...lane('h', 'kanban', 50, 40), kind: 'helper', parent: 'a' }]);
	assert.deepEqual(head, { title: '2 sessions in the last 8 hours', line: '1 working now · 1 helper · 2 projects' });
	assert.equal(model.sessionsHead([]).title, 'No sessions in the last 8 hours');
});

test('ten parts are ten lanes, as proto-a draws them; more than ten fold', () => {
	assert.ok(model.laneItems(run(10, { combined: 2, working: 4 })).every(i => i.kind === 'part'));
	assert.ok(model.laneItems(run(12, { combined: 2, working: 4 })).some(i => i.kind === 'fold'));
});
