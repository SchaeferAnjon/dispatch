// Settings › Keys and the "Key saved" toast (kanban task-d5ejn), the way a person meets them. The instance has a HOME of
// its own (fixtures/keys_home.py: two made-up keys), so nothing here reads or writes this Mac's real key store.
//   1 the page lists the two keys: name, purpose, project, the value hidden
//   2 Add key → "Key saved: NAME — purpose" → Show flashes its row → Undo takes it out again
//   3 Edit: a new value and purpose, saved; the eye shows the new value; Copy puts it on the clipboard
//   4 Delete asks first, the toast says Key deleted, Undo brings it back; the store before is kept in backups
//   5 `dispatch env set` in the instance's terminal brings up the toast too, and tells the agent what to call the key
//   6 Settings search finds the page by "api key"
//   7 no made-up value anywhere in the instance but the store, its shell copies and the backups
// Every check is noted in facts.json; the run fails at the end when one did not hold.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = {
	instance: { fixture: 'keys-home' },
	exclusive: true,
	title: '设置 › Keys：密钥库在 IDE 里看得见、管得了，存下就有提示',
	description: '列出 key（名字、用途、项目、打码的值）；新增一个假 key 弹 Key saved，Show 跳到那一行，Undo 撤掉；改值和用途、点眼睛看值、复制；删除先确认、能撤回；终端里 dispatch env set 也弹提示；设置搜索 api key 找到这一页；值不出现在日志和界面文字里。',
	timeout: 900,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const META = 4;
const NEW = { name: 'FAKE_DEMO_KEY', value: 'fake-e2e-added-0004', note: 'Demo service for the e2e test' };
const EDIT = { value: 'fake-e2e-edited-0005', note: 'Search API, new key for the e2e test' };
const TERM = { name: 'FAKE_TERM_KEY', note: 'Saved from the terminal', value: 'fake-e2e-terminal-0003' };
const CHAT = { name: 'FAKE_CHAT_KEY', note: 'Saved by an agent in a chat', value: 'fake-e2e-chat-0006' };
// what fixtures/keys_home.py put in the store
const SEED = [
	{ name: 'FAKE_SEED_SEARCH_KEY', value: 'fake-e2e-seed-search-0001', note: 'Search API for the e2e test', project: '' },
	{ name: 'FAKE_SEED_DEMO_KEY', value: 'fake-e2e-seed-demo-0002', note: 'Demo project\'s own service', project: 'demo' },
];

