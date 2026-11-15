import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The app icon's colours are written down once (base/common/dispatchPalette.ts); kanban preferences
// 「图标和 Dock 统一」「状态色用图标配色」.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const palette = await import(pathToFileURL(path.join(vs, 'base/common/dispatchPalette.ts')));
// also registers the .js → .ts resolution the icon's modules need
const { ICON_FILES } = await import('../gen-icon-svgs.mjs');
const iconLayout = await import(pathToFileURL(path.join(vs, 'base/common/dispatchIcon.ts')));

const lum = hex => {
	const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('the icon: ten blocks in four columns, a square row and two rows of cards, the dot at the bottom right', () => {
	const blocks = palette.DISPATCH_ICON_BLOCKS;
	assert.equal(blocks.length, 10);
	assert.deepEqual(blocks.map(b => `${b.row}${b.col}`), ['00', '01', '02', '03', '10', '11', '12', '13', '20', '21']);
	assert.deepEqual(blocks.map(b => b.color), ['gray', 'amber', 'green', 'blue', 'cream', 'coral', 'teal', 'purple', 'cream', 'cream']);
	assert.ok(blocks.filter(b => b.row === 0).every(b => b.w === b.h), 'the top row is square');
	assert.ok(blocks.filter(b => b.row > 0).every(b => b.h < b.w), 'the cards are short');
	// the box is the blocks'; the Dock file's dot stands out past it, the app's small dot inside it
	assert.deepEqual(palette.DISPATCH_ICON_SIZE, { w: blocks[3].x + blocks[3].w, h: blocks[9].y + blocks[9].h });
	const d = palette.DISPATCH_ICON_DOT, run = palette.DISPATCH_ICON_RUNNING_DOT;
	assert.ok(d.cx + d.r > palette.DISPATCH_ICON_SIZE.w && d.cy + d.r > palette.DISPATCH_ICON_SIZE.h);
	assert.ok(run.cx + run.r <= palette.DISPATCH_ICON_SIZE.w && run.cy + run.r <= palette.DISPATCH_ICON_SIZE.h);
});

test('a state colour keeps 3:1 on a hovered row in both themes; the icon\'s own colour is used where it can', () => {
	for (const [theme, bg] of [['light', '#f2f1f0'], ['dark', '#292524']]) {
		for (const [state, color] of Object.entries(palette.DISPATCH_STATE_ICON_COLOR)) {
			const v = palette.DISPATCH_STATE_THEME[theme][color];
			assert.ok(contrast(v, bg) >= 3, `${theme} ${state} ${v}: ${contrast(v, bg).toFixed(2)}`);
			if (contrast(palette.DISPATCH_ICON_COLORS[color], bg) >= 3) {
				assert.equal(v, palette.DISPATCH_ICON_COLORS[color], `${theme} ${state} moved without need`);
			}
		}
	}
	assert.match(palette.dispatchPaletteCss(), /--dispatch-state-waiting: #b88100;[\s\S]*\.vs-dark[\s\S]*--dispatch-state-waiting: #c28a12;/);
});

// The colours the icon had before (DESIGN.md's first table) and the softened set (「方块配色别太艳」): none may come back.
const OLD = ['#3a9a6a', '#4fb382', '#4fb583', '#4fb27f', '#4fb482', '#4cb07f', '#7fa48c', '#8fb59c', '#d9a13a', '#e6b450', '#e6b355', '#e6b24f',
	'#e5b350', '#e3b04f', '#e6b44f', '#c9ab78', '#d4b886', '#3aa39a', '#4fbab0', '#52b8ae', '#82aaa5', '#91b9b4', '#3a7bd5', '#8c9bb8', '#9cabc8',
	'#6c5ad8', '#9c95bd', '#aca5cc', '#d9663a', '#c79680', '#d2a491', '#cfcac6', '#dcd8d4', '#7a7a7a'];

function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== 'test') {
				yield* walk(p);
			}
		} else if (/\.(ts|css|svg)$/.test(e.name)) {
			yield p;
		}
	}
}

