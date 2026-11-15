// The 10-07 bug hunt's interface bugs, walked the way a person meets them, on a test instance with the demo project
// (its folder is under /tmp, which is a symlink to /private/tmp: the History bug happens here on its own).
// OpenCode with a free or cheap model: one session that writes a file, one that only answers, one Assistant question.
//   task-1w2yn  the parallel conversation tip: only with changes, one full stop when it is read out
//   task-ez3yp  History on the current project lists what All lists for it
//   task-m9k4w  a window made narrow and wide again comes back to the same columns
//   task-g9a0o  the side bar's Assistant row opens the Assistant's home, the last conversation goes on from there
//   task-eibd9  Settings: one number for one thing (sub-agents, Dispatch's version, OpenCode's providers)
//   task-iyt73  Tab completion sees the DeepSeek key OpenCode has (editor window settings, status bar tooltip)
// UI_SOFT=1 notes a failed check and goes on (to see every bug on an old build at once).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { needs: ['opencode'], title: '10-07 界面 bug 修复', description: '并行对话提示、History 软链接、窗口来回拉宽、左栏 Assistant 回首页、设置里的数字、Tab 补全认 OpenCode 的 Key。', timeout: 1800 };

const fresh = '.sessions-chat-editor';

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

/** A cheap model from /model: a free OpenCode Zen one, else GLM or DeepSeek Flash. */
async function cheapModel(ui) {
	await focusInput(ui);
	await ui.type('/model');
	await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
	const model = await until(ui, async () => {
		const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => r.querySelector('.dsm-name')?.textContent || '')`);
		return ui.cheapModel(rows);
	}, 'a cheap model in /model', 60000);
	const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
	for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
	await ui.type(`/${model.replace(/\s+/g, '')}`);
	await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(model)})`), `menu row ${model}`, 20000);
	await ui.click({ text: model, exact: true, within: '.dispatch-slash-menu' });
	await ui.press('Escape');
	return model;
}

const lastReplyDone = `(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && r.innerText.trim().length > 0; })()`;

async function send(ui, text) {
	await focusInput(ui);
	await ui.type(text);
	await ui.press('Enter', { send: true });
	await until(ui, async () => ui.eval(lastReplyDone), `the reply to "${text}"`, 300000);
	await ui.sleep(1500);
}

/** A new OpenCode session in the demo project with a cheap model, and one message. */
async function session(ui, text, facts) {
	await ui.newSession();
	await closeTips(ui);
	await ui.pickEngine('OpenCode', 180000);
	facts.model = await cheapModel(ui);
	await send(ui, text);
}

const visible = `(s => [...document.querySelectorAll(s)].filter(e => e.offsetParent))`;
const columns = `(() => { const w = s => { const e = (${visible})(s).find(e => e.getBoundingClientRect().width > 0); return e ? Math.round(e.getBoundingClientRect().width) : 0; };
	return { win: innerWidth, sidebar: w('.part.sidebar'), chat: w('.part.sessionspart'), pane: w('.part.editor') }; })()`;

