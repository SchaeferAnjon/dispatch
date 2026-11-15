// The second round of the 10-06 bug fixes, walked the way a person meets them (task-lj06.1 to lj06.7, task-eke2):
// a page opened right after the window comes up stays open (the window's own landing and the hand-over from the
// editor window give way to it); OpenCode is in the agent picker within seconds, and says it is getting ready, never
// "No models available", before that; in a 760 px window the agent and harness chips fold to icons instead of running
// under the send button; the side pane gets its width back when the window grows again; ⌘T opens a terminal with the
// focus in the side pane; OpenCode starting in a terminal is not "Working on your request."; the What Dispatch changed
// page scrolls once, not a box in a box. Sends one message to OpenCode with a cheap model (GLM Flash or DeepSeek Flash).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { needs: ['opencode'], title: '修 bug 第二轮', description: '新窗口里打开的页不被盖掉、OpenCode 很快出现、窄窗口的芯片、右栏变宽、右栏里 ⌘T、终端里刚启动的 OpenCode、Migrations 只有一层滚动。', timeout: 900 };

const META = 4;
const fresh = '.sessions-chat-editor';

async function key(ui, k, code, vk, modifiers) {
	await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
	await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
	await ui.sleep(400);
}

async function until(ui, fn, what, ms = 60000) {
	for (const end = Date.now() + ms * SCALE; Date.now() < end; await ui.sleep(500)) {
		const v = await fn();
		if (v) return v;
	}
	throw new Error(`Timed out: ${what}`);
}

async function size(ui, w, h) {
	await ui.eval(`window.resizeTo(${w}, ${h})`);
	for (let i = 0; i < 20 && (await ui.eval('innerWidth')) !== w; i++) await ui.sleep(250);
	await ui.sleep(1500);
}

async function closeTips(ui) {
	for (let i = 0; i < 4 && await ui.exists({ css: '.dispatch-tour-close' }); i++) {
		await ui.click({ css: '.dispatch-tour-close' });
		await ui.sleep(500);
	}
}

async function focusInput(ui) {
	for (let i = 0; i < 8; i++) {
		await ui.click({ css: i % 2 ? `${fresh} .view-lines` : fresh });
		await ui.sleep(400);
		if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${fresh}')`)) return;
		await ui.sleep(800);
	}
	throw new Error('The message box does not take the focus');
}

const rect = `(e => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; })`;
const visible = `(s => [...document.querySelectorAll(s)].filter(e => e.offsetParent))`;
const customView = () => `(${visible})('.part.customviewgridpart').length > 0`;

/** The engine picker's OpenCode row: missing, its note ("Getting ready…", "No models available") or ok. */
async function openCodeRow(ui) {
	await ui.click({ css: '.sessions-chat-session-type-picker' });
	await ui.sleep(500);
	const row = await ui.eval(`(() => { const r = [...document.querySelectorAll('.context-view .monaco-list-row')].find(r => r.innerText.split('\\n')[0].trim() === 'OpenCode');
		return !r ? 'missing' : r.classList.contains('option-disabled') ? ('disabled: ' + r.innerText.replace(/\\s+/g, ' ').trim()) : 'ok'; })()`);
	await ui.press('Escape');
	return row;
}