test('no Dispatch file writes a state or icon colour of its own', () => {
	const roots = ['sessions', 'base', 'workbench/browser/parts/editor', 'workbench/contrib/dispatchMachines', 'workbench/contrib/browserView', 'platform/browserView'];
	const found = [];
	for (const root of roots) {
		for (const file of walk(path.join(vs, root))) {
			const rel = path.relative(vs, file);
			const text = fs.readFileSync(file, 'utf8').toLowerCase();
			for (const hex of OLD) {
				if (text.includes(hex)) {
					found.push(`${rel}: ${hex}`);
				}
			}
		}
	}
	assert.deepEqual(found, []);
});

test('the copies that cannot import the palette hold its values', () => {
	const icon = palette.DISPATCH_ICON_COLORS;
	// the static SVG files are written from the one layout (ide/gen-icon-svgs.mjs): run it after a change
	for (const [rel, text] of Object.entries(ICON_FILES)) {
		assert.equal(fs.readFileSync(path.join(vs, rel), 'utf8'), text, `${rel} is stale: node ide/gen-icon-svgs.mjs`);
	}
	const preload = fs.readFileSync(path.join(vs, 'platform/browserView/electron-browser/preload-browserView.ts'), 'utf8');
	assert.match(preload, new RegExp(`--green: ${icon.green};`));
	assert.match(preload, new RegExp(`--amber: ${icon.amber};`));
	const cli = fs.readFileSync(path.join(repo, 'app/cli/project_custom.py'), 'utf8');
	for (const name of ['green', 'amber', 'coral', 'purple', 'blue', 'teal', 'gray']) {
		assert.match(cli, new RegExp(`"id": "${name}", "hex": "${icon[name]}"`), name);
	}
});

test('the agents\' identity colours: three are the icon\'s own cards, all reach the CSS as --dispatch-engine-*', () => {
	const icon = palette.DISPATCH_ICON_COLORS;
	const light = palette.DISPATCH_ENGINE_THEME.light;
	assert.equal(light['claude-code'], icon.coral);
	assert.equal(light.codex, icon.teal);
	assert.equal(light.zcode, icon.purple);
	const css = palette.dispatchPaletteCss();
	for (const agent of ['claude-code', 'codex', 'opencode', 'pi', 'zcode', 'gemini']) {
		assert.match(css, new RegExp(`--dispatch-engine-${agent}: #[0-9a-f]{6};[\\s\\S]*\\.vs-dark[\\s\\S]*--dispatch-engine-${agent}: #[0-9a-f]{6};`), agent);
	}
});

test('the new session page\'s blocks take the icon\'s colours (muted) from the palette, writing none down', () => {
	const swarm = fs.readFileSync(path.join(vs, 'sessions/contrib/aquarium/browser/dispatchSwarm.ts'), 'utf8');
	assert.match(swarm, /from '..\/..\/..\/..\/base\/common\/dispatchPalette.js'/);
	// only the two stone greys it mutes toward (kanban preference「方块配色别太艳」)
	const hexes = [...swarm.matchAll(/#[0-9a-fA-F]{6}\b/g)].map(m => m[0].toLowerCase());
	assert.deepEqual([...new Set(hexes)].sort(), ['#78716c', '#a8a29e']);
});

// The app icon itself (app/icons/icon.png, the Dock's): an 8-bit RGBA PNG, decoded here to measure it.
function readPng(file) {
	const buf = fs.readFileSync(file);
	let w = 0, h = 0;
	const idat = [];
	for (let at = 8; at < buf.length;) {
		const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
		if (type === 'IHDR') {
			w = data.readUInt32BE(0); h = data.readUInt32BE(4);
			assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], 'icon.png: 8-bit RGBA, not interlaced');
		} else if (type === 'IDAT') {
			idat.push(data);
		}
		at += 12 + len;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp, px = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
			px[y * stride + x] = (line[x] + pred) & 255;
		}
	}
	return { w, h, at: (x, y) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)] };
}

/** The box of the pixels near a colour, in the part of the picture `where` keeps. */
function boxOf(img, hex, tol, where = () => true) {
	const want = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
	let l = Infinity, t = Infinity, r = -1, b = -1;
	for (let y = 0; y < img.h; y++) {
		for (let x = 0; x < img.w; x++) {
			const p = img.at(x, y);
			if (p[3] > 200 && want.every((v, i) => Math.abs(p[i] - v) < tol) && where(x, y)) {
				l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y);
			}
		}
	}
	return { l, t, r: r + 1, b: b + 1 };
}

