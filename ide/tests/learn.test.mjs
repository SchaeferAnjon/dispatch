// Learning while the agent works (direction B「Talk while new」, user 2026-11-15, task-q9x2r, kanban design/learn-scene):
// which calls get a small card, its words from what the agent already said, several of a kind in one card, Quiet or
// Talk, and the card's 7 second clock that the pointer stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const M = await import(pathToFileURL(path.join(vs, 'sessions/contrib/dispatchLearn/common/dispatchLearnModel.ts')));

test('Talk is the default; Quiet only when set so', () => {
	assert.equal(M.learnMode(undefined), 'talk');
	assert.equal(M.learnMode('talk'), 'talk');
	assert.equal(M.learnMode('quiet'), 'quiet');
	assert.equal(M.learnMode('loud'), 'talk');
	assert.equal(M.LEARN_MODE_SETTING, 'dispatch.learning.whileWorking');
});

test('Quiet: no card; Talk: a card, unless it is a word the person knows (the seam for Words you know)', () => {
	const e = { kind: 'install', subject: 'date-fns' };
	assert.equal(M.shouldTalk('talk', e), true);
	assert.equal(M.shouldTalk('quiet', e), false);
	assert.equal(M.learnKey(e), 'install:date-fns');
	assert.equal(M.learnKey({ kind: 'create', subject: '/p/src/reminder.ts' }), 'create:reminder.ts');
	assert.equal(M.shouldTalk('talk', e, { has: k => k === 'install:date-fns' }), false);
	assert.equal(M.NO_KNOWN_WORDS.has('install:date-fns'), false);
});

test('a shell command is read as its simple commands, quotes taken off', () => {
	assert.deepEqual(M.shellCommands('cd app && npm install date-fns; echo "a b" | wc -l'), [['cd', 'app'], ['npm', 'install', 'date-fns'], ['echo', 'a b'], ['wc', '-l']]);
	assert.deepEqual(M.shellCommands("rm -f 'my file.txt'\nls"), [['rm', '-f', 'my file.txt'], ['ls']]);
	assert.deepEqual(M.shellCommands('a || b & c'), [['a'], ['b'], ['c']]);
});

test('installs: npm, pnpm, yarn, bun, pip, python -m pip, uv, brew, cargo, go, gem; not run, test or uninstall', () => {
	const pk = c => M.installsIn(c).map(i => [i.tool, i.packages]);
	assert.deepEqual(pk('npm install date-fns'), [['npm', ['date-fns']]]);
	assert.deepEqual(pk('cd /p/app && npm i -D vitest @types/node'), [['npm', ['vitest', '@types/node']]]);
	assert.deepEqual(pk('npm install --dry-run left-pad'), [['npm', ['left-pad']]]);
	assert.deepEqual(pk('npm install'), [['npm', []]]);
	assert.deepEqual(pk('npm --prefix app install zod'), [['npm', ['zod']]]);
	assert.deepEqual(pk('pnpm add -w react'), [['pnpm', ['react']]]);
	assert.deepEqual(pk('yarn'), [['yarn', []]]);
	assert.deepEqual(pk('bun add hono'), [['bun', ['hono']]]);
	assert.deepEqual(pk('pip install -r requirements.txt requests'), [['pip', ['requests']]]);
	assert.deepEqual(pk('python3 -m pip install --user rich'), [['pip', ['rich']]]);
	assert.deepEqual(pk('uv pip install httpx'), [['pip', ['httpx']]]);
	assert.deepEqual(pk('uv add pydantic'), [['uv', ['pydantic']]]);
	assert.deepEqual(pk('sudo brew install --cask iterm2'), [['brew', ['iterm2']]]);
	assert.deepEqual(pk('HOMEBREW_NO_AUTO_UPDATE=1 brew install jq'), [['brew', ['jq']]]);
	assert.deepEqual(pk('cargo add serde --features derive'), [['cargo', ['serde']]]);
	assert.deepEqual(pk('go get github.com/x/y@v1'), [['go', ['github.com/x/y@v1']]]);
	assert.deepEqual(pk('gem install rails'), [['gem', ['rails']]]);
	assert.deepEqual(pk('/usr/local/bin/npm install chalk 2>&1'), [['npm', ['chalk']]]);
	for (const c of ['npm run build', 'npm test', 'npm uninstall x', 'pip list', 'brew update', 'echo npm install x', 'git add .', 'ls']) {
		assert.deepEqual(pk(c), [], c);
	}
	assert.deepEqual(M.installSubjects({ tool: 'npm', packages: [], command: 'npm install' }), ['npm dependencies']);
});