export default async function (ui) {
	const facts = { failed: [] };
	// R2_SOFT=1 notes a failed check and goes on (to see every bug on an old build at once); by default the first one stops the run
	const check = (ok, message) => {
		if (ok) return;
		if (process.env.R2_SOFT === '1') facts.failed.push(message); else assert.fail(message);
	};
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	try {
		// 1 a page opened as the window comes up stays (nothing lands over it, task-lj06.6) and so does one opened
		// while the editor window hands its folder over (task-eke2)
		// the Agents window as the person opens it (the editor window's Dispatch Agent button when it is not up yet)
		await ui.openAgents();
		await ui.press('Cmd+,');
		facts.settingsAt = Date.now();
		// ⌘, or, when the page that is up while the window checks whether setup is due took the key (it goes by itself;
		// the window no longer waits on the Assistant's landing, so the key can come that early): once it is gone, again
		try {
			await ui.waitFor({ css: '.dispatch-settings-page' }, { timeoutMs: 5000 });
		} catch {
			await ui.waitFor({ css: '.dispatch-onboarding-host' }, { gone: true, timeoutMs: 30000 });
			await ui.press('Cmd+,');
			await ui.waitFor({ css: '.dispatch-settings-page' }, { timeoutMs: 15000 });
		}
		await ui.sleep(15000);
		facts.settingsStayed = await ui.exists({ css: '.dispatch-settings-page' });
		check(facts.settingsStayed, 'Settings, opened as the window came up, was closed by the window landing somewhere');
		await ui.screenshot('01-settings-stays');
		await ui.press('Escape');
		await ui.openAgents(ui.demoFolder);
		await ui.click({ text: 'Waiting for you', exact: true, within: '.part.sidebar' });
		await ui.sleep(20000);
		facts.waitingStayed = await ui.eval(customView());
		check(facts.waitingStayed, 'Waiting for you, opened during the hand-over from the editor window, was closed');
		save();

		// 2 OpenCode in the agent picker: soon, and never "No models available" while it gets ready
		await ui.newSession();
		await closeTips(ui);
		const notes = [];
		const t0 = Date.now();
		facts.openCodeReady = await until(ui, async () => {
			const r = await openCodeRow(ui);
			notes.push(r);
			return r === 'ok' ? Math.round((Date.now() - t0) / 1000) : 0;
		}, 'OpenCode becomes pickable', 180000);
		facts.openCodeNotes = [...new Set(notes)];
		check(!notes.some(n => /No models available/.test(n)), `OpenCode said No models available while it got ready: ${facts.openCodeNotes}`);
		save();

		// 3 a chat with OpenCode (one short message, a cheap model), the side pane on Changes
		await size(ui, 1440, 884);
		await ui.pickEngine('OpenCode', 120000);
		await focusInput(ui);
		await ui.type('/model');
		await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
		const model = await until(ui, async () => {
			const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => r.querySelector('.dsm-name')?.textContent || '')`);
			return ui.cheapModel(rows);
		}, 'a cheap model in /model', 45000);
		const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
		for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
		await ui.type(`/${model.replace(/\s+/g, '')}`);
		await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(model)})`), `menu row ${model}`, 20000);
		await ui.click({ text: model, exact: true, within: '.dispatch-slash-menu' });
		await ui.press('Escape');
		await focusInput(ui);
		await ui.type('Reply with the single word OK.');
		await ui.press('Enter', { send: true });
		await until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && r.innerText.trim().length > 0; })()`), 'the reply', 240000);
		facts.model = model;
		await ui.openTab('Changes');
		await ui.sleep(1500);
		const aux = async () => ui.eval(`(${rect})((${visible})('.part.auxiliarybar')[0])`);
		facts.auxAt1440 = await aux();

		// 4 760 px: the chips fold to icons and nothing runs under the send button (task-lj06.2)
		await size(ui, 760, 800);
		const row = await ui.eval(`(() => { const r = ${rect}; const part = (${visible})('.part.sessionspart')[0];
			const inp = [...part.querySelectorAll('.interactive-input-part')].filter(e => e.offsetParent).at(-1);
			const lane = inp.querySelector('.chat-input-toolbar'); const send = inp.querySelector('.chat-execute-toolbar');
			const chips = [...inp.querySelectorAll('.chat-input-toolbar .action-item')].filter(e => e.offsetParent).map(e => ({ cls: e.className, ...r(e) }));
			return { lane: r(lane), send: r(send), chips, labels: [...inp.querySelectorAll('.chat-input-toolbar .sessions-chat-dropdown-label')].filter(e => e.offsetParent).map(e => e.textContent) };
		})()`);
		facts.at760 = row;
		const lastRight = Math.max(...row.chips.map(c => c.r));
		check(lastRight <= row.send.l, `a chip runs under the send button at 760 px: chips end at ${lastRight}, send starts at ${row.send.l}`);
		check(lastRight <= row.lane.r + 1, `a chip is cut off at the input row's edge: ${lastRight} > ${row.lane.r}`);
		await ui.screenshot('02-chips-760');
		await ui.mark({ css: '.part.sessionspart .interactive-input-part .chat-input-toolbar' }, { what: '窄窗口里 Agent 芯片收成图标', where: '对话输入框下面一行', how: '窗口 760 宽、右栏开着时' });

		// 5 wide again: the side pane gets its width back (task-lj06.3)
		facts.auxAt760 = await aux();
		await size(ui, 1440, 884);
		facts.auxBackAt1440 = await aux();
		check(facts.auxBackAt1440.w >= facts.auxAt1440.w - 2, `the side pane stayed narrow: ${facts.auxAt1440.w} → ${facts.auxAt760.w} → ${facts.auxBackAt1440.w}`);
		await ui.screenshot('03-side-pane-back');
		await ui.mark({ css: '.part.auxiliarybar' }, { what: '右栏回到原来的宽度', where: '窗口右侧', how: '窗口先拉窄再拉宽' });
		save();

		// 6 ⌘T with the focus in the side pane opens the terminal picker (task-lj06.4): a file opened from the side pane's
		// Files tab, clicked into, then ⌘T. It used to open the editor's Go to Symbol instead.
		const fileRows = `[...document.querySelectorAll('.part.auxiliarybar .monaco-list-row')].filter(r => r.offsetParent).map(r => r.innerText.trim())`;
		await ui.openTab('Files');
		await ui.sleep(1500);
		await closeTips(ui); // a first-time tip over the side pane (Tasks, 2 of 4) covers the file list
		if (!(await ui.eval(fileRows)).includes('README.md')) {
			await ui.click({ css: '.part.auxiliarybar .monaco-list-row', webview: false });
			await ui.sleep(1000);
		}
		// the file opens in the side pane (a preview of README.md); a click that only selected the row is clicked again
		const opened = `!!document.querySelector('.part.editor .editor-instance [id^="webview-editor-element"], .part.editor .editor-instance .monaco-editor')`;
		for (let i = 0; i < 4 && !(await ui.eval(opened)); i++) {
			await closeTips(ui);
			if (!(await ui.eval(fileRows)).includes('README.md')) {
				await ui.click({ css: '.part.auxiliarybar .monaco-list-row', webview: false });
				await ui.sleep(1000);
			}
			await ui.click({ text: 'README.md', exact: true, within: '.part.auxiliarybar' });
			for (let j = 0; j < 10 && !(await ui.eval(opened)); j++) await ui.sleep(500);
		}
		check(await ui.eval(opened), 'README.md did not open from the Files tab');
		const focusThere = `(() => { const a = document.activeElement; return !!a && (!!a.closest('.part.editor') || !!a.closest('.webview') || a.tagName === 'IFRAME'); })()`;
		for (let i = 0; i < 3 && !(await ui.eval(focusThere)); i++) {
			// the preview draws a moment after its tab: a click before that lands on nothing that takes the focus
			await ui.sleep(800);
			await ui.click({ css: '.part.editor .editor-instance', webview: false });
			await ui.sleep(600);
		}
		facts.focusInSidePane = await ui.eval(focusThere);
		await key(ui, 't', 'KeyT', 84, META);
		await ui.sleep(1500);
		facts.pickerFromSidePane = await ui.exists({ css: '.dispatch-new-picker' });
		facts.quickInputInstead = await ui.eval(`[...document.querySelectorAll('.quick-input-widget')].filter(e => e.offsetParent).map(e => e.innerText.slice(0, 60)).join(' | ')`);
		check(facts.focusInSidePane, 'the click into the opened file did not put the focus in the side pane');
		check(facts.pickerFromSidePane, `⌘T in the side pane opened no terminal picker (instead: ${facts.quickInputInstead || 'nothing'})`);
		await ui.screenshot('04-cmd-t-side-pane');
		await ui.mark({ css: '.dispatch-new-picker' }, { what: '⌘T 在右栏里也开终端', where: '右栏打开的文件里', how: '点进文件后按 ⌘T' }).catch(() => undefined);
		save();
		if (!facts.pickerFromSidePane) {
			await ui.press('Escape');
		}

		// 7 OpenCode starting in a terminal: the Now tab does not say it is working on a request (task-lj06.5)
		if (!await ui.exists({ css: '.dispatch-new-picker' })) {
			// (an old build, R2_SOFT: the way that worked there, from the session area)
			await ui.click({ css: '.part.sessionspart', webview: false });
			await key(ui, 't', 'KeyT', 84, META);
		}
		await ui.waitFor({ text: 'OpenCode', within: '.dispatch-new-picker' }, { timeoutMs: 60000 });
		await ui.click({ text: 'OpenCode', within: '.dispatch-new-picker' });
		const nows = [];
		const start = Date.now();
		for (; Date.now() - start < 9000; await ui.sleep(700)) {
			if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: 'Not now', exact: true });
			if (!await ui.exists({ css: '.dispatch-terminal-view .dispatch-xterm .xterm-screen' })) continue;
			if (!await ui.eval(`!!(${visible})('.dispatch-now-tab [data-part="now-head"]').length`)) {
				await ui.openTab('Now');
			}
			// the head's line (direction A, 2026-11-11: under the state line)
			nows.push(await ui.eval(`((${visible})('.dispatch-now-tab [data-part="now-head"] .dispatch-now-say')[0] || { innerText: '' }).innerText`));
		}
		facts.nowWhileStarting = [...new Set(nows)];
		check(nows.length > 0, 'the Now tab never showed while OpenCode started');
		check(!nows.some(t => /Working on your request/.test(t)), `Now said working while OpenCode only started: ${facts.nowWhileStarting}`);
		await ui.screenshot('05-terminal-opencode-now');
		await ui.mark({ css: '.dispatch-now-tab [data-part="now-head"]' }, { what: 'Now 写 OpenCode 在终端里准备好了', where: '右栏 Now', how: '⌘T › OpenCode，刚启动的几秒' });
		save();

		// 8 What Dispatch changed on this Mac: one scroll, the page's (task-lj06.7)
		await ui.openCustomizations('Migrations');
		await ui.sleep(2500);
		// a scroll area scrolls when its slider is shorter than its track (monaco's own scroll bars)
		facts.migrations = await ui.eval(`[...document.querySelectorAll('.part.customviewgridpart .monaco-scrollable-element')].filter(e => e.offsetParent).map(e => {
			const bar = [...e.children].find(c => c.classList.contains('scrollbar') && c.classList.contains('vertical')); const sl = bar && bar.querySelector('.slider');
			return { area: e.classList.contains('custom-view-body') ? 'page' : e.classList.contains('customization-migration-dashboard-scroll') ? 'card' : 'other', scrolls: !!bar && !!sl && bar.offsetHeight > 0 && sl.offsetHeight < bar.offsetHeight - 1, track: bar ? bar.offsetHeight : 0, slider: sl ? sl.offsetHeight : 0 };
		})`);
		const pageScrolls = facts.migrations.some(a => a.area === 'page' && a.scrolls);
		check(!pageScrolls, `the page scrolls around the card that scrolls itself: ${JSON.stringify(facts.migrations)}`);
		await ui.screenshot('06-migrations-one-scroll');
		await ui.mark({ css: '.prompt-migration-content-container' }, { what: '只有卡片自己滚动', where: '设置 › Abilities › What Dispatch changed on this Mac', how: '页面本身不再多出一截滚动' });
		save();
	} finally {
		save();
	}
}