test('the dot sits where the Dock icon has it, against its blocks (app/icons/icon.png measured)', () => {
	const img = readPng(path.join(repo, 'app/icons/icon.png'));
	const icon = palette.DISPATCH_ICON_COLORS;
	// the top row's first (grey) and last (blue) squares give the grid's corner and scale
	const blue = boxOf(img, icon.blue, 24);
	// in the blue square's row (the plate's soft edge has greys of its own)
	const grey = boxOf(img, icon.gray, 14, (x, y) => x < img.w / 2 && y >= blue.t && y < blue.b);
	const first = palette.DISPATCH_ICON_BLOCKS[0], last = palette.DISPATCH_ICON_BLOCKS[3];
	const k = (blue.r - grey.l) / (last.x + last.w - first.x);
	assert.ok(Math.abs((blue.b - blue.t) / k - last.h) < 4, `blue square height: ${(blue.b - blue.t) / k} (grey ${JSON.stringify(grey)}, blue ${JSON.stringify(blue)})`);
	// the green disc in the lower right half (the green square is in the upper half)
	const dot = boxOf(img, icon.green, 30, (x, y) => x > img.w / 2 && y > img.h / 2);
	const cx = ((dot.l + dot.r) / 2 - grey.l) / k, cy = ((dot.t + dot.b) / 2 - grey.t) / k, r = (dot.r - dot.l) / 2 / k;
	const d = palette.DISPATCH_ICON_DOT;
	assert.ok(Math.abs(cx - d.cx) < 6 && Math.abs(cy - d.cy) < 6 && Math.abs(r - d.r) < 4, `icon.png dot at ${cx.toFixed(1)}, ${cy.toFixed(1)} r ${r.toFixed(1)}; the palette says ${d.cx}, ${d.cy} r ${d.r}`);
});

test('the layout with its plate is app/icons/icon.png: every block and the plate within a pixel at 512', () => {
	const img = readPng(path.join(repo, 'app/icons/icon.png'));
	// the plate: the opaque box (the PNG keeps macOS's transparent margin around it)
	let l = img.w, t = img.h, r = 0, b = 0;
	for (let y = 0; y < img.h; y++) {
		for (let x = 0; x < img.w; x++) {
			if (img.at(x, y)[3] > 128) {
				l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + 1); b = Math.max(b, y + 1);
			}
		}
	}
	assert.equal(r - l, b - t, 'the plate is square');
	const L = iconLayout.dispatchIconLayout(r - l, { plate: true });
	const own = palette.DISPATCH_ICON_COLORS;
	const off = [];
	for (const blk of L.blocks) {
		// the block's own colour, inside its cell (the cream cards are told apart by place)
		const cx = l + blk.x + blk.w / 2, cy = t + blk.y + blk.h / 2;
		const m = boxOf(img, own[blk.color], blk.color === 'cream' ? 90 : 30, (x, y) => Math.abs(x - cx) < blk.w * 0.7 && Math.abs(y - cy) < blk.h * 0.7);
		const d = [m.l - (l + blk.x), m.t - (t + blk.y), m.r - (l + blk.x + blk.w), m.b - (t + blk.y + blk.h)];
		if (d.some(v => Math.abs(v) > 1.5)) {
			off.push(`block ${blk.i} (${blk.color}): png ${JSON.stringify(m)}, layout ${JSON.stringify(blk)}`);
		}
	}
	assert.deepEqual(off, []);
	// the plate's corner: the first opaque pixel on the diagonal
	let corner = 0;
	while (img.at(l + corner, t + corner)[3] <= 128) {
		corner++;
	}
	const rx = L.plate.rx;
	assert.ok(Math.abs(corner - rx * (1 - Math.SQRT1_2)) < 1.5, `plate corner: png ${corner}px in, layout rx ${rx}`);
});

