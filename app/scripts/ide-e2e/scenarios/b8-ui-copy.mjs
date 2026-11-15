// The 10-07 bug round's fixes around a session on a separate copy, with a real OpenCode on its cheap test model
// (DeepSeek V4.1 Flash). Start the instance with `dispatch ide instance start <name> --agents`.
//   task-lj06.27  Merge Changes says what it does in plain words with the project's name
//   task-lj06.28  ⌘T's panel and the title bar after a handoff to another agent say the project's name, not the copy's
// B8_HANDOFF=0 leaves out the handoff (it starts a turn of the other agent: Codex).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const meta = { needs: ['opencode', 'codex'], title: '10-07 修 bug：单独副本里的会话', description: 'Merge Changes 说人话、⌘T 面板和换 Agent 后的标题写项目名。', timeout: 1500 };

const fresh = '.sessions-chat-editor';

async function until(ui, fn, ms, step = 1000) {
	const end = Date.now() + ms;
	let v;
	while (Date.now() < end) {
		v = await fn().catch(() => undefined);
		if (v) return v;
		await ui.sleep(step);
	}
	return v;
}

async function focusInput(ui, css = fresh) {
	for (let i = 0; i < 8; i++) {
		await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
		await ui.sleep(400);
		if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
		await ui.sleep(800);
	}
	throw new Error('The message box does not take the focus');
}

async function clearBox(ui) {
	const typed = () => ui.eval(`(document.querySelector('${fresh} .view-lines')?.textContent || '').replace(/\\u00a0/g, ' ')`);
	await ui.press('End');
	for (let i = 0; i < 80 && (await typed()).trim(); i++) await ui.press('Backspace');
}

// deepseek/deepseek-flash, the project's test model (CLAUDE.md), picked the way own-copy.mjs does: the menu's
// row found under /model, then filtered by its name with the spaces left out and clicked
async function pickModel(ui) {
	await ui.press('Escape');
	await focusInput(ui);
	await clearBox(ui);
	await ui.type('/model');
	await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
	let seen = [];
	const name = await until(ui, async () => {
		seen = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent || '', desc: r.querySelector('.dsm-desc')?.textContent || '' }))`);
		return (seen.find(r => /deepseek-flash/i.test(r.desc)) || seen.find(r => /deepseek/i.test(r.name) && /flash/i.test(r.name)))?.name;
	}, 30000);
	if (!name) throw new Error(`deepseek-flash is not in the model menu: ${seen.map(r => `${r.name} / ${r.desc}`).join(', ')}`);
	await clearBox(ui);
	await ui.type(`/${name.replace(/\s+/g, '')}`);
	await until(ui, () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(name)})`), 20000, 500);
	await ui.click({ text: name, exact: true, within: '.dispatch-slash-menu' });
	await ui.press('Escape');
	await ui.sleep(1500);
	return name;
}

