import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The symbol table (DESIGN.md「符号表」; user 2026-11-12 task-r5jfs, changed 2026-11-15 task-o01fh, design/marks-compare):
// a state is said by VS Code's own round state icons (passFilled, circleLargeFilled, circleLarge, from
// dispatchBlocks/browser/dispatchMarks.ts); things are thin line icons; blocks only count work. The state marks outside
// the table may only go away in Dispatch's own code, never come back: this is the ratchet that holds that.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

// Dispatch's own code: every dispatch* contribution of the Agents window and the editor, and the session list.
const ROOTS = [
	...fs.readdirSync(path.join(vs, 'sessions/contrib')).filter(n => n.startsWith('dispatch')).map(n => `sessions/contrib/${n}`),
	...fs.readdirSync(path.join(vs, 'workbench/contrib')).filter(n => n.startsWith('dispatch')).map(n => `workbench/contrib/${n}`),
	'sessions/contrib/sessions/browser',
];

// Where the state blocks are made, not used: stateBlock() and the product icons are defined here, and the font
// table lists every glyph by name. Counting them would count the definition itself.
const DEFINITIONS = new Set([
	'sessions/contrib/dispatchBlocks/browser/dispatchBlocks.ts', // stateBlock(), DispatchBlockIcons
	'sessions/contrib/dispatchBlocks/browser/dispatchBlockGlyphs.ts', // the font's glyph names (generated)
	'sessions/contrib/dispatchBlocks/browser/media/dispatchBlockGlyphs.css', // one rule per glyph (generated)
	'sessions/contrib/dispatchBlocks/browser/media/dispatchBlocks.css', // the block's own colours and motions
]);

const STATES = 'working|waiting|done|handoff|stopped|todo|sub-agent|step-now';

// The marks Dispatch drew itself before 2026-11-15 (direction A's 7px dots, thin checks and small hollow rings, and the
// older status dots), by the class that draws them, in TS and CSS. Found by every small round CSS rule in Dispatch's
// code; left out on purpose: drawings that are charts (the Projects and Timeline lanes, the task graph's SVG and its
// legend, which shows the graph's own marks), colour swatches, radio buttons and pictures of people.
const DRAWN = [
	'dispatch-now-dot', 'dispatch-now-ping', 'dispatch-now-check', // the Now tab
	'waiting-dot', 'done-check', // a session row's slot
	'dsa-dot', 'dsa-check', // the sub-agent strip
	'dispatch-task-dot', 'dispatch-tg-dot', // a task's status, the task graph's cards
	'dispatch-dot', // the shared glowing dot, on the Projects page
	'dt-dot', // Timeline: a lane at work at Now
	'dispatch-machines-dot', 'dispatch-machines-other-dot', 'dispatch-waiting-peer-dot', 'dset-dot', 'dispatch-online-dot', // a Mac or the phone online
	'dispatch-waiting-row-unread', 'dispatch-inbox-stop', 'dispatch-status-dot', 'dispatch-found-offline',
];

// (a) the eight state glyphs used as a mark. A bare `dispatch-waiting` is not one (the Waiting for you section's id
// and a session row's class), nor are `dispatch-waiting-dot` and the like: only the forms that put a glyph on screen.
// (b) the marks Dispatch draws itself (DRAWN): a whole class name, so `--dispatch-dot-size` or `dispatch-waiting-dot`
// is not `dispatch-dot` or `waiting-dot`.
const KINDS = {
	'state block': [
		/\bstateBlock\(/g, // the SVG block, whatever state it is handed
		new RegExp(`DispatchBlockIcons(?:\\.(?:working|waiting|done|handoff|stopped|todo)\\b|\\[\\s*['"](?:${STATES})['"]\\s*\\])`, 'g'),
		new RegExp(`\\$\\(dispatch-(?:${STATES})\\)`, 'g'), // in a label
		new RegExp(`codicon-dispatch-(?:${STATES})(?![-\\w])`, 'g'),
		new RegExp(`(?:fromId|registerIcon)\\(\\s*['"\`]dispatch-(?:${STATES})['"\`]`, 'g'),
		new RegExp(`\\.dispatch-block\\.(?:${STATES}|step-done)(?![-\\w])`, 'g'), // a block styled by its state
	],
	'drawn mark': [
		new RegExp(`(?<![-\\w])(?:${DRAWN.join('|')})(?![-\\w])`, 'g'),
	],
};

// How many of each there are now, file by file. Only goes down: when you take marks out, lower the number here.
// (2026-11-15, task-o01fh: 24 files, 25 state blocks and 38 drawn marks; VS Code's round state icons are the table's.)
const BASELINE = {
	'sessions/contrib/dispatchAutomations/browser/dispatchFoundAutomations.ts': { 'drawn mark': 1 },
	'sessions/contrib/dispatchAutomations/browser/media/dispatchFoundAutomations.css': { 'drawn mark': 1 },
	'sessions/contrib/dispatchBlocks/browser/dispatchBlocksShowcase.ts': { 'state block': 8, 'drawn mark': 1 },
	'sessions/contrib/dispatchBlocks/browser/media/dispatchBlocksShowcase.css': { 'drawn mark': 1 },
	'sessions/contrib/dispatchCapture/browser/dispatchNextUp.ts': { 'state block': 3 },
	'sessions/contrib/dispatchCapture/browser/media/dispatchCapture.css': { 'state block': 1 },
	'sessions/contrib/dispatchInbox/electron-browser/dispatchInbox.contribution.ts': { 'drawn mark': 3 },
	'sessions/contrib/dispatchInbox/electron-browser/media/dispatchInbox.css': { 'drawn mark': 2 },
	'sessions/contrib/dispatchSettings/browser/dispatchSettingsPages.ts': { 'state block': 1, 'drawn mark': 2 },
	'sessions/contrib/dispatchSettings/browser/media/dispatchSettings.css': { 'drawn mark': 2 },
	'sessions/contrib/dispatchTerminal/browser/dispatchTerminalView.ts': { 'state block': 1 },
	'sessions/contrib/dispatchTitleBar/browser/dispatchPlace.ts': { 'state block': 1 },
	'sessions/contrib/dispatchTurbo/browser/dispatchTimeline.ts': { 'state block': 9, 'drawn mark': 1 },
	'sessions/contrib/dispatchTurbo/browser/dispatchTurboSidebar.ts': { 'state block': 1 },
	'sessions/contrib/dispatchTurbo/browser/media/dispatchTurbo.css': { 'drawn mark': 4 },
	'sessions/contrib/sessions/browser/dispatchPeerWaiting.ts': { 'drawn mark': 1 },
	'sessions/contrib/sessions/browser/dispatchProjects.ts': { 'drawn mark': 2 },
	'sessions/contrib/sessions/browser/media/dispatchPeerWaiting.css': { 'drawn mark': 1 },
	'sessions/contrib/sessions/browser/media/dispatchProjects.css': { 'drawn mark': 1 },
	'sessions/contrib/sessions/browser/media/dispatchWaiting.css': { 'drawn mark': 5 },
	'sessions/contrib/sessions/browser/views/sessionsList.ts': { 'drawn mark': 1 },
	'workbench/contrib/dispatchMachines/browser/dispatchMachines.ts': { 'drawn mark': 1 },
	'workbench/contrib/dispatchMachines/browser/media/dispatchMachines.css': { 'drawn mark': 4 },
	'workbench/contrib/dispatchMachines/electron-browser/media/dispatchMachines.css': { 'drawn mark': 4 },
};

function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== 'test') {
				yield* walk(p);
			}
		} else if (/\.(ts|css)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
			yield p;
		}
	}
}