test('snapped to device pixels a small icon keeps its proportions: rows and columns even, nothing touches, nothing squashed', () => {
	for (const size of [16, 28, 34, 48, 128]) {
		for (const dpr of [1, 2]) {
			for (const plate of [true, false]) {
				const exact = iconLayout.dispatchIconLayout(size, { plate });
				const snap = iconLayout.dispatchIconLayout(size, { plate, dpr });
				const at = `${size}px @${dpr}x ${plate ? 'plate' : 'no plate'}`;
				for (const row of [0, 1, 2]) {
					const bs = snap.blocks.filter(b => b.row === row);
					assert.equal(new Set(bs.map(b => b.h)).size, 1, `${at}: row ${row} one height`);
					assert.equal(new Set(bs.map(b => b.y)).size, 1, `${at}: row ${row} one line`);
				}
				const gaps = [0, 1, 2].map(c => snap.blocks[c + 1].x - snap.blocks[c].x - snap.blocks[c].w);
				assert.equal(new Set(gaps).size, 1, `${at}: even column gaps ${gaps}`);
				assert.ok(gaps[0] >= 1 / dpr, `${at}: columns apart`);
				const rowTop = r => snap.blocks.find(b => b.row === r);
				assert.ok(rowTop(1).y >= rowTop(0).y + rowTop(0).h + 1 / dpr && rowTop(2).y >= rowTop(1).y + rowTop(1).h + 1 / dpr, `${at}: rows apart`);
				// the top row stays square and the cards keep their 120:72 within a device pixel
				for (const b of snap.blocks) {
					const e = exact.blocks[b.i];
					assert.ok(Math.abs(b.w - e.w) <= 0.5 / dpr + 1e-9 && Math.abs(b.h - e.h) <= 0.5 / dpr + 1e-9, `${at}: block ${b.i} ${b.w}x${b.h}, exact ${e.w.toFixed(2)}x${e.h.toFixed(2)}`);
					assert.ok(Math.abs(b.x - e.x) <= 2 / dpr && Math.abs(b.y - e.y) <= 2 / dpr, `${at}: block ${b.i} at ${b.x},${b.y}, exact ${e.x.toFixed(2)},${e.y.toFixed(2)}`);
				}
			}
		}
	}
});

test('the logo is the Dock icon without its plate: the blocks and the Dock\'s own dot, cream centre and all, in a glow (preference「logo 处处同应用图标」)', () => {
	const d = palette.DISPATCH_ICON_DOT, glow = 1.6;
	assert.deepEqual(iconLayout.DISPATCH_ICON_MARK, { w: d.cx + d.r * glow, h: d.cy + d.r * glow }, 'the box holds the blocks and the glow');
	for (const size of [34, 48, 120, 153]) {
		for (const tight of [false, true]) {
			const L = iconLayout.dispatchIconLayout(size, { mark: true, tight });
			const at = `${size}px${tight ? ' tight' : ''}`;
			assert.equal(L.height, tight ? iconLayout.DISPATCH_ICON_MARK.h * L.k : size, `${at}: height`);
			assert.ok(Math.abs(L.blocks[3].x + L.blocks[3].w - 600 * L.k) < 1e-9, `${at}: the blocks' width`);
			assert.ok(Math.abs(L.dot.cx - (L.blocks[0].x + d.cx * L.k)) < 1e-9 && Math.abs(L.dot.cy - (L.blocks[0].y + d.cy * L.k)) < 1e-9 && Math.abs(L.dot.r - d.r * L.k) < 1e-9, `${at}: the Dock's dot where the Dock has it`);
			assert.ok(L.dot.cx + L.dot.glow <= size + 1e-9 && L.dot.cy + L.dot.glow <= L.height + 1e-9, `${at}: the glow inside the box`);
			assert.ok(Math.abs(L.dot.inner - d.inner * L.k) < 1e-9, `${at}: the Dock dot's cream centre`);
		}
	}
	// 153px wide: 28px blocks, as the splash and the empty editor had them
	assert.ok(Math.abs(iconLayout.dispatchIconLayout(153, { mark: true, tight: true }).blocks[0].w - 28) < 0.1);
	const svg = iconLayout.dispatchIconSvg(48, { mark: true });
	assert.match(svg, /class="dispatch-icon mark"/);
	assert.doesNotMatch(svg, /class="plate"|stroke/, 'no plate, no ring drawn as a line');
	const r = Math.round(d.inner * iconLayout.dispatchIconLayout(48, { mark: true }).k * 1000) / 1000;
	assert.match(svg, new RegExp(`<circle class="disc"[^>]*/><circle class="centre"[^>]*r="${r}" fill="${palette.DISPATCH_ICON_COLORS.cream}"/></g>`), 'the cream centre on the disc, as the Dock has it');
	assert.match(svg, /<radialGradient id="dispatch-icon-glow-\d+">/, 'the glow');
	assert.match(svg, /<g class="now"><circle class="glow"[^>]*fill="url\(#dispatch-icon-glow-\d+\)"[^>]*\/><circle class="disc"/, 'the glow under the disc');
	const css = iconLayout.dispatchIconBreathCss('.now');
	assert.match(css, /\.now:has\(> \.glow\) \{ animation: none; \}/, 'the disc stays solid');
	assert.match(css, /\.now > \.glow \{ animation: dispatch-icon-glow 1600ms ease-in-out infinite; \}/, 'the glow breathes as the dot does everywhere');
	assert.match(css, /prefers-reduced-motion: reduce\) \{ \.now, \.now > \.glow \{ animation: none; \} \}/);
	// the places that draw the logo
	for (const [file, call] of [
		['sessions/contrib/dispatchBlocks/browser/dispatchBlocks.ts', /dispatchIconElement\(size, \{ ghosts: true, mark: true \}\)/],
		['workbench/browser/parts/editor/dispatchEditorMark.ts', /dispatchIconElement\(MARK_SIZE, \{ ghosts: true, tight: true, mark: true \}\)/],
		['sessions/contrib/aquarium/browser/dispatchSwarm.ts', /dispatchIconLayout\(ICON_W, \{ mark: true, tight: true \}\)/],
	]) {
		assert.match(fs.readFileSync(path.join(vs, file), 'utf8'), call, file);
	}
	assert.match(ICON_FILES['sessions/contrib/files/browser/media/dispatch-mark.svg'], /class="dispatch-icon mark"/, 'the empty Files view');
});