export default async function (ui) {
	if (!ui.rec.root.startsWith('/tmp/dide-e2e/') && !ui.rec.root.startsWith('/private/tmp/dide-e2e/')) throw new Error('Disposable instance required');
	const facts = { failed: [], passed: [] };
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => { (ok ? facts.passed : facts.failed).push(message); save(); };
	const project = path.basename(ui.demoFolder);
	const copies = `${ui.demoFolder}.worktrees`;
	const before = fs.existsSync(copies) ? fs.readdirSync(copies) : [];

	await ui.openAgents(ui.demoFolder);
	await ui.eval('window.resizeTo(1440, 900)');
	await ui.newSession();
	// B8_ENGINE: the agent the session starts with (OpenCode on deepseek-flash; the handoff goes to the other one)
	const engine = process.env.B8_ENGINE || 'OpenCode';
	const other = engine === 'Codex' ? 'OpenCode' : 'Codex';
	await ui.pickEngine(engine);
	// a separate copy (the switch under the box)
	if (await ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox .monaco-checkbox')?.getAttribute('aria-checked') === 'false'`)) {
		await ui.click({ css: '.sessions-chat-isolation-checkbox .monaco-checkbox' });
	}
	await ui.sleep(1000);
	await ui.pickEngine(engine);
	let picked = engine === 'OpenCode' ? await pickModel(ui) : '';
	// the pick shows on the page (the model chip); once more when it did not take
	if (picked && !(await ui.eval(`document.body.innerText.includes(${JSON.stringify(picked)})`))) picked = await pickModel(ui);
	await focusInput(ui);
	// what the model menu left in the box goes before the message
	await clearBox(ui);
	// the switch as it is right before the message (an agent or model picked after it may have made the session anew)
	const copyOn = () => ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox .monaco-checkbox')?.getAttribute('aria-checked')`);
	facts.copy_switch_before_send = await copyOn();
	if (facts.copy_switch_before_send === 'false') {
		await ui.click({ css: '.sessions-chat-isolation-checkbox .monaco-checkbox' });
		await ui.sleep(1500);
		facts.copy_switch_after_click = await copyOn();
		await focusInput(ui);
	}
	facts.picked = picked;
	facts.model = await ui.eval(`[...document.querySelectorAll('.new-chat-bottom-container .action-label, .sessions-chat-dropdown-label')].map(e => e.textContent.trim()).filter(Boolean).join(' | ')`);
	await ui.type('Reply exactly READY. Do not use any tools.');
	await ui.press('Enter', { send: true });
	const answered = await until(ui, () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') && /READY/.test(r.innerText); })()`), 300000, 2000);
	check(!!answered, `${engine} answered in the separate copy`);
	const copy = await until(ui, async () => { const now = fs.existsSync(copies) ? fs.readdirSync(copies).filter(d => !before.includes(d)) : []; return now[0]; }, 60000);
	facts.copy = copy;
	check(!!copy, `the session works in a separate copy (${copies}/${copy || '?'})`);
	const titleBar = () => ui.eval(`[...document.querySelectorAll('.dispatch-place-folder')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()).join(' | ')`);
	facts.title_before = await until(ui, titleBar, 30000);
	check(facts.title_before === project, `in the copy the title bar says "${facts.title_before}", the project ${project}`);
	await ui.screenshot('28-session-in-copy');

	// ---- task-lj06.28: ⌘T's panel in the copy says the project
	await ui.press('F1');
	await ui.type('Open a Terminal');
	await ui.sleep(800);
	await ui.press('Enter');
	const head = await until(ui, () => ui.eval(`document.querySelector('.dispatch-new-picker .dnp-folder')?.textContent || ''`), 15000, 300);
	facts.terminal_panel = head;
	check(head === project, `the terminal panel says "${head}", the project ${project}, not the copy ${copy}`);
	await ui.screenshot('28-terminal-panel');
	if (head) await ui.mark({ css: '.dispatch-new-picker .dnp-folder' }, { what: '终端选择框顶上写项目名', where: '左栏顶部弹出的面板', how: '在单独副本的会话里按 ⌘T' });
	await ui.press('Escape');

	// ---- task-lj06.27: a change committed in the copy, then Merge Changes in plain words
	if (copy) {
		const dir = path.join(copies, copy);
		fs.writeFileSync(path.join(dir, 'b8-note.txt'), 'a change made in the separate copy\n');
		const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
		execFileSync('git', ['-C', dir, 'add', 'b8-note.txt'], { env });
		execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'Add a note'], { env });
	}
	// a turn after the commit has the window read the copy's git state again
	if (copy) {
		await ui.click({ css: '.interactive-input-part .monaco-editor' });
		await ui.type('Reply exactly DONE. Do not use any tools.');
		await ui.press('Enter', { send: true });
	}
	// Merge Changes is an icon button in Changes (right): its accessible name is its description, the plain words
	const mergeSel = `[aria-label^="Bring this session's changes into"]`;
	const merge = await until(ui, () => ui.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(mergeSel)}), ...document.querySelectorAll('.monaco-workbench .action-label, .monaco-workbench .monaco-button')].find(e => e.getBoundingClientRect().width > 0 && /Merge Changes|Bring this session's changes into/.test(e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '')); if (!b) return ''; b.setAttribute('data-b8-merge', '1'); return b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent.trim(); })()`), 240000, 2000);
	if (!merge) facts.side_labels = await ui.eval(`[...document.querySelectorAll('.monaco-workbench .action-label, .monaco-workbench .monaco-button')].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 80)).filter(Boolean)`);
	facts.merge_button = merge;
	check(!!merge, 'Merge Changes shows in Changes');
	if (merge) {
		await ui.screenshot('27-merge-button');
		check(merge.includes(project) && !/worktree|parent repository/i.test(merge), `the button says it in plain words: ${merge}`);
		await ui.mark({ css: '[data-b8-merge="1"]' }, { what: 'Merge Changes 按钮的说明写项目名', where: '右栏 Changes 顶上', how: '单独副本里有提交后' });
		// a click that lands while the Changes header is drawn again opens nothing: the person clicks once more
		let dialog = '';
		for (let attempt = 0; attempt < 3 && !dialog; attempt++) {
			await ui.click({ css: '[data-b8-merge="1"]' }).catch(() => undefined);
			dialog = await until(ui, () => ui.eval(`document.querySelector('.monaco-dialog-box')?.innerText || ''`), 8000, 500);
		}
		facts.merge_dialog = dialog;
		check(/Bring this session's changes into/.test(dialog || '') && dialog.includes(project), `the dialog says it in plain words with the project's name: ${(dialog || '').replace(/\n/g, ' / ')}`);
		check(!/worktree|parent repository/i.test(dialog || ''), 'the dialog has no worktree or parent repository');
		await ui.screenshot('27-merge-dialog');
		await ui.mark({ css: '.monaco-dialog-box' }, { what: '合并确认框说人话、写项目名', where: '窗口中间', how: '标题栏 Merge Changes' });
		await ui.click({ text: 'Cancel', exact: true, within: '.monaco-dialog-box' }).catch(() => ui.press('Escape'));
	}

	// ---- task-lj06.28: a handoff to Codex in the copy keeps the project's name in the title bar
	if (process.env.B8_HANDOFF !== '0' && copy) {
		await ui.click({ css: '.dispatch-harness-picker' });
		await ui.click({ text: other, exact: true, within: '.context-view' });
		const switched = await until(ui, async () => { const t = await titleBar(); return /OpenCode|Codex|Go on with|换到了/.test(await ui.eval(`document.querySelector('.interactive-list')?.innerText || ''`)) && t ? t : ''; }, 180000, 2000);
		facts.title_after_handoff = switched || await titleBar();
		check(!!facts.title_after_handoff && facts.title_after_handoff.split(' | ').every(t => t === project) && !facts.title_after_handoff.includes(copy), `after the handoff the title bar says "${facts.title_after_handoff}", the project ${project}`);
		await ui.screenshot('28-title-after-handoff');
		await ui.mark({ css: '.dispatch-place-folder' }, { what: '换 Agent 之后标题栏还是项目名', where: '窗口顶部中间', how: '消息框里的 Agent 芯片换成 Codex' });
	}
	save();
	assert.deepEqual(facts.failed, [], `checks that did not hold: ${facts.failed.join(' · ')}`);
}