test('deletions: rm, rmdir, unlink, trash, git rm', () => {
	assert.deepEqual(M.deletesIn('rm -rf build dist'), ['build', 'dist']);
	assert.deepEqual(M.deletesIn('git rm --cached src/old.ts && echo ok'), ['src/old.ts']);
	assert.deepEqual(M.deletesIn('rmdir tmp; unlink a.lnk; trash notes.md'), ['tmp', 'a.lnk', 'notes.md']);
	assert.deepEqual(M.deletesIn('npm run rm'), []);
	assert.deepEqual(M.deletesIn('echo rm x'), []);
});

test('files a shell command writes: > and >>, touch, tee; not stderr, /dev/null or another stream', () => {
	assert.deepEqual(M.writesIn("cat > learn/notes.ts <<'EOF'\n// Keeps the notes.\nEOF"), ['learn/notes.ts']);
	assert.deepEqual(M.writesIn('echo hi >>log.txt && touch a.ts b.ts'), ['log.txt', 'a.ts', 'b.ts']);
	assert.deepEqual(M.writesIn('npm test 2> err.txt > /dev/null 2>&1'), []);
	assert.deepEqual(M.writesIn('ls | tee out.txt'), ['out.txt']);
	assert.deepEqual(M.writesIn('ls -la'), []);
});

test('a new file says what it is in its first comment; licences, directives and its own name do not count', () => {
	assert.equal(M.headerComment('// Schedules the daily reading reminder.\nexport const a = 1;\n'), 'Schedules the daily reading reminder.');
	assert.equal(M.headerComment('/**\n * The switch in Settings that turns the reminder on or off. Saved per user.\n */\nexport {}'), 'The switch in Settings that turns the reminder on or off.');
	assert.equal(M.headerComment('#!/usr/bin/env python3\n# Sends the weekly digest email\nimport os'), 'Sends the weekly digest email');
	assert.equal(M.headerComment('"""Reads the config file and checks it."""\nimport json'), 'Reads the config file and checks it.');
	assert.equal(M.headerComment('// Copyright 2026 Someone\n// SPDX-License-Identifier: MIT\n\n// Formats dates for the reader.\n'), 'Formats dates for the reader.');
	assert.equal(M.headerComment('/* eslint-disable */\n// @ts-check\n// Keeps the reading streak.\n'), 'Keeps the reading streak.');
	assert.equal(M.headerComment('// reminder.ts\n// Works out when to remind.\n'), 'Works out when to remind.');
	assert.equal(M.headerComment('# Reading app\n\nNotes.'), 'Reading app');
	assert.equal(M.headerComment('<!-- The settings page. -->\n<div></div>'), 'The settings page.');
	assert.equal(M.headerComment('"use strict";\n// 每天晚上 9 点提醒读书。\n'), '每天晚上 9 点提醒读书。');
	assert.equal(M.headerComment('export const a = 1;\n// late comment'), undefined, 'a comment after code is not a header');
	assert.equal(M.headerComment(''), undefined);
	assert.equal(M.headerComment('#include <stdio.h>\nint main(){}'), undefined);
	assert.equal(M.headerComment(`// ${'word '.repeat(60)}`).length <= 160, true);
});

test('the sentence the agent wrote before a call counts when it names the thing or says what it is for', () => {
	assert.equal(M.lastSentence('I read the settings page. The phone needs a ready-made package to notify while the app is closed.'), 'The phone needs a ready-made package to notify while the app is closed.');
	assert.equal(M.lastSentence('要两样东西：一个管「每天几点提醒」，一个是设置里的开关。'), '要两样东西：一个管「每天几点提醒」，一个是设置里的开关。');
	assert.equal(M.lastSentence('Now I will add **`reminder.ts`**:'), 'Now I will add reminder.ts.');
	assert.equal(M.lastSentence(''), undefined);
	assert.equal(M.why('Let me install it.', ['date-fns']), undefined, 'says neither the name nor what for');
	assert.equal(M.why('Add date-fns now.', ['date-fns']), 'Add date-fns now.');
	assert.equal(M.why('This one pads strings so the table lines up.', ['left-pad']), 'This one pads strings so the table lines up.');
	assert.equal(M.why('Next, reminder.ts.', ['/p/src/reminder.ts']), 'Next, reminder.ts.');
	assert.equal(M.why('手机关着也要弹通知，得装一个工具包。', ['x']), '手机关着也要弹通知，得装一个工具包。');
	assert.equal(M.why(undefined, ['x']), undefined);
});