// design/icon-motion/index.html, scheme 3 (落块), its step as it is there: the drop must move frame for frame like it
function designStep(d, dt, now, t0, gap) {
	if (!d.started && now - t0 > d.k * gap) { d.started = true; d.y = -40; d.vy = 0; }
	if (!d.started || d.done) { return; }
	d.vy += 0.0018 * dt; d.y += d.vy * dt;
	if (d.y >= d.sy) { d.y = d.sy; if (d.vy > 0.12) { d.vy = -d.vy * 0.28; } else { d.done = true; d.vy = 0; } }
}

test('the drop is the design\'s 落块 frame for frame: order, 220ms apart, the fall, two bounces, at rest', () => {
	const D = iconLayout.DISPATCH_ICON_DROP;
	assert.deepEqual([...D.order], [8, 9, 4, 5, 6, 7, 0, 1, 2, 3]);
	assert.equal(D.gapMs, 220);
	// the design's stage: 460 high, the icon's top row at 0.22 of it less half the icon (22px blocks 7px apart)
	const y0 = 460 * 0.22 - (3 * 22 + 2 * 7) / 2;
	assert.ok(Math.abs(D.fall - (40 + y0)) < 1e-9);
	for (const dt of [1000 / 60, 1000 / 120, 33]) {
		// the design's blocks stand in rows 29px apart, the icon's at its own rows (scaled to 22px blocks): compare
		// how far above its place each block is, frame by frame
		const ours = D.order.map(i => ({ i, s: undefined }));
		const theirs = D.order.map((i, k) => {
			const b = palette.DISPATCH_ICON_BLOCKS[i];
			return { k, sy: y0 + b.y * 22 / b.w, y: -40, vy: 0, started: false, done: false };
		});
		let bounces = 0;
		for (let now = dt; now < 4000; now += dt) {
			for (const [k, o] of ours.entries()) {
				if (!o.s && now > k * D.gapMs) {
					o.s = iconLayout.dispatchDropStart(o.i);
				}
				if (o.s) {
					const was = o.s.vy;
					iconLayout.dispatchDropStep(o.s, dt);
					bounces += was > 0 && o.s.vy < 0 ? 1 : 0;
				}
				designStep(theirs[k], dt, now, 0, D.gapMs);
				const t = theirs[k];
				if (t.started) {
					assert.ok(Math.abs(o.s.y - (t.y - t.sy)) < 1e-6, `dt ${dt} t ${now} block ${o.i}: ${o.s.y} vs ${t.y - t.sy}`);
					assert.equal(o.s.done, t.done);
				}
			}
		}
		assert.ok(ours.every(o => o.s.done && o.s.y === 0), 'all at rest in their places');
		assert.equal(bounces, 20, `two bounces a block at dt ${dt}`);
	}
});

