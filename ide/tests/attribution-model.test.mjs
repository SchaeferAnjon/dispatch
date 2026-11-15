import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerHooks } from 'node:module';

// the model's strings go through VS Code's nls, which needs the workbench: English as written, {n} filled in
const NLS = 'data:text/javascript,' + encodeURIComponent('export function localize(_k, s, ...a) { return s.replace(/\\{(\\d+)\\}/g, (_, i) => String(a[i])); }');
registerHooks({ resolve: (spec, ctx, next) => /(^|\/)nls\.js$/.test(spec) ? { url: NLS, shortCircuit: true } : next(spec, ctx) });

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchAttribution/browser/dispatchAttributionModel.ts'));

const counts = (over = {}) => ({ tracked: true, agents: ['OpenCode'], you: 0, mix: 0, unsure: 0, other: 0, ai: 0, ...over });

test('a line nobody in Dispatch wrote gets the dashed block, not the person (task-m6hek)', () => {
	assert.equal(m.markOf({ from: 1, to: 1, who: 'other' }), 'other');
	assert.equal(m.markOf({ from: 1, to: 1, who: 'you' }), 'you');
	assert.equal(m.markOf({ from: 1, to: 1, who: 'ai' }), undefined);
});

test('its hover says only that no agent of Dispatch wrote it: no time, no "told to keep it"', () => {
	const h = m.hoverOf({ from: 1, to: 3, who: 'other', told: 'OpenCode' });
	assert.equal(h.title, 'Not from an agent in Dispatch');
	assert.deepEqual(h.lines, []);
});

test('a file only a tool changed gets no person on its row; your lines still do', () => {
	assert.equal(m.rowMark(counts({ other: 3 })), undefined);
	assert.equal(m.rowMark(counts({ other: 3, you: 1, ai: 4 })).mark, 'you');
	assert.match(m.rowMark(counts({ other: 3, you: 1, mix: 1 })).tip, /You changed 2 lines/);
});

test('the counts read "other" from the CLI\'s answer', () => {
	const files = m.parseAttributionFiles({ ok: true, files: { '/p/.beads/hooks/post-commit': { tracked: true, agents: [], counts: { other: 3 } } } });
	assert.equal(files.get('/p/.beads/hooks/post-commit').other, 3);
	assert.equal(files.get('/p/.beads/hooks/post-commit').you, 0);
});