test('the files a call names: Markdown links, and Codex\'s add / delete / update lines', () => {
	assert.deepEqual(M.filesInMessage('Edit [reminder.ts](file:///p/src/reminder.ts)'), [{ target: 'file:///p/src/reminder.ts' }]);
	assert.deepEqual(M.filesInMessage('add: /p/a.ts\nupdate: /p/b.ts\ndelete: /p/c.ts'), [{ target: '/p/a.ts', op: 'create' }, { target: '/p/b.ts', op: 'edit' }, { target: '/p/c.ts', op: 'delete' }]);
	assert.deepEqual(M.filesInMessage('Ran `ls`'), []);
	assert.equal(M.WRITE_TOOLS.has('Write'), true);
	assert.equal(M.WRITE_TOOLS.has('file_edit'), true);
	assert.equal(M.WRITE_TOOLS.has('Read'), false);
});

test('a written file is new when it was made after the turn began', () => {
	assert.equal(M.createdInTurn(10_000, 10_500), true, 'clocks a little apart');
	assert.equal(M.createdInTurn(20_000, 10_000), true);
	assert.equal(M.createdInTurn(1_000, 10_000), false, 'it was there before');
	assert.equal(M.createdInTurn(undefined, 10_000), false);
	assert.equal(M.createdInTurn(0, 10_000), false);
});

const ev = (kind, subject, extra = {}) => ({ kind, subject, call: subject, ...extra });

test('one new file: its name, New file, and what it says about itself; no word: the action itself', () => {
	const c = M.cardFor('create', [ev('create', '/p/src/reminder.ts', { rel: 'src/reminder.ts', why: 'Schedules the daily reading reminder.' })]);
	assert.deepEqual({ icon: c.icon, title: c.title, tag: c.tag, text: c.text }, { icon: 'new-file', title: 'reminder.ts', tag: 'New file', text: 'Schedules the daily reading reminder.' });
	assert.equal(c.sentence, 'Created reminder.ts. Schedules the daily reading reminder.');
	assert.equal(M.cardFor('create', [ev('create', '/p/src/a.ts', { rel: 'src/a.ts' })]).text, 'Created src/a.ts.');
	assert.equal(M.cardFor('create', [ev('create', '/p/a.ts', { why: 'Holds the list' })]).text, 'Holds the list.', 'a full stop is added');
});

test('several of a kind in one turn: one card that counts and names them', () => {
	const files = ['/p/a.ts', '/p/b.tsx', '/p/c.css', '/p/d.md', '/p/e.json'].map(f => ev('create', f));
	const c3 = M.cardFor('create', files.slice(0, 3));
	assert.deepEqual([c3.title, c3.tag, c3.text], ['3 new files', 'Created', 'a.ts, b.tsx, c.css.']);
	assert.equal(c3.sentence, 'Created 3 files: a.ts, b.tsx, c.css.');
	assert.equal(M.cardFor('create', files).text, 'a.ts, b.tsx, c.css and 2 more.');
	const d = M.cardFor('delete', [ev('delete', '/p/old.ts', { rel: 'old.ts' })]);
	assert.deepEqual([d.icon, d.title, d.tag, d.text], ['trash', 'old.ts', 'Deleted', 'Deleted old.ts.']);
	assert.deepEqual([M.cardFor('delete', files.slice(0, 2)).title, M.cardFor('delete', files.slice(0, 2)).tag], ['2 files', 'Deleted']);
});