export default async function (ui) {
	const facts = { failed: [] };
	const out = p => path.join(ui.out, p);
	const save = () => fs.writeFileSync(out('facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => {
		if (ok) return;
		facts.failed.push(message);
		save();
		if (process.env.UI_SOFT !== '1') assert.fail(message);
	};
	const demo = ui.demoFolder;
	try {
		await ui.openAgents(demo);
		await size(ui, 1440, 900);

		// ---- task-1w2yn: the parallel conversation tip ("build on all the changes made in this session") is shown and
		// read out only for a session with changes, with one full stop. OpenCode sessions show the new-chat view (where the
		// tip lives) only for a moment while the session settles, so what was read out (the window's live region) is checked.
		const spoken = `[...document.querySelectorAll('.monaco-aria-container *')].map(e => e.textContent).filter(t => /parallel conversation/.test(t))`;
		await session(ui, 'Reply with the single word OK. Do not create or change any file.', facts);
		await ui.sleep(3000);
		facts.spokenWithoutChanges = await ui.eval(spoken);
		facts.doubleStopWithoutChanges = await ui.eval(`document.body.textContent.includes('session..')`);
		check(facts.spokenWithoutChanges.length === 0, `a session without changes announced the parallel conversation tip: ${facts.spokenWithoutChanges}`);
		check(!facts.doubleStopWithoutChanges, 'something on the page still says "session.."');
		await ui.screenshot('01-no-changes-no-tip');

		// a session that changed a file
		await session(ui, 'Use your write tool to create the file hello-b7.txt in the current folder with the content: hi. Then reply with the single word Done.', facts);
		await ui.sleep(3000);
		facts.changesReply = await ui.eval(`[...document.querySelectorAll('.interactive-response')].at(-1)?.innerText.slice(0, 200) || ''`);
		facts.spokenWithChanges = await ui.eval(spoken);
		facts.doubleStopWithChanges = await ui.eval(`document.body.textContent.includes('session..')`);
		check(!facts.doubleStopWithChanges, 'the tip is read out as "session.."');
		check(facts.spokenWithChanges.every(t => t.includes('this session. Use Shift+Tab')), `the tip is read out as: ${facts.spokenWithChanges}`);
		await ui.screenshot('02-changes');
		save();

		// ---- task-ez3yp: History on this project lists the sessions All lists under it
		await closeTips(ui);
		for (let i = 0; ; i++) {
			try { await ui.openTab('History'); break; } catch (e) { if (i === 2) throw e; await ui.press('Escape'); await closeTips(ui); await ui.sleep(1500); }
		}
		const historyRows = `(${visible})('.dispatch-history-row').length`;
		const barText = `document.querySelector('.dispatch-history-bar')?.innerText.replace(/\\s+/g, ' ') || ''`;
		const scopeOn = `document.querySelector('.dispatch-history-bar .dispatch-tasks-scope .on')?.textContent || ''`;
		await ui.click({ text: path.basename(demo), exact: true, within: '.dispatch-history-bar' });
		await until(ui, async () => (await ui.eval(scopeOn)) === path.basename(demo), 'the project scope', 15000);
		// the list is read again for the scope: give it time before calling it empty
		facts.historyProject = await until(ui, async () => ui.eval(historyRows), 'History on the project', 60000).catch(() => 0);
		facts.historyScope = await ui.eval(scopeOn);
		facts.historyProjectBar = await ui.eval(barText);
		await ui.screenshot('03-history-project');
		await ui.mark({ css: '.dispatch-history-bar' }, { what: 'History 选当前项目：列出这个项目的会话', where: '右栏 History 页签顶上', how: '项目文件夹经过软链接（/tmp 指向 /private/tmp）时也一样' });
		await ui.click({ text: 'All', exact: true, within: '.dispatch-history-bar' });
		await ui.sleep(2500);
		facts.historyAllGroup = await ui.eval(`(() => { const g = [...document.querySelectorAll('.dispatch-history-group')].find(g => (g.querySelector('.dispatch-history-group-name')?.textContent || '').startsWith(${JSON.stringify(path.basename(demo))})); return g ? g.querySelectorAll('.dispatch-history-row').length : 0; })()`);
		check(facts.historyProject > 0, `History on ${path.basename(demo)} shows no sessions (${facts.historyProjectBar})`);
		check(facts.historyProject >= facts.historyAllGroup, `History on the project lists ${facts.historyProject}, All lists ${facts.historyAllGroup} under it`);
		await ui.click({ text: path.basename(demo), exact: true, within: '.dispatch-history-bar' }).catch(() => undefined);
		save();

		// ---- task-m9k4w: narrow and wide again, twice, with Changes in the side pane and with a file open
		for (const [mode, open] of [['Changes', async () => ui.openTab('Changes')], ['a file', async () => {
			await ui.openTab('Files');
			await ui.sleep(1500);
			const opened = `!!document.querySelector('.part.editor .editor-instance [id^="webview-editor-element"], .part.editor .editor-instance .monaco-editor')`;
			for (let i = 0; i < 4 && !(await ui.eval(opened)); i++) {
				await closeTips(ui);
				await ui.click({ text: 'README.md', exact: true, within: '.part.auxiliarybar' });
				for (let j = 0; j < 10 && !(await ui.eval(opened)); j++) await ui.sleep(500);
			}
		}]]) {
			await size(ui, 1440, 900);
			await open();
			await ui.sleep(1500);
			const start = await ui.eval(columns);
			const seen = [start];
			for (const w of [760, 1100, 1440, 900, 1440]) {
				await size(ui, w, 900);
				seen.push(await ui.eval(columns));
			}
			facts[`resize ${mode}`] = seen;
			const back = seen.filter(c => c.win === 1440);
			for (const c of back) {
				check(Math.abs(c.chat - start.chat) <= 1 && Math.abs(c.pane - start.pane) <= 1 && Math.abs(c.sidebar - start.sidebar) <= 1,
					`with ${mode} the columns at 1440 were ${start.sidebar}/${start.chat}/${start.pane} and came back as ${c.sidebar}/${c.chat}/${c.pane}`);
			}
			await ui.screenshot(`04-resize-${mode === 'Changes' ? 'changes' : 'file'}`);
		}
		await ui.mark({ css: '.part.sessionspart' }, { what: '对话栏回到原来的宽度', where: '窗口中间', how: '窗口拉到 760、1100、900 再拉回 1440' });
		save();

		// (task-g9a0o, the Assistant row going back to its home, went with the Assistant on 2026-11-11, task-0v1o9)

		// ---- task-eibd9: Settings, one number for one thing
		await ui.press('Cmd+,');
		await ui.waitFor({ css: '.dispatch-settings-page' }, { timeoutMs: 15000 });
		const page = async id => {
			await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${id}"]`, webview: false });
			await ui.sleep(2500);
		};
		await page('abilities');
		await page('overview').catch(async () => ui.click({ text: 'Overview', exact: true, within: '.dispatch-settings-nav' }));
		await ui.sleep(4000);
		facts.overviewMe = await ui.eval(`document.querySelector('.dset-me-sub')?.textContent || ''`);
		facts.overviewStrip = await ui.eval(`[...document.querySelectorAll('button.dset-strip')].map(b => b.innerText.replace(/\\s+/g, ' ')).find(t => /Abilities/.test(t)) || ''`);
		await ui.screenshot('07-overview');
		await page('subagents');
		await ui.sleep(4000);
		// Dispatch's helpers are on Soul now; Sub-agents lists the person's own and points there (pref 内置的放 Soul)
		facts.subagentsLink = await ui.eval(`document.querySelector('.dispatch-soul-link[data-soul-link="builtin-agents"]')?.innerText.replace(/\\s+/g, ' ') || ''`);
		facts.subagentsNative = await ui.eval(`[...document.querySelectorAll('.dispatch-settings-page .ai-customization-group-header, .dispatch-settings-page .section-header')].map(e => e.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
		const overviewN = Number((facts.overviewStrip.match(/(\d+)\s*sub-agents/) || [])[1] ?? -1);
		facts.subagentCounts = { overview: overviewN };
		check(overviewN >= 0 && /Dispatch's sub-agents/.test(facts.subagentsLink), `Overview says ${overviewN} sub-agents; Sub-agents points to Soul ("${facts.subagentsLink}")`);
		check(!/1\.139/.test(facts.overviewMe) && /Dispatch \d+\.\d+\.\d+/.test(facts.overviewMe), `Overview shows the version as "${facts.overviewMe}"`);
		await page('macs');
		facts.macsVersion = await ui.eval(`(document.querySelector('.dispatch-settings-page')?.innerText.match(/Dispatch \\d+\\.\\d+\\.\\d+/) || [''])[0]`);
		check(!facts.macsVersion || facts.overviewMe.includes(facts.macsVersion), `Macs says ${facts.macsVersion}, Overview "${facts.overviewMe}"`);
		await page('agents');
		await ui.sleep(4000);
		facts.agentsOpenCode = await ui.eval(`(document.querySelector('.dispatch-settings-page')?.innerText.match(/(No provider set up|\\d+ providers? set up)/) || [''])[0]`);
		await ui.press('Escape');
		await ui.sleep(1000);
		save();

		// the account menu's OpenCode line
		await ui.click({ css: '.sessions-account-titlebar-widget', webview: false }).catch(() => undefined);
		await ui.sleep(2500);
		facts.menuOpenCode = await ui.eval(`(document.body.innerText.match(/OpenCode · (No provider set up|\\d+ providers?( set up)?)/) || [''])[0]`);
		await ui.screenshot('08-account-menu');
		await ui.press('Escape');
		if (facts.menuOpenCode && facts.agentsOpenCode) check(facts.menuOpenCode.endsWith(facts.agentsOpenCode), `the account menu says "${facts.menuOpenCode}", Settings › Agents "${facts.agentsOpenCode}"`);
		save();

		// ---- task-iyt73: a DeepSeek key in this instance's own OpenCode (never the Mac's): the editor window's Tab
		// completion takes it. The instance links OpenCode's auth.json to the Mac's; it gets a file of its own here.
		const auth = path.join(ui.rec.root, 'xdg-data', 'opencode', 'auth.json');
		const linkTarget = fs.existsSync(auth) && fs.lstatSync(auth).isSymbolicLink() ? fs.readlinkSync(auth) : '';
		try {
			fs.mkdirSync(path.dirname(auth), { recursive: true });
			fs.rmSync(auth, { force: true });
			fs.writeFileSync(auth, JSON.stringify({ deepseek: { type: 'api', key: 'sk-e2e-not-a-real-key' } }));
			await ui.openEditor();
			await ui.press('Cmd+,');
			await ui.sleep(2500);
			await ui.type('Tab Completion');
			await ui.sleep(4000);
			facts.tabSetting = await ui.eval(`[...document.querySelectorAll('.setting-item-description, .setting-item-markdown')].map(e => e.textContent).filter(t => /Grey suggestions/.test(t)).join(' | ')`);
			check(facts.tabSetting && !/has none yet|has one on this Mac yet/.test(facts.tabSetting), `Tab completion still says there is no key: ${facts.tabSetting}`);
			await ui.screenshot('09-tab-completion-key');
			await ui.mark({ text: 'Grey suggestions as you type; Tab accepts.' }, { what: 'Tab 补全不再说没有 DeepSeek 密钥', where: '编辑器窗口设置 › Dispatch › Tab Completion', how: 'OpenCode 里接好 DeepSeek 后打开' }).catch(() => undefined);
			await ui.press('Escape');
		} finally {
			fs.rmSync(auth, { force: true });
			if (linkTarget) fs.symlinkSync(linkTarget, auth);
		}
	} finally {
		save();
	}
	assert.deepEqual(facts.failed, [], facts.failed.join('\n'));
}
