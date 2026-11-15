import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchNeat/browser/dispatchTidyModel.ts'));

test('the line under Tidy up after work says when and what in plain words (kanban task-uf2dy)', () => {
	const now = 1_800_000_000_000;
	const at = s => now / 1000 - s;
	assert.equal(model.tidyLastLine(undefined, now), '', 'nothing before the first check');
	assert.equal(model.tidyLastLine({ project: 'site', at: at(10), line: 'Everything matches', status: 'idle' }, now), 'Last check: site, just now. Everything matches');
	assert.equal(model.tidyLastLine({ project: 'site', at: at(7200), line: '3 docs disagree with the code', status: 'idle' }, now), 'Last check: site, 2 h ago. 3 docs disagree with the code');
	assert.equal(model.tidyLastLine({ project: 'site', at: at(60), status: 'running' }, now), 'Last check: site, running now.');
	assert.equal(model.tidyLastLine({ project: 'app', at: at(3 * 86400), line: 'OpenCode is not signed in', status: 'failed' }, now), 'Last check: app, 3 d ago. It did not finish: OpenCode is not signed in');
	assert.ok(model.tidyLastLine({ project: 'x', at: at(120), line: 'a'.repeat(400), status: 'idle' }, now).endsWith('…'));
});