export default async function (ui) {
	const rec = ui.rec;
	if (!rec.keys_home) {
		throw new Error('Start this instance with --fixture keys-home (meta.instance), so it has a HOME of its own');
	}
	const store = path.join(rec.keys_home, '.config', 'dispatch', 'env');
	const seed = SEED;
	const allValues = [...seed.map(s => s.value), NEW.value, EDIT.value, TERM.value, CHAT.value];
	const facts = { failed: [], passed: [] };
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => { (ok ? facts.passed : facts.failed).push(message); save(); };
	const until = async (fn, ms, step = 300) => { const end = Date.now() + ms * SCALE; let v; while (Date.now() < end) { v = await fn().catch(() => undefined); if (v) return v; await ui.sleep(step); } return v; };
	/** The store as the CLI keeps it: {NAME: {value, note, project}}. */
	const keys = () => {
		const out = {};
		let note = '', project = '';
		for (const line of (fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : '').split('\n')) {
			if (!line.trim()) { note = ''; project = ''; continue; }
			if (line.startsWith('#')) { const c = line.replace(/^#\s*/, ''); const m = /^project:\s*(.*)$/.exec(c); if (m) project = m[1]; else note = c; continue; }
			const i = line.indexOf('=');
			if (i > 0) { out[line.slice(0, i)] = { value: line.slice(i + 1).replace(/^'(.*)'$/, '$1'), note, project }; note = ''; project = ''; }
		}
		return out;
	};
	const page = () => ui.eval(`(() => ({
		rows: [...document.querySelectorAll('.dispatch-settings-page .dset-key-row')].map(r => ({
			name: r.dataset.key,
			detail: r.querySelector('.dset-row-detail')?.textContent || '',
			tag: r.querySelector('.dset-tag')?.textContent || '',
			value: r.querySelector('.dset-key-val')?.textContent || '',
			shown: r.querySelector('.dset-key-val')?.classList.contains('shown') || false,
			flash: r.classList.contains('dset-flash'),
		})),
		count: document.querySelector('.dispatch-settings-page .dset-gh-r')?.textContent || '',
		status: document.querySelector('.dset-keys-status')?.textContent || '',
		problem: document.querySelector('.dispatch-settings-page .dset-problem:not([hidden])')?.textContent || '',
		title: document.querySelector('.custom-view-node[data-view-id="dispatch.settings"] .custom-view-header-title')?.textContent || '',
		text: document.querySelector('.dispatch-settings-page')?.innerText || '',
	}))()`);
	const toast = () => ui.eval(`(() => { const t = [...document.querySelectorAll('.dispatch-keys-toast')].find(e => e.getClientRects().length && !e.classList.contains('out')); return t ? { text: t.innerText.replace(/\\s+/g, ' ').trim(), keys: t.dataset.keys || '', float: !!t.closest('.dispatch-keys-toast-float'), inChat: !!t.closest('.dispatch-keys-toast-slot') } : null; })()`);
	const waitToast = (re, ms = 15000) => until(async () => { const t = await toast(); return t && re.test(t.text) ? t : undefined; }, ms);
	const row = name => `.dispatch-settings-page .dset-key-row[data-key="${name}"]`;
	const noValueIn = (text, where) => { const hit = allValues.find(v => text.includes(v)); check(!hit, `no value in ${where}${hit ? ` (found ${hit.slice(0, 12)}…)` : ''}`); };
	/** Typed straight into the focused box, so the made-up value is not written into steps.json either. */
	const typeSecret = async (css, text) => {
		await ui.click({ css });
		await ui.cdp.send('Input.insertText', { text });
		await ui.sleep(200);
	};
	const closeTips = async () => {
		for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
			await ui.click({ css: '.dispatch-tour-close' });
			await ui.sleep(400);
		}
	};

	try {
		await ui.attach('agents', 90000);
		await ui.eval('window.resizeTo(1440, 900)');
		await ui.sleep(2500);
		await closeTips();

		// ---- 1 the page
		await ui.press('Cmd+,');
		await ui.waitFor({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' }, { timeoutMs: 20000 });
		await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' });
		let p = await until(async () => { const x = await page(); return x.rows.length >= seed.length ? x : undefined; }, 30000);
		facts.first = p && { rows: p.rows, count: p.count, title: p.title };
		check(p && p.title.endsWith('Keys'), `the page is titled Keys (${p && p.title})`);
		check(p && seed.every(s => p.rows.some(r => r.name === s.name && r.detail === s.note)), 'both keys are listed with what each is for');
		check(p && p.rows.find(r => r.name === 'FAKE_SEED_DEMO_KEY')?.tag === 'demo' && p.rows.find(r => r.name === 'FAKE_SEED_SEARCH_KEY')?.tag === 'Every project', 'each key says which project it belongs to');
		check(p && p.rows.every(r => /^•+$/.test(r.value) && !r.shown), 'every value is hidden');
		check(p && p.count === '2 keys', `the head counts them (${p && p.count})`);
		noValueIn(p ? p.text : '', 'the page');
		const fonts = await ui.eval(`(() => { const r = document.querySelector('.dispatch-settings-page .dset-key-row'); const f = e => e ? getComputedStyle(e).fontFamily : ''; const mono = getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--monaco-monospace-font'); return { name: f(r && r.querySelector('.dset-key-name')), tag: f(r && r.querySelector('.dset-tag')), tagSize: r ? getComputedStyle(r.querySelector('.dset-tag')).fontSize : '', tagWeight: r ? getComputedStyle(r.querySelector('.dset-tag')).fontWeight : '', mono }; })()`);
		facts.fonts = fonts;
		check(fonts.tag && fonts.tag !== fonts.name && !/mono|menlo|courier|sf mono/i.test(fonts.tag) && fonts.tagSize === '11px' && fonts.tagWeight === '500', `the project tag is in the page's font, 11/500, the key name in monospace (${JSON.stringify(fonts)})`);
		// Search keys (kanban memo 2026-10-19: "this needs a search"): the words narrow the list, clearing them brings all back
		await ui.click({ css: '.dispatch-settings-page .dset-keys-search input' });
		await ui.cdp.send('Input.insertText', { text: 'own service' });
		const searched = await until(async () => { const x = await page(); return x.rows.length === 1 ? x : undefined; }, 5000);
		check(searched && searched.rows[0].name === 'FAKE_SEED_DEMO_KEY', `Search keys "own service" leaves the one key it describes (${searched && searched.rows.map(r => r.name)})`);
		await ui.screenshot('01b-keys-search');
		await ui.eval(`(() => { const i = document.querySelector('.dispatch-settings-page .dset-keys-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		const listedAgain = await until(async () => { const x = await page(); return x.rows.length >= seed.length ? x : undefined; }, 5000);
		check(!!listedAgain, 'clearing the search lists every key again');
		await ui.screenshot('01-keys');
		await ui.mark({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' }, { what: 'Keys 页入口', where: '设置左栏 Soul 下面', how: '⌘, 打开设置，点 Keys' });
		await ui.mark({ css: row('FAKE_SEED_DEMO_KEY') }, { what: '一个 key：名字、项目、用途，值打码', where: '列表里一行', how: '眼睛看值，复制；悬停出编辑和删除' });

		// ---- 2 add one: the toast, Show, Undo
		await ui.click({ css: '.dispatch-settings-page [data-keys="add"]' });
		await ui.waitFor({ css: '.dset-keys-form[data-keys="add-form"]' }, { timeoutMs: 5000 });
		await ui.type(NEW.name, { into: { css: 'input[data-keys="name"]' } });
		await typeSecret('input[data-keys="value"]', NEW.value);
		await ui.type(NEW.note, { into: { css: 'input[data-keys="note"]' } });
		check(await ui.eval(`document.querySelector('input[data-keys="value"]').type === 'password'`), 'the value box hides what is pasted');
		const formLook = await ui.eval(`(() => { const f = document.querySelector('.dset-keys-form'); const cs = getComputedStyle(f); const l = document.querySelector('.dset-keys-list'); return { bg: cs.backgroundColor, shadow: cs.boxShadow, first: !!f.closest('.dset-keys-top'), under: l ? getComputedStyle(l).borderTopWidth + ' ' + getComputedStyle(l).borderTopStyle : '', inCard: !!f.closest('.dset-rows.dset-keys') }; })()`);
		facts.formLook = formLook;
		check(formLook.inCard && formLook.first && /^(rgba\(0, 0, 0, 0\)|transparent)$/.test(formLook.bg) && formLook.shadow === 'none' && formLook.under === '1px solid', `the form is the list card's first part, a hairline under it, no box of its own (${JSON.stringify(formLook)})`);
		await ui.screenshot('02-add-form');
		await ui.mark({ css: '.dset-keys-form' }, { what: '新增 key 的表单', where: '列表最上面，点搜索框旁的 Add key 打开', how: '名字、项目、值（密码框）、用途，Save key 保存' });
		await ui.click({ css: '[data-keys="save"]' });
		let t = await waitToast(/Key saved:/);
		facts.toastAdd = t;
		check(t && t.text.includes(`Key saved: ${NEW.name} — ${NEW.note}`), `the toast says "Key saved: ${NEW.name} — ${NEW.note}" (${t && t.text})`);
		check(t && /Show/.test(t.text) && /Undo/.test(t.text), 'the toast has Show and Undo');
		noValueIn(t ? t.text : '', 'the toast');
		check(keys()[NEW.name]?.value === NEW.value && keys()[NEW.name]?.note === NEW.note, 'the key is in the store with its purpose');
		p = await until(async () => { const x = await page(); return x.rows.some(r => r.name === NEW.name) ? x : undefined; }, 10000);
		check(!!p, 'the new key shows in the list');
		check(p && !p.status, `saving says nothing under the list, the toast says it (${p && p.status})`);
		await ui.screenshot('03-key-saved-toast');
		await ui.mark({ css: '.dispatch-keys-toast' }, { what: 'Key saved 提示：名字和用途，不含值', where: '窗口底部正中', how: '谁存的都弹；Show 跳到那一行，Undo 撤回这次写入' });
		// Show: the row, flashed
		await ui.click({ css: '.dispatch-keys-toast [data-toast="show"]' });
		const flashed = await until(async () => { const x = await page(); return x.rows.find(r => r.name === NEW.name && r.flash) ? x : undefined; }, 5000, 100);
		check(!!flashed, 'Show goes to the key\'s row and flashes it');
		await ui.screenshot('04-show-row');
		// Undo: gone again
		t = await toast();
		check(!!t, 'the toast stays after Show, so Undo is still there');
		await ui.click({ css: '.dispatch-keys-toast [data-toast="undo"]' });
		t = await waitToast(/Undone/);
		facts.toastUndo = t;
		check(t && t.text.includes(`Undone: ${NEW.name} removed`), `Undo says the key is removed (${t && t.text})`);
		check(!keys()[NEW.name], 'after Undo the key is out of the store');
		p = await until(async () => { const x = await page(); return !x.rows.some(r => r.name === NEW.name) ? x : undefined; }, 10000);
		check(!!p, 'after Undo the row is gone');
		await ui.screenshot('05-undone');

		// ---- 3 edit, show, copy
		const S = seed[0].name;
		// Undo's change comes back from the bridge too and the list is drawn once more: a row hovered before that loses
		// the pointer, and its Edit fades out before it is pressed (as in step 4)
		await ui.sleep(800);
		await ui.hover({ css: row(S) });
		await ui.click({ css: `${row(S)} [data-keys="edit"]` });
		await ui.waitFor({ css: '.dset-keys-form[data-keys="edit-form"]' }, { timeoutMs: 5000 });
		await typeSecret('input[data-keys="value"]', EDIT.value);
		await ui.eval(`(() => { const i = document.querySelector('input[data-keys="note"]'); i.focus(); i.select(); })()`);
		await ui.type(EDIT.note);
		await ui.screenshot('06-edit-form');
		await ui.mark({ css: '.dset-keys-form' }, { what: '改值和用途', where: '那一行下面展开', how: '值留空就不改，只改用途' });
		await ui.click({ css: '[data-keys="save"]' });
		t = await waitToast(new RegExp(`Key saved: ${S}`));
		check(t && t.text.includes(`Key saved: ${S} — ${EDIT.note}`), `editing brings up the toast with the new purpose (${t && t.text})`);
		check(keys()[S]?.value === EDIT.value && keys()[S]?.note === EDIT.note && keys()[S]?.project === '', 'the new value and purpose are in the store, the project kept');
		// the eye (no picture while a value is on screen)
		await until(async () => (await page()).rows.find(r => r.name === S && r.detail === EDIT.note), 10000);
		await ui.click({ css: `${row(S)} [data-keys="eye"]` });
		const shown = await until(async () => (await page()).rows.find(r => r.name === S && r.shown), 10000);
		check(shown && shown.value === EDIT.value, 'the eye shows the value');
		await ui.click({ css: `${row(S)} [data-keys="eye"]` });
		const hidden = await until(async () => (await page()).rows.find(r => r.name === S && !r.shown), 5000);
		check(hidden && /^•+$/.test(hidden.value), 'the eye hides it again');
		// copy
		let before = '';
		try { before = execFileSync('pbpaste', { encoding: 'utf8', timeout: 5000 }); } catch { /* none */ }
		await ui.click({ css: `${row(S)} [data-keys="copy"]` });
		const copied = await until(async () => { const c = execFileSync('pbpaste', { encoding: 'utf8', timeout: 5000 }); return c === EDIT.value ? c : undefined; }, 5000);
		check(copied === EDIT.value, 'Copy puts the value on the clipboard');
		p = await page();
		check(p.status === `${S} copied.`, `the page says it was copied, without the value (${p.status})`);
		execFileSync('pbcopy', { input: before, timeout: 5000 });
		await ui.screenshot('07-edited-copied');

		// ---- 4 delete: asked first, Undo brings it back
		const D = seed[1].name;
		// the toast of an earlier save is still up when the next change is sent: it leaves first, so its Undo cannot be
		// pressed for the wrong change (audit round 1, task-cq11p)
		await ui.hover({ css: row(S) });
		await ui.click({ css: `${row(S)} [data-keys="edit"]` });
		await ui.waitFor({ css: '.dset-keys-form[data-keys="edit-form"]' }, { timeoutMs: 5000 });
		await ui.eval(`(() => { const i = document.querySelector('input[data-keys="note"]'); i.focus(); i.select(); })()`);
		await ui.type(`${EDIT.note}, again`);
		await ui.click({ css: '[data-keys="save"]' });
		t = await waitToast(new RegExp(`Key saved: ${S} — ${EDIT.note}, again`));
		check(!!t, 'a Key saved toast is up right before the delete');
		// the list is drawn again after a save: wait for it, or the row loses the pointer before its Delete is pressed
		await until(async () => (await page()).rows.find(r => r.name === S && r.detail === `${EDIT.note}, again`), 10000);
		await ui.sleep(400);
		await ui.hover({ css: row(D) });
		await ui.click({ css: `${row(D)} [data-keys="delete"]` });
		await ui.waitFor({ text: `Delete ${D}?` }, { timeoutMs: 10000 });
		await ui.screenshot('08-delete-confirm');
		await ui.mark({ text: `Delete ${D}?` }, { what: '删除前确认', where: '窗口中间的对话框', how: '说明能撤回、备份留 30 天' });
		check(!!keys()[D], 'nothing is deleted before the answer');
		await ui.click({ text: 'Delete', exact: true, within: '.monaco-dialog-box' });
		const toasts = () => ui.eval(`[...document.querySelectorAll('.dispatch-keys-toast')].filter(e => e.getClientRects().length && !e.classList.contains('out')).map(e => e.innerText.replace(/\\s+/g, ' ').trim())`);
		const during = [];
		for (let t0 = Date.now(); Date.now() - t0 < 15000;) { const now = await toasts(); during.push(now); if (now.some(x => /Key deleted:/.test(x))) break; await ui.sleep(50); }
		facts.toastsDuringDelete = during.filter((now, i) => !i || JSON.stringify(now) !== JSON.stringify(during[i - 1]));
		check(during.every(now => now.length <= 1 && !now.some(x => /Key saved:/.test(x))), `the earlier Key saved toast leaves before the delete is sent (${JSON.stringify(facts.toastsDuringDelete).slice(0, 300)})`);
		t = await waitToast(/Key deleted:/);
		check(t && t.text.includes(`Key deleted: ${D} — ${seed[1].note}`) && /Undo/.test(t.text), `deleting brings up "Key deleted" with Undo (${t && t.text})`);
		check(!keys()[D], 'the key is out of the store');
		check(!(await page()).status, 'deleting says nothing under the list, the toast says it');
		const backups = path.join(rec.dispatch_home, 'backups');
		const kept = [];
		const walk = d => { for (const n of (fs.existsSync(d) ? fs.readdirSync(d) : [])) { const q = path.join(d, n); fs.statSync(q).isDirectory() ? walk(q) : kept.push(q); } };
		walk(backups);
		facts.backups = kept.map(k => path.relative(backups, k));
		check(kept.some(k => k.endsWith(path.join('.config', 'dispatch', 'env')) && fs.readFileSync(k, 'utf8').includes(seed[1].value)), 'the store with the deleted key is kept in ~/.dispatch/backups/<date>/');
		await ui.screenshot('09-deleted-toast');
		await ui.click({ css: '.dispatch-keys-toast [data-toast="undo"]' });
		t = await waitToast(/Undone/);
		check(t && t.text.includes(`Undone: ${D} is back`), `Undo brings it back (${t && t.text})`);
		check(keys()[D]?.value === seed[1].value && keys()[D]?.project === 'demo', 'the key is back with its value and project');
		p = await until(async () => { const x = await page(); return x.rows.some(r => r.name === D) ? x : undefined; }, 10000);
		check(!!p, 'its row is back');

		// ---- 5 the terminal
		await ui.press('Escape');
		await ui.sleep(800);
		let picker = false;
		for (let i = 0; i < 4 && !picker; i++) {
			if (i) {
				await closeTips();
				await ui.press('Escape');
			}
			await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
			await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: META });
			picker = await ui.waitFor({ css: '.dispatch-new-picker' }, { timeoutMs: 8000 }).then(() => true, () => false);
		}
		check(picker, '⌘T brings up the new-session picker');
		await ui.waitFor({ text: 'Blank terminal', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
		for (let i = 0; i < 60 && !(await ui.exists({ css: '.dispatch-new-picker .dnp-list .dnp-row' })); i++) await ui.sleep(500);
		await ui.sleep(800);
		await ui.click({ text: 'Terminal', exact: true, within: '.dispatch-new-picker' });
		await ui.sleep(400);
		await ui.click({ css: '.dispatch-new-picker .dnp-foot .dnp-blank' });
		for (const end = Date.now() + 40000 * SCALE; Date.now() < end; await ui.sleep(500)) {
			if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
			if (await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) break;
		}
		await ui.click({ css: '.dispatch-terminal-view .dispatch-xterm' });
		const screen = () => ui.eval(`(() => { const el = [...document.querySelectorAll('.dispatch-terminal-view .dispatch-xterm')].find(e => e.offsetParent); const t = el && el.xterm; if (!t) return ''; const b = t.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (!l) continue; if (l.isWrapped && out.length) out[out.length - 1] += l.translateToString(true); else out.push(l.translateToString(true)); } return out.join('\\n'); })()`);
		const shell = async text => {
			await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
			await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
			await ui.type(text);
			await ui.press('Enter');
		};
		await until(async () => (await screen()).trim(), 15000);
		await shell('clear; printf "KEYSHOME=%s\\n" "$HOME"');
		const home = await until(async () => (/^KEYSHOME=(.*)$/m.exec(await screen()) || [])[1], 20000);
		facts.terminalHome = home;
		// checked before anything is written: a terminal on the real HOME would write the real key store
		if (!home || fs.realpathSync(home) !== fs.realpathSync(rec.keys_home)) {
			throw new Error(`the terminal's HOME is ${home}, not the instance's ${rec.keys_home}: stopped before writing a key`);
		}
		await shell(`clear; dispatch env set ${TERM.name} --stdin --note "${TERM.note}" < ~/fake-term-value.txt && echo SET-DONE`);
		const said = await until(async () => { const s = await screen(); return /^SET-DONE$/m.test(s) ? s : undefined; }, 30000);
		facts.terminalSaid = said;
		check(said && new RegExp(`${TERM.name}`).test(said) && /Key saved: FAKE_TERM_KEY/.test(said), 'the CLI tells the agent what to call the key and that the person saw the toast');
		noValueIn(said || '', 'the terminal');
		t = await waitToast(/Key saved:/, 15000);
		facts.toastTerminal = t;
		check(t && t.text.includes(`Key saved: ${TERM.name} — ${TERM.note}`), `a key saved in the terminal brings up the toast too (${t && t.text})`);
		check(keys()[TERM.name]?.value === TERM.value, 'the terminal\'s key is in the store');
		await ui.screenshot('10-terminal-toast');
		await ui.mark({ css: '.dispatch-keys-toast' }, { what: '终端里 dispatch env set 也弹提示', where: '窗口底部', how: 'Agent 在对话里存 key 走同一条路' });
		await ui.click({ css: '.dispatch-keys-toast [data-toast="show"]' });
		const fromTerm = await until(async () => { const x = await page(); return x.rows.find(r => r.name === TERM.name && r.flash) ? x : undefined; }, 15000, 100);
		check(!!fromTerm, 'Show from the terminal\'s toast opens Settings › Keys at that row');
		await ui.screenshot('11-terminal-show');

		// ---- 6 search
		await ui.click({ css: '.dispatch-settings-nav .dsn-search input' });
		await ui.type('api key', { into: { css: '.dispatch-settings-nav .dsn-search input' } });
		const found = await until(() => ui.eval("[...document.querySelectorAll('.dispatch-settings-page .dset-row-label')].map(e => e.textContent)[0] || ''"), 8000);
		check(found === 'API keys', `searching Settings for "api key" finds API keys first (${found})`);
		await ui.screenshot('12-search');
		await ui.press('Escape');

		// ---- 5b a session on screen: the toast sits above its input, as "Preference remembered" does (an agent's
		// `dispatch env set` in its shell, made here by the CLI with an agent's variable set, so no model is asked)
		await ui.press('Escape');
		await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open' }, { timeoutMs: 8000, gone: true }).catch(() => undefined);
		await ui.newSession();
		const composer = await until(() => ui.eval(`[...document.querySelectorAll('.new-chat-input-area, .interactive-input-part')].some(e => e.getClientRects().length)`), 20000);
		check(composer, 'the new-session page with its message box is on screen');
		const boxTop = () => ui.eval(`(() => { const b = [...document.querySelectorAll('.new-chat-input-area')].find(e => e.getClientRects().length); return b ? Math.round(b.getBoundingClientRect().top) : null; })()`);
		// the page settles first (the pickers come in a moment after the box)
		let topBefore = await boxTop();
		for (let i = 0; i < 20; i++) { await ui.sleep(500); const now = await boxTop(); if (now === topBefore) break; topBefore = now; }
		const agentEnv = { ...process.env, HOME: rec.keys_home, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, CLAUDECODE: '1', DISPATCH_LANG: 'en' };
		const agentSaid = execFileSync('python3', [rec.cli, 'env', 'set', CHAT.name, '--stdin', '--note', CHAT.note], { input: CHAT.value, env: agentEnv, encoding: 'utf8', timeout: 60000 });
		facts.agentSaid = agentSaid;
		check(new RegExp(`call it ${CHAT.name} \\(${CHAT.note}\\)`).test(agentSaid) || agentSaid.includes(`${CHAT.name}（${CHAT.note}）`), `the agent is told to call it ${CHAT.name} (${CHAT.note})`);
		noValueIn(agentSaid, 'what the agent reads back');
		t = await waitToast(new RegExp(`Key saved: ${CHAT.name}`), 15000);
		facts.toastChat = t;
		// the new-session page: over the window's bottom, taking no room; the pickers and the box stay where they were
		check(t && t.float && !t.inChat, `on the new-session page the toast floats and takes no room (${JSON.stringify(t)})`);
		const room = await ui.eval(`(() => { const t = document.querySelector('.dispatch-keys-toast-float .dispatch-keys-toast'); const box = [...document.querySelectorAll('.new-chat-input-area')].find(e => e.getClientRects().length); if (!t || !box) return null; const a = t.getBoundingClientRect(), b = box.getBoundingClientRect(); return { toastTop: Math.round(a.top), toastBottom: Math.round(a.bottom), boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom) }; })()`);
		const topAfter = await boxTop();
		facts.chatRoom = { ...room, topBefore, topAfter };
		check(room && (room.toastTop >= room.boxBottom || room.toastBottom <= room.boxTop), `the toast does not cover the message box (${JSON.stringify(room)})`);
		check(topBefore !== null && topBefore === topAfter, `the message box does not move when the toast comes (${topBefore} → ${topAfter})`);
		await ui.screenshot('13-chat-toast');
		await ui.mark({ css: '.dispatch-keys-toast' }, { what: '新会话页上存的 key：提示浮在窗口底部', where: '新会话页底部正中', how: '不占位，胶囊和输入框不动；已有对话的会话里在输入框正上方' });
		await ui.click({ css: '.dispatch-keys-toast [data-toast="undo"]' });
		t = await waitToast(/Undone/);
		check(t && t.text.includes(`Undone: ${CHAT.name} removed`) && !keys()[CHAT.name], 'Undo from the session takes the agent\'s key out again');

		// ---- next to its neighbours, light and dark, for the side by side DESIGN.md asks for
		await ui.press('Cmd+,');
		for (const [pg, shot] of [['soul', '14-neighbour-soul'], ['keys', '15-keys-light']]) {
			await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${pg}"]` });
			await ui.sleep(2500);
			await ui.screenshot(shot);
		}
		await ui.setTheme('dark');
		await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' });
		await until(async () => (await page()).rows.length, 15000);
		await ui.sleep(1500);
		await ui.screenshot('16-keys-dark');
		await ui.hover({ css: row(seed[1].name) });
		await ui.click({ css: '.dispatch-settings-page [data-keys="add"]' });
		await ui.sleep(800);
		await ui.screenshot('17-add-form-dark');
		await ui.press('Escape');
		await ui.setTheme('light');

		// ---- 7 no value anywhere it should not be
		const allowed = [store, store + '.sh', path.join(rec.keys_home, '.config', 'dispatch', 'env.sh'), path.join(rec.keys_home, '.config', 'dispatch', 'env.fish'),
			path.join(rec.keys_home, 'fake-term-value.txt')].map(f => path.resolve(f));
		const leaks = [];
		const scan = d => {
			let names = [];
			try { names = fs.readdirSync(d); } catch { return; }
			for (const n of names) {
				const q = path.join(d, n);
				let st;
				try { st = fs.lstatSync(q); } catch { continue; }
				if (st.isSymbolicLink()) continue;
				if (st.isDirectory()) {
					if (path.resolve(q) === path.resolve(backups)) continue;
					scan(q);
				} else if (st.isFile() && st.size < 20 * 1024 * 1024 && !allowed.includes(path.resolve(q))) {
					let text = '';
					try { text = fs.readFileSync(q, 'latin1'); } catch { continue; }
					const hit = allValues.find(v => text.includes(v));
					if (hit) leaks.push(path.relative(rec.root, q));
				}
			}
		};
		scan(rec.root);
		facts.leaks = leaks;
		check(!leaks.length, `no made-up value in the instance's logs, settings or state (${leaks.join(', ') || 'none'})`);
	} finally {
		save();
		try {
			execFileSync('python3', [rec.cli, 'terminal', 'daemon', 'stop', '--json'], { env: { ...process.env, HOME: rec.keys_home, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home }, timeout: 60000 });
		} catch { /* already gone */ }
	}
	if (facts.failed.length) {
		throw new Error(`${facts.failed.length} check(s) failed: ${facts.failed.join(' | ')}`);
	}
}
