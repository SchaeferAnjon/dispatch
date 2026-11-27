import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// VS Code's square-ish corners (DESIGN.md「尺寸」圆角; user 2026-11-16, task-n1o60): Dispatch's own CSS and inline
// styles take the --dispatch-radius-* tokens (VS Code's small rounded rectangles), not big rounds or 999px capsules.
// What is still there may only go away: this is the ratchet that holds that, like symbols.test.mjs.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

// Dispatch's own code: every dispatch* contribution of the two windows, and the dispatch* files next to VS Code's own
// in the Agents window's shell and session list.
const ROOTS = [
	...fs.readdirSync(path.join(vs, 'sessions/contrib')).filter(n => n.startsWith('dispatch')).map(n => `sessions/contrib/${n}`),
	...fs.readdirSync(path.join(vs, 'workbench/contrib')).filter(n => n.startsWith('dispatch')).map(n => `workbench/contrib/${n}`),
];
const FILES_IN = ['sessions/browser/media', 'sessions/contrib/sessions/browser', 'sessions/contrib/sessions/browser/media'];

// Where the tokens are made, not used.
const TOKENS = 'workbench/contrib/dispatchRadius/browser/media/dispatchRadius.css';

// A radius as CSS writes it (border-radius, a corner of it, a custom property named for one) or as TS sets it
// (style.borderRadius, an inline `border-radius:` in a string).
const DECL = /(?:border(?:-(?:top|bottom))?(?:-(?:left|right))?-radius|--[\w-]*radius[\w-]*|borderRadius)\s*[:=]\s*['"`]?([^;'"`}\n]+)/g;

/** What is wrong with one radius value, if anything: rounder than the largest token (12) or a 999 capsule; between
 *  5 and 11 but not on the scale (6, 8); a circle (50%), which only dots and rings may be. */
function kinds(value) {
	const v = value.replace(/var\(--dispatch-radius-[a-z]+\)/g, '');
	const out = [];
	if (/999|cornerRadius-circle/.test(v)) {
		out.push('round');
	}
	for (const [, n, unit] of v.matchAll(/(\d+(?:\.\d+)?)(px|%|em|rem)?/g)) {
		const x = Number(n);
		if (unit === '%') {
			if (x >= 50) {
				out.push('circle');
			}
		} else if (x > 12 && !/999/.test(n)) {
			out.push('round');
		} else if (x >= 5 && x < 12 && x !== 6 && x !== 8) {
			out.push('off-scale');
		}
	}
	return out;
}

// How many of each there are now, file by file. Only goes down: when you take some out, lower the number here.
// (2026-11-16, task-n1o60: 23 files, no round and no capsule left; 2 off-scale corners of block shapes, which the
// tokens do not cover; 31 circles, every one a dot or a ring of 20 or less.)
const BASELINE = {
	'sessions/browser/media/dispatchStatusBlocks.css': { circle: 1 },
	'sessions/contrib/dispatchAutomations/browser/media/dispatchFoundAutomations.css': { circle: 1 },
	'sessions/contrib/dispatchBlocks/browser/media/dispatchBlocks.css': { circle: 2, 'off-scale': 2 },
	'sessions/contrib/dispatchCommon/browser/media/dispatchWhere.css': { circle: 2 },
	'sessions/contrib/dispatchDraw/browser/media/dispatchDraw.css': { circle: 1 },
	// the 8px recording dot of Point and talk (task-dd4hw)
	'sessions/contrib/dispatchPointTalk/browser/media/dispatchPointTalk.css': { circle: 1 },
	'sessions/contrib/dispatchInbox/electron-browser/media/dispatchInbox.css': { circle: 1 },
	'sessions/contrib/dispatchOnboarding/browser/media/dispatchOnboarding.css': { circle: 2 },
	'sessions/contrib/dispatchProjectCustom/browser/media/dispatchProjectCustom.css': { circle: 1 },
	'sessions/contrib/dispatchSettings/browser/media/dispatchSettings.css': { circle: 3 },
	'sessions/contrib/dispatchTaskGraph/browser/media/dispatchTaskGraph.css': { circle: 2 },
	'sessions/contrib/dispatchTurbo/browser/media/dispatchTurbo.css': { circle: 5 },
	'sessions/contrib/sessions/browser/media/dispatchPeerWaiting.css': { circle: 2 },
	'sessions/contrib/sessions/browser/media/dispatchProjects.css': { circle: 4 },
	'sessions/contrib/sessions/browser/media/dispatchWaiting.css': { circle: 1 },
	'workbench/contrib/dispatchMachines/browser/media/dispatchMachines.css': { circle: 1 },
	'workbench/contrib/dispatchMachines/electron-browser/media/dispatchMachines.css': { circle: 1 },
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

function* files() {
	for (const root of ROOTS) {
		yield* walk(path.join(vs, root));
	}
	for (const dir of FILES_IN) {
		for (const name of fs.readdirSync(path.join(vs, dir))) {
			if (name.startsWith('dispatch') && /\.(ts|css)$/.test(name) && !/\.test\.ts$/.test(name)) {
				yield path.join(vs, dir, name);
			}
		}
	}
}

// comments name radii without drawing them; keep the line breaks so line numbers stay right
const blank = s => s.replace(/[^\n]/g, ' ');
const code = (text, css) => css
	? text.replace(/\/\*[\s\S]*?\*\//g, blank)
	: text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));

function count() {
	const counts = {};
	const lines = {};
	for (const file of files()) {
		const rel = path.relative(vs, file).split(path.sep).join('/');
		if (rel === TOKENS) {
			continue;
		}
		const text = code(fs.readFileSync(file, 'utf8'), file.endsWith('.css'));
		for (const m of text.matchAll(DECL)) {
			for (const kind of kinds(m[1])) {
				(counts[rel] ??= {})[kind] = (counts[rel][kind] ?? 0) + 1;
				(lines[`${rel} ${kind}`] ??= []).push(text.slice(0, m.index).split('\n').length);
			}
		}
	}
	return { counts, lines };
}

const WHAT = {
	round: '比 12 圆或 999 胶囊：换成 --dispatch-radius-* 里的一个（DESIGN.md「尺寸」圆角）',
	'off-scale': '5 到 11 之间不在刻度上：按 DESIGN.md 归到 4、6 或 8 的 token',
	circle: '50% 只给 20px 以内的点和圈：按钮、头像、图标框用 token',
};

test('radii rounder than the tokens, capsules and circles only go down (DESIGN.md「尺寸」圆角)', () => {
	const { counts, lines } = count();
	const problems = [];
	for (const rel of [...new Set([...Object.keys(counts), ...Object.keys(BASELINE)])].sort()) {
		for (const kind of Object.keys(WHAT)) {
			const now = counts[rel]?.[kind] ?? 0;
			const was = BASELINE[rel]?.[kind] ?? 0;
			if (now > was) {
				problems.push(`${rel}: ${now - was} more ${kind} radius than the baseline (${was} → ${now}, lines ${lines[`${rel} ${kind}`].join(', ')}). 多了，${WHAT[kind]}。`);
			} else if (now < was) {
				problems.push(`${rel}: ${was - now} fewer ${kind} (${was} → ${now}). 少了，请把 ide/tests/corners.test.mjs 的 BASELINE 里这一项改成 ${now}。`);
			}
		}
	}
	assert.deepEqual(counts, BASELINE, problems.join('\n'));
});

test('the kinds of a radius', () => {
	assert.deepEqual(kinds('999px'), ['round']);
	assert.deepEqual(kinds('var(--vscode-cornerRadius-circle, 999px)'), ['round']);
	assert.deepEqual(kinds('24px 24px 0 0'), ['round', 'round']);
	assert.deepEqual(kinds('10px'), ['off-scale']);
	assert.deepEqual(kinds('50%'), ['circle']);
	assert.deepEqual(kinds('12px'), []);
	assert.deepEqual(kinds('4.5px'), []);
	assert.deepEqual(kinds('calc(var(--dispatch-radius-row) + 8px)'), []);
	assert.deepEqual(kinds('var(--dispatch-radius-input) var(--dispatch-radius-input) 0 0'), []);
});

test('DESIGN.md\'s radius table and dispatchRadius.css say the same', () => {
	const design = fs.readFileSync(path.join(repo, 'DESIGN.md'), 'utf8');
	const table = Object.fromEntries([...design.matchAll(/^\s*\| `radius-([a-z]+)` \| (\d+) \|/gm)].map(m => [m[1], Number(m[2])]));
	const css = fs.readFileSync(path.join(vs, TOKENS), 'utf8');
	const tokens = Object.fromEntries([...code(css, true).matchAll(/--dispatch-radius-([a-z]+):\s*(\d+)px;/g)].map(m => [m[1], Number(m[2])]));
	assert.deepEqual(Object.keys(table).sort(), ['bubble', 'button', 'card', 'dialog', 'input', 'row'], 'DESIGN.md「尺寸」has the radius table');
	assert.deepEqual(tokens, table, 'dispatchRadius.css and DESIGN.md disagree');
	assert.ok(Math.max(...Object.values(table)) === 12, 'the largest token is 12, which the ratchet counts against');
});