// The drawing the session rows run (base/browser/dispatchIcon.ts) on a stand-in for the DOM: the SVG nodes as they are
// built, a clock that runs the window's frames and timers. What it moves is read back from the rects' transforms.
function fakeIcon(size, dpr, other) {
	const nodes = iconLayout.dispatchIconNodes(size, { plate: false, dot: false, fill: 'theme', dpr });
	const clock = other ? other.clock : { now: 0, frames: [], timers: [], id: 0 };
	const win = other ? other.win : {
		performance: { now: () => clock.now },
		requestAnimationFrame: cb => { clock.frames.push({ id: ++clock.id, cb }); return clock.id; },
		cancelAnimationFrame: id => { clock.frames = clock.frames.filter(f => f.id !== id); },
		setTimeout: (cb, ms) => { clock.timers.push({ id: ++clock.id, cb, at: clock.now + ms }); return clock.id; },
		clearTimeout: id => { clock.timers = clock.timers.filter(t => t.id !== id); },
	};
	const all = [];
	const make = n => {
		const attrs = new Map(Object.entries(n.attrs));
		const el = {
			tag: n.tag, attrs, ownerDocument: { defaultView: win },
			dataset: Object.fromEntries([...attrs].filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])),
			classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
			getAttribute: k => attrs.has(k) ? attrs.get(k) : null,
			setAttribute: (k, v) => attrs.set(k, String(v)),
			removeAttribute: k => attrs.delete(k),
			querySelectorAll: sel => {
				const [tag, cls] = sel.split('.');
				return all.filter(e => e.tag === tag && (e.attrs.get('class') || '').split(' ').includes(cls));
			},
		};
		all.push(el);
		(n.children || []).forEach(make);
		return el;
	};
	const svg = make(nodes);
	const blk = i => all.find(e => e.tag === 'rect' && e.attrs.get('class') === 'blk' && e.dataset.i === String(i));
	/** Where block i is drawn now: px above its place (0 in place), undefined while hidden. */
	const y = i => {
		const r = blk(i);
		if (r.attrs.get('visibility') === 'hidden') {
			return undefined;
		}
		const t = r.attrs.get('transform');
		return t ? Number(/translate\(0 (-?[\d.]+)\)/.exec(t)[1]) : 0;
	};
	/** One frame of `dt` ms: the timers that come due, then the frames asked for. */
	const frame = dt => {
		clock.now += dt;
		for (const t of clock.timers.filter(t => t.at <= clock.now)) {
			clock.timers = clock.timers.filter(x => x !== t);
			t.cb();
		}
		const due = clock.frames;
		clock.frames = [];
		due.forEach(f => f.cb(clock.now));
	};
	return { svg, blk, y, frame, clock, win };
}