test('installs: the packages, Installed, and the agent\'s word or the command', () => {
	const one = M.cardFor('install', [ev('install', 'left-pad', { command: 'npm install --dry-run left-pad' })]);
	assert.deepEqual([one.icon, one.title, one.tag, one.text], ['package', 'left-pad', 'Installed', 'Ran npm install left-pad.'], 'the card says the command without its flags');
	assert.equal(M.askText(one).text, 'npm install --dry-run left-pad', 'the side chat\'s quote has it whole');
	assert.equal(M.withoutFlags('pip install -r req.txt --user rich'), 'pip install rich');
	// where the output goes is not part of what was run (an agent added 2>&1 in a learn-talk run, task-fktjx)
	assert.equal(M.withoutFlags('npm install --dry-run --no-audit --no-fund left-pad 2>&1'), 'npm install left-pad');
	assert.equal(M.withoutFlags('npm install left-pad > log.txt'), 'npm install left-pad');
	const said = M.cardFor('install', [ev('install', '@capacitor/local-notifications', { command: 'npm install @capacitor/local-notifications', why: 'The phone needs it to notify while the app is closed.' })]);
	assert.equal(said.text, 'The phone needs it to notify while the app is closed.');
	const two = M.cardFor('install', [ev('install', 'a', { command: 'npm i a b' }), ev('install', 'b', { command: 'npm i a b' }), ev('install', 'rich', { command: 'pip install rich', why: 'x' })]);
	assert.deepEqual([two.title, two.text], ['a, b, rich', 'Ran npm i a b and pip install rich.'], 'two commands: the commands, not one of their words');
	const many = M.cardFor('install', ['a', 'b', 'c', 'd'].map(p => ev('install', p, { command: 'npm i a b c d' })));
	assert.equal(many.title, '4 packages');
});

test('the same thing twice in a turn stays one; a word that comes later is kept', () => {
	const a = [ev('create', '/p/a.ts')];
	const b = M.mergeEvents(a, [ev('create', '/p/a.ts', { why: 'Later word.' }), ev('create', '/p/b.ts')]);
	assert.deepEqual(b.map(e => [e.subject, e.why]), [['/p/a.ts', 'Later word.'], ['/p/b.ts', undefined]]);
	assert.equal(M.mergeEvents(b, [ev('create', '/p/a.ts', { why: 'Other.' })])[0].why, 'Later word.', 'the first word stays');
});

test('a side chat about a card is asked on the file or the command', () => {
	assert.deepEqual(M.askText(M.cardFor('create', [ev('create', '/p/src/reminder.ts', { rel: 'src/reminder.ts' })])), { text: 'src/reminder.ts', where: 'reminder.ts · New file' });
	assert.deepEqual(M.askText(M.cardFor('install', [ev('install', 'left-pad', { command: 'npm install left-pad' })])), { text: 'npm install left-pad', where: 'Command · Installed' });
	assert.deepEqual(M.askText(M.cardFor('create', [ev('create', '/p/a.ts', { rel: 'a.ts' }), ev('create', '/p/b.ts', { rel: 'b.ts' })])), { text: 'a.ts\nb.ts', where: '2 new files' });
});

test('the clock: 7 seconds, stopped while the pointer is on the card, going on from where it was', () => {
	let c = M.startClock(1000);
	assert.equal(M.TALK_CARD_MS, 7000);
	assert.equal(M.clockLeft(c, 3000), 5000);
	c = M.pauseClock(c, 3000);
	assert.equal(M.clockLeft(c, 60_000), 5000, 'the pointer on it: no time passes');
	assert.equal(M.pauseClock(c, 70_000), c, 'stopping a stopped clock changes nothing');
	c = M.resumeClock(c, 60_000);
	assert.equal(M.clockLeft(c, 64_000), 1000);
	assert.equal(M.clockLeft(c, 70_000), 0);
});

test('the cards sit in the corner: 340 wide, newest at the bottom, 8 apart, above the side chat\'s pill', () => {
	assert.equal(M.talkCardWidth(682, 1440), 340);
	assert.equal(M.talkCardWidth(300, 1440), 268);
	assert.equal(M.talkCardWidth(500, 1100), 476, 'a narrow window: the pane\'s width less 12 each side');
	assert.deepEqual(M.talkCardBottoms([70, 90], 16, false), [16 + 90 + 8, 16]);
	assert.deepEqual(M.talkCardBottoms([70], 16, true), [56]);
	assert.equal(M.MAX_TALK_CARDS, 3);
});
