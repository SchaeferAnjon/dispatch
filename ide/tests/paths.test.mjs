import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const P = await import(moduleAt('sessions/contrib/dispatchCommon/common/dispatchPaths.ts'));

const HOME = '/Users/dev';
const ICLOUD = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`;

test('a folder is written the way Finder names it: ~ and iCloud Drive (task-8eudz)', () => {
	assert.equal(P.displayPath(`${HOME}/Projects/kanban`, HOME), '~/Projects/kanban');
	assert.equal(P.displayPath(`${HOME}/`, HOME), '~');
	assert.equal(P.displayPath(`${ICLOUD}/河湾大学/2026ss/Signals and Systems`, HOME), 'iCloud Drive/河湾大学/2026ss/Signals and Systems');
	assert.equal(P.displayPath(ICLOUD, HOME), 'iCloud Drive');
	// someone else's home is not ~; /Users/devx is not under /Users/dev
	assert.equal(P.displayPath('/Users/studio/Projects/后台', HOME), '/Users/studio/Projects/后台');
	assert.equal(P.displayPath('/Users/devx/a', HOME), '/Users/devx/a');
	assert.equal(P.displayPath('/tmp/x', undefined), '/tmp/x');
	// another app's iCloud container is not iCloud Drive's own folder
	assert.equal(P.displayPath(`${HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/vault`, HOME), '~/Library/Mobile Documents/iCloud~md~obsidian/Documents/vault');
});

test('the last folder is kept whole when the line cuts the path', () => {
	assert.deepEqual(P.splitPathTail('iCloud Drive/河湾大学/2026ss/Signals and Systems'), { head: 'iCloud Drive/河湾大学/2026ss/', tail: 'Signals and Systems' });
	assert.deepEqual(P.splitPathTail('~'), { head: '', tail: '~' });
	assert.equal(P.middlePath('~/Projects/kanban'), '~/Projects/kanban');
	assert.equal(P.middlePath('iCloud Drive/河湾大学/河湾大学兼职/some very long folder name/TUTOR', 40), 'iCloud Drive/…/some very long folder name/TUTOR');
});

test('a project without its folder says why instead of leaving the line empty', () => {
	const local = (dir, missing_dir) => P.projectPlace({ dir, host: 'local', machine: 'this Mac', missing_dir }, HOME);
	assert.deepEqual(local(`${HOME}/Projects/kanban`), { kind: 'mac', group: 'This Mac', note: '', path: '~/Projects/kanban', full: `${HOME}/Projects/kanban` });
	assert.equal(local(`${ICLOUD}/河湾大学/2025WS/ALG`).group, 'iCloud Drive');
	assert.deepEqual(local('', '/tmp/dbg/h/Probe'), { kind: 'missing', group: 'Not found', note: 'Folder missing', path: '/tmp/dbg/h/Probe', full: '/tmp/dbg/h/Probe' });
	assert.equal(local('', `${HOME}/Projects/gone`).path, '~/Projects/gone');
	assert.equal(local('', `${HOME}/Projects/gone`).note, 'Folder missing');
	assert.equal(local('', '/Users/apple/Projects/会议记录').note, 'Not on this Mac');
	assert.equal(local('', '/Users/apple/Projects/会议记录').path, '/Users/apple/Projects/会议记录');
	assert.equal(local('').note, 'No folder');
	const remote = P.projectPlace({ dir: '/Users/apple/Projects/后台', host: 'mini', machine: 'mini' }, HOME);
	assert.deepEqual(remote, { kind: 'remote', group: 'mini', note: 'mini', path: '~/Projects/后台', full: '/Users/apple/Projects/后台' });
});

test('groups by place come in a fixed order, and only show when there is more than one', () => {
	const rows = [
		{ name: 'gone', dir: '', host: 'local', machine: 'this Mac', missing_dir: '/tmp/x' },
		{ name: 'alg', dir: `${ICLOUD}/ALG`, host: 'local', machine: 'this Mac' },
		{ name: 'b', dir: '/Users/apple/b', host: 'studio', machine: 'Studio' },
		{ name: 'kanban', dir: `${HOME}/Projects/kanban`, host: 'local', machine: 'this Mac' },
		{ name: 'a', dir: '/Users/apple/a', host: 'mini', machine: 'mini' },
		{ name: 'harbor', dir: `${HOME}/Projects/harbor`, host: 'local', machine: 'this Mac' },
	];
	const groups = P.groupByPlace(rows, r => P.projectPlace(r, HOME));
	assert.deepEqual(groups.map(g => [g.name, g.items.map(r => r.name)]), [
		['This Mac', ['kanban', 'harbor']],
		['iCloud Drive', ['alg']],
		['mini', ['a']],
		['Studio', ['b']],
		['Not found', ['gone']],
	]);
	assert.equal(P.groupByPlace(rows.slice(3, 4), r => P.projectPlace(r, HOME)).length, 1);
});