test('a running session\'s icon is the design\'s 落块 itself: its height scaled to the blocks, no speed-up, 220ms apart, a rest, again', async () => {
	const browserIcon = await import(pathToFileURL(path.join(vs, 'base/browser/dispatchIcon.ts')));
	const D = iconLayout.DISPATCH_ICON_DROP;
	const y0 = 460 * 0.22 - (3 * 22 + 2 * 7) / 2;
	for (const dpr of [1, 2]) {
		const icon = fakeIcon(16, dpr);
		const scale = Number(icon.blk(0).attrs.get('width')) / D.block;
		const looping = browserIcon.dispatchIconRounds(icon.svg);
		const dt = 1000 / 60;
		// the design's own blocks for the same round, in its stage, then scaled to this drawing's blocks
		const theirs = D.order.map((i, k) => {
			const b = palette.DISPATCH_ICON_BLOCKS[i];
			return { i, k, sy: y0 + b.y * 22 / b.w, y: -40, vy: 0, started: false, done: false };
		});
		const path0 = D.order.map(() => []);
		let now = 0, formed = -1;
		for (; now < 3000; now += dt) {
			icon.frame(dt);
			if (formed < 0 && !icon.svg.classList.set.has('dropping') && D.order.every(i => icon.y(i) === 0)) {
				formed = icon.clock.now;
			}
			for (const t of theirs) {
				designStep(t, dt, now + dt, 0, D.gapMs);
				const ours = icon.y(t.i);
				if (!t.started) {
					assert.equal(ours, undefined, `dpr ${dpr} t ${now}: block ${t.i} shows before its turn`);
					continue;
				}
				const want = Math.round((t.y - t.sy) * scale * 100) / 100;
				assert.ok(Math.abs(ours - want) < 1e-9, `dpr ${dpr} t ${Math.round(now)} block ${t.i}: ${ours} px, the design ${want} px`);
				path0[t.k].push(ours);
			}
		}
		assert.ok(theirs.every(t => t.done), 'a round is done in 3s');
		for (const [k, p] of path0.entries()) {
			const r = icon.blk(D.order[k]);
			const top = Number(r.attrs.get('y')) + p[0];
			// it starts above the 16px box, where a row (32px, the box in its middle) still shows part of it
			assert.ok(top < 0 && top + Number(r.attrs.get('height')) > -8, `dpr ${dpr} block ${D.order[k]} starts at ${top}px`);
			// falling: each frame further than the one before, until it lands (the landing frame stops short at 0)
			const land = p.indexOf(0);
			const steps = p.slice(0, land).map((v, n, a) => n ? v - a[n - 1] : 0).slice(1);
			assert.ok(land > 15 && steps.every((s, n) => !n || s > steps[n - 1]), `dpr ${dpr} block ${D.order[k]}: ${steps}`);
			// two bounces: back up off its place twice, then still
			const ups = p.filter((v, n) => n && p[n - 1] === 0 && v < 0).length;
			assert.equal(ups, 2, `dpr ${dpr} block ${D.order[k]} bounces ${ups} times`);
		}
		// the full icon rests restMs, then the grid empties and the next round falls from the top again
		let emptied = -1, again = -1;
		for (now = 0; now < 8000 && again < 0; now += dt) {
			// the grid empties: the last block of the round is gone (the first may already be falling again)
			if (emptied < 0 && D.order.slice(1).every(i => icon.y(i) === undefined)) {
				emptied = icon.clock.now;
			} else if (emptied >= 0 && icon.y(D.order[0]) !== undefined) {
				again = icon.clock.now;
			}
			icon.frame(dt);
		}
		assert.equal(D.restMs, 1000);
		assert.ok(formed > 2200 && formed < 2700, `dpr ${dpr}: the round is full at ${formed}ms`);
		assert.ok(Math.abs(emptied - formed - D.restMs) <= dt, `dpr ${dpr}: full at ${formed}ms, empty at ${emptied}ms`);
		assert.ok(again - emptied <= 2 * dt && icon.y(D.order[0]) < -9, `dpr ${dpr}: the next round falls at ${again}ms from ${icon.y(D.order[0])}px`);
		// one made later in the same window (the title bar's, the Now tab's) shows the same moment of the round
		const later = fakeIcon(16, dpr, icon);
		const second = browserIcon.dispatchIconRounds(later.svg);
		for (let n = 0; n < 400; n++) {
			icon.frame(dt);
			assert.deepEqual(D.order.map(later.y), D.order.map(icon.y), `dpr ${dpr} t ${Math.round(icon.clock.now)}: out of step`);
		}
		const R = iconLayout.dispatchIconRound();
		assert.ok(Math.abs(R.dropMs - formed) <= dt && R.roundMs === R.dropMs + D.restMs, `dpr ${dpr}: ${JSON.stringify(R)} formed ${formed}`);
		looping.dispose();
		second.dispose();
		assert.equal(icon.clock.timers.length + icon.clock.frames.length, 0, 'disposed: no timer, no frame left');
	}
	// the rows run exactly this: no style of their own (10-21's「从图标上沿、快 1.8 倍、每 1.5 秒一块」is gone)
	const rows = fs.readFileSync(path.join(vs, 'sessions/browser/dispatchStatusBlocks.ts'), 'utf8');
	assert.match(rows, /disposable: dispatchIconRounds\(svg\)/);
	assert.doesNotMatch(rows, /fromTop|speed|setInterval|1500/);
	assert.doesNotMatch(fs.readFileSync(path.join(vs, 'base/browser/dispatchIcon.ts'), 'utf8'), /fromTop|speed/);
	assert.match(fs.readFileSync(path.join(vs, 'sessions/browser/media/dispatchStatusBlocks.css'), 'utf8'), /\.dispatch-status-blocks\.running > svg \{\s*overflow: visible;/);
});

test('every place that draws the icon takes it from the one layout, none writes its own pixels or its own drop', () => {
	const users = {
		'workbench/browser/parts/editor/dispatchEditorMark.ts': /dispatchIconElement\(/,
		'sessions/contrib/dispatchBlocks/browser/dispatchBlocks.ts': /dispatchIconElement\(/,
		'sessions/browser/dispatchStatusBlocks.ts': /dispatchIconElement\(/,
		'sessions/contrib/dispatchInbox/electron-browser/dispatchInbox.contribution.ts': /createDispatchBlocks\(/,
		'sessions/contrib/dispatchTurbo/browser/dispatchTurboMark.ts': /dispatchIconLayout\(/,
		'sessions/contrib/aquarium/browser/dispatchSwarm.ts': /dispatchIconLayout\(/,
	};
	for (const [file, use] of Object.entries(users)) {
		const text = fs.readFileSync(path.join(vs, file), 'utf8');
		assert.match(text, use, file);
		// the swarm paints the logo's dot with the dot's own drawing (drawDispatchDot), where the layout puts it
		assert.doesNotMatch(text, file.includes('dispatchSwarm') ? /\* 37\b|\[0, 37, 60\]|\[2\.5, 7, 10\.5\]|DISPATCH_ICON_SIZE/ : /\* 37\b|\[0, 37, 60\]|\[2\.5, 7, 10\.5\]|drawDispatchDot|DISPATCH_ICON_SIZE/, `${file} lays the icon out itself`);
	}
	for (const css of ['workbench/browser/parts/editor/media/dispatchEditorMark.css', 'sessions/browser/media/dispatchStatusBlocks.css',
		'sessions/contrib/dispatchBlocks/browser/media/dispatchBlocks.css', 'sessions/contrib/dispatchTurbo/browser/media/dispatchTurbo.css']) {
		const text = fs.readFileSync(path.join(vs, css), 'utf8');
		assert.doesNotMatch(text, /calc\(var\(--col\) \* 37px\)|dispatch-(mark|status|assistant|splash|turbo)-drop|\.dispatch-status-block\.col-/, `${css} draws or drops the icon itself`);
	}
});

test('the loading splash keeps the icon from before 10-10 (task-24xd4): its blocks from the palette and the Dock\'s big dot', () => {
	// the person's call (preference「启动图标用之前的」): only the splash, every other place takes the one layout above
	const text = fs.readFileSync(path.join(vs, 'base/browser/dispatchSplash.ts'), 'utf8');
	assert.match(text, /DISPATCH_ICON_BLOCKS/, 'the blocks come from the palette');
	assert.match(text, /DISPATCH_ICON_DOT\b/, 'the dot is the Dock\'s');
	assert.match(text, /dispatchDotCss\(\)/, 'drawn with the shared dot');
	assert.doesNotMatch(text, /dispatchIconElement\(|DISPATCH_ICON_RUNNING_DOT/, 'not the one layout');
});

test('the loading splash loads before the workbench: what it imports pulls in none of the DOM helpers', () => {
	// base/browser/window.js defines vscodeWindowId on the window; imported before the workbench's bootstrap does
	// it, the editor window stopped loading behind the splash
	const seen = new Set();
	const walk = rel => {
		if (seen.has(rel)) {
			return;
		}
		seen.add(rel);
		const text = fs.readFileSync(path.join(vs, rel), 'utf8');
		for (const m of text.matchAll(/^import (?!type )[^'"]*['"](\.[^'"]+)\.js['"]/gm)) {
			walk(path.relative(vs, path.resolve(path.dirname(path.join(vs, rel)), m[1] + '.ts')));
		}
	};
	walk('base/browser/dispatchSplash.ts');
	assert.deepEqual([...seen].filter(f => /base\/browser\/(dom|window|domStylesheets)\.ts$/.test(f)), [], [...seen].join(', '));
});