// comments name marks without showing them; keep the line breaks so line numbers stay right
const blank = s => s.replace(/[^\n]/g, ' ');
const code = (text, css) => css
	? text.replace(/\/\*[\s\S]*?\*\//g, blank)
	: text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));

function count() {
	const counts = {};
	const lines = {};
	for (const root of ROOTS) {
		for (const file of walk(path.join(vs, root))) {
			const rel = path.relative(vs, file).split(path.sep).join('/');
			if (DEFINITIONS.has(rel)) {
				continue;
			}
			const text = code(fs.readFileSync(file, 'utf8'), file.endsWith('.css'));
			for (const [kind, patterns] of Object.entries(KINDS)) {
				for (const re of patterns) {
					for (const m of text.matchAll(re)) {
						(counts[rel] ??= {})[kind] = (counts[rel][kind] ?? 0) + 1;
						(lines[`${rel} ${kind}`] ??= []).push(text.slice(0, m.index).split('\n').length);
					}
				}
			}
		}
	}
	return { counts, lines };
}

test('state marks outside the symbol table only go down (DESIGN.md「符号表」)', () => {
	const { counts, lines } = count();
	const problems = [];
	for (const rel of [...new Set([...Object.keys(counts), ...Object.keys(BASELINE)])].sort()) {
		for (const kind of Object.keys(KINDS)) {
			const now = counts[rel]?.[kind] ?? 0;
			const was = BASELINE[rel]?.[kind] ?? 0;
			if (now > was) {
				problems.push(`${rel}: ${now - was} more ${kind} mark(s) than the baseline (${was} → ${now}, lines ${lines[`${rel} ${kind}`].join(', ')}). `
					+ `多了：表外的状态记号只许减少，按 DESIGN.md「符号表」换成表里的记号。`);
			} else if (now < was) {
				problems.push(`${rel}: ${was - now} fewer ${kind} mark(s) (${was} → ${now}). `
					+ `少了，请把 ide/tests/symbols.test.mjs 的 BASELINE 里这一项改成 ${now}${now === 0 && Object.values(counts[rel] ?? {}).every(n => !n) ? '（这个文件整项删掉）' : ''}。`);
			}
		}
	}
	assert.deepEqual(counts, BASELINE, problems.join('\n'));
});

test('DESIGN.md has the symbol table: its section and the eight states', () => {
	const design = fs.readFileSync(path.join(repo, 'DESIGN.md'), 'utf8');
	const at = design.search(/^## 符号表/m);
	assert.ok(at >= 0, 'DESIGN.md has no「## 符号表」section');
	const end = design.slice(at + 1).search(/^## /m);
	const section = end < 0 ? design.slice(at) : design.slice(at, at + 1 + end);
	assert.match(section, /^\| 意思 \| 记号 \| 颜色 \|$/m, 'the table of states');
	const rows = section.split('\n').filter(l => /^\| /.test(l) && !/^\| 意思 /.test(l)).map(l => l.split('|')[1].trim());
	assert.deepEqual(rows.map(r => r.replace(/（.*$/, '')), ['在做', '现在', '等你', '做完', '没做', '出错、被打断', '子 Agent 在跑', '交出去']);
	assert.match(section, /ide\/tests\/symbols\.test\.mjs/, 'the section names this test');
});
