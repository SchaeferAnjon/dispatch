// The 10-07 bug round's interface fixes, on a new Mac's path from the first window. Start the instance with
// `dispatch ide instance start <name> --onboarding fresh --agents` (a fresh HOME with stand-in agents).
//   task-lj06.25  the setup page is there as soon as the window is, not a message box to type into for 20 to 35 s
//   task-lj06.26  the first welcome has no "Video coming soon" and stays off the message box; no "Dispatch is set up." toast on Turbo
//   task-lj06.21  a tip never sits on a message box (the runner checks every screenshot; this walks the tips onto one)
//   task-lj06.20  Start a new project says why Create project is grey, and a click beside a filled-in form keeps it
//   task-lj06.35  the focus is in the name field when the form opens
//   task-lj06.23  Settings › MCP servers lists Dispatch's own tool server as Built-in, with a switch that works
//   task-lj06.32  the page is titled MCP servers; Hooks lists OpenCode
//   task-lj06.37  What Dispatch changed has no "assistant Migrated" checklist on a new Mac
//   task-lj06.36  Settings › Phone and the pairing panel say the iPhone app is not in the App Store yet
// Every check is noted in facts.json; the run fails at the end when one did not hold.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const meta = { instance: { onboarding: 'fresh', tips: true }, title: '10-07 修 bug：新用户第一次进来那一路', description: '向导立刻出现、Welcome 不挡输入框、提示卡不压消息框、新建项目说清原因、MCP servers 列出 Dispatch 自带的工具、Hooks 有 OpenCode、迁移页不写 assistant Migrated、手机页说 App 还没上架。', timeout: 1500 };

const rect = `(e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; })`;
const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

export default async function (ui) {
	assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
	const home = ui.rec.fixture_home;
	const facts = { failed: [], passed: [] };
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => { (ok ? facts.passed : facts.failed).push(message); save(); };
	const until = async (fn, ms, step = 500) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => undefined); if (v) return v; await ui.sleep(step); } return v; };

	// B8_FROM=project: an instance that has been through setup already, from the new project on
	const from = process.env.B8_FROM || '';
	await ui.attach('agents', 90000);
	if (!from) {
	// ---- task-lj06.25: what the first window shows, every quarter second
	const poll = [];
	const t0 = Date.now();
	for (let i = 0; i < 240; i++) {
		const s = await ui.eval(`(() => { const shown = s => [...document.querySelectorAll(s)].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
			return { since_load: Math.round(performance.now()), wizard: shown('.dispatch-onboarding'), welcome: /Welcome to Dispatch/.test(document.querySelector('.dispatch-onboarding')?.innerText || ''), input: shown('.new-chat-input-area') && !shown('.dispatch-onboarding') }; })()`).catch(() => null);
		if (s) poll.push({ at: Date.now() - t0, ...s });
		if (s && s.welcome) break;
		await ui.sleep(250);
	}
	facts.first_window = { first: poll[0], wizard_at: poll.find(p => p.wizard), welcome_at: poll.find(p => p.welcome), input_seen: poll.filter(p => p.input).length, samples: poll.length };
	fs.writeFileSync(path.join(ui.out, 'first-window.json'), JSON.stringify(poll, null, 1));
	check(poll.length && poll[0].wizard, `the setup page is up when the window is first read (${poll[0]?.since_load} ms after it loaded)`);
	check(!poll.some(p => p.input), 'no message box shows before the setup page');
	await ui.screenshot('25-first-window');
	await ui.mark({ css: '.dispatch-onboarding' }, { what: '一打开就是设置向导', where: '窗口中间', how: '全新 Mac 第一次打开' });
	await ui.eval('window.resizeTo(1440, 900)');

	// ---- through the setup, reading the connect page (task-lj06.23) and the last page (task-lj06.26)
	const text = () => ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''");
	const said = [];
	for (let i = 0; i < 16 && !(await ui.exists({ text: 'Start', exact: true })); i++) {
		await ui.sleep(1200);
		said.push(await text());
		if (/Connect Dispatch to/.test(said.at(-1))) await ui.screenshot('23-connect-page');
		if (await ui.exists({ text: 'Set up Dispatch', exact: true })) {
			await ui.click({ text: 'Set up Dispatch', exact: true });
			// setting up takes a minute or two; a busy mini took more than four (10-08)
			for (let j = 0; j < 480 && !(await ui.exists({ text: 'Start', exact: true })); j++) await ui.sleep(1000);
			break;
		}
		await ui.waitFor({ css: '.dob-foot .dob-btn.fill' }, { timeoutMs: 60000 });
		await ui.click({ css: '.dob-foot .dob-btn.fill' });
	}
	const all = said.join('\n');
	check(/its own tools for the task board/.test(all), 'the connect page says Dispatch adds its own tools');
	const last = await text();
	check(/What Dispatch changed on this Mac lists each change, with Undo/.test(last), 'the last setup page says where changes can be undone');
	await ui.screenshot('26-setup-done');

	// ---- task-lj06.26: after Start, the welcome without the placeholder, no toast
	await ui.click({ text: 'Start', exact: true });
	const toasts = [];
	let card;
	for (let i = 0; i < 40; i++) {
		toasts.push(...(await ui.eval(`[...document.querySelectorAll('.notification-toast')].map(t => t.innerText.trim())`)));
		card = await ui.eval(`(() => { const r = ${rect}; const c = document.querySelector('.monaco-hover.dispatch-whats-new-auto'); return c ? { box: r(c), text: c.innerText } : null; })()`);
		if (card && i > 8) break;
		await ui.sleep(500);
	}
	facts.welcome = card;
	facts.toasts = [...new Set(toasts)];
	check(!facts.toasts.some(t => /Dispatch is set up/.test(t)), `no "Dispatch is set up." toast after Start (${facts.toasts.join(' | ') || 'none'})`);
	check(!!card, 'the welcome card opened by itself');
	check(card && !/Video coming soon/.test(card.text) && !(await ui.exists({ css: '.dispatch-welcome-video' })), 'the welcome has no "Video coming soon" box');
	const boxes = await ui.eval(`(() => { const r = ${rect}; const v = s => [...document.querySelectorAll(s)].filter(e => e.getBoundingClientRect().width > 0); return { input: r(v('.new-chat-input-container, .interactive-input-part').at(-1)), turbo: r(v('.dispatch-turbo-chip')[0]) }; })()`);
	check(card && !overlap(card.box, boxes.input) && !overlap(card.box, boxes.turbo), `the welcome ${JSON.stringify(card?.box)} stays off the message box ${JSON.stringify(boxes.input)} and Turbo ${JSON.stringify(boxes.turbo)}`);
	await ui.screenshot('26-welcome');
	if (card) await ui.mark({ css: '.monaco-hover.dispatch-whats-new-auto' }, { what: 'Welcome 卡：没有 Video coming soon，停在输入框上面', where: '标题栏右端往下', how: '向导点 Start 之后自动出现' });
	if (boxes.turbo) await ui.mark({ css: '.dispatch-turbo-chip' }, { what: 'Turbo 露在外面，没有 Dispatch is set up. 提示', where: '输入框下面一行右边', how: '不用先关任何东西' });
	if (card) await ui.press('Escape');

	// ---- task-lj06.21: the tips, walked to the Getting started one on the bottom bar, then onto pages with a message box
	const tips = [];
	let lastStep;
	const stepNow = () => ui.eval(`(() => { const t = document.querySelector('.dispatch-tour'); return t && getComputedStyle(t).visibility !== 'hidden' ? t.dataset.step : null; })()`);
	for (let i = 0; i < 200; i++) {
		const step = await stepNow();
		if (step && step !== lastStep) {
			lastStep = step;
			tips.push(step);
			await ui.screenshot(`21-tip-${tips.length}-${step}`);
		}
		if (step === 'checklist') break;
		if (step) {
			await ui.sleep(800);
			await ui.click({ css: '.dispatch-tour .dispatch-tour-btn.fill' }).catch(() => undefined);
		}
		await ui.sleep(600);
	}
	facts.tips = tips;
	check(tips.includes('checklist'), `the Getting started tip came up (${tips.join(', ') || 'no tip'})`);
	const tipVsBoxes = async () => ui.eval(`(() => { const r = ${rect}; const t = document.querySelector('.dispatch-tour');
		const keep = [...document.querySelectorAll('.interactive-input-part, .new-chat-input-container, .new-chat-input-area, .new-chat-bottom-container')].filter(e => e.getBoundingClientRect().width > 0).map(r);
		return { tip: t && getComputedStyle(t).visibility !== 'hidden' ? r(t) : null, keep }; })()`);
	if (tips.includes('checklist')) {
		const here = await tipVsBoxes();
		facts.tip_assistant = here;
		check(!here.tip || here.keep.every(k => !overlap(here.tip, k)), `the Getting started tip ${JSON.stringify(here.tip)} is off the message box ${JSON.stringify(here.keep)}`);
		await ui.screenshot('21-tip-checklist');
		if (here.tip) await ui.mark({ css: '.dispatch-tour' }, { what: 'Getting started 提示卡：不压消息框', where: '消息框上方', how: '新用户设置完自己出现，点 Next 到第三张' });
		// a new session page: the box with its agent chip at the bottom
		await ui.press('Escape').catch(() => undefined);
		await ui.newSession();
		await ui.sleep(2500);
		const session = await tipVsBoxes();
		facts.tip_new_session = session;
		check(!session.tip || session.keep.every(k => !overlap(session.tip, k)), `on a new session page the tip ${JSON.stringify(session.tip)} is off the box ${JSON.stringify(session.keep)}`);
		await ui.screenshot('21-tip-new-session');
		if (session.tip) await ui.mark({ css: '.dispatch-tour' }, { what: 'Getting started 提示卡挪到消息框外面', where: '消息框上方', how: '不点 Got it，打开新会话页' });
		await ui.mark({ css: '.new-chat-input-container' }, { what: '消息框和下面的芯片都露着', where: '会话页底部', how: '能打字，能点换 Agent 的芯片' });
		// the chip answers a real click while the tip is up
		const chip = await ui.exists({ css: '.sessions-chat-session-type-picker' });
		if (chip) {
			await ui.click({ css: '.sessions-chat-session-type-picker' });
			const menu = await until(() => ui.exists({ css: '.context-view .monaco-list-row' }), 8000);
			check(!!menu, 'the agent chip opens its menu on a mouse click while the tip is up');
			await ui.screenshot('21-chip-menu');
			await ui.press('Escape');
		}
	}

	}
	await ui.eval('window.resizeTo(1440, 900)');

	if (from !== 'tools') {
	// ---- task-lj06.20 / .35: a new project without an email for commits
	// git knows a name but no email (exit 5 when there was none to take away)
	try { execFileSync('git', ['config', '--global', '--unset-all', 'user.email'], { env: { ...process.env, HOME: home } }); } catch { /* none set */ }
	execFileSync('git', ['config', '--global', 'user.name', 'Apple'], { env: { ...process.env, HOME: home } });
	await ui.click({ text: 'Projects', exact: true, within: '.part.sidebar' });
	await ui.waitFor({ text: 'Add Project', exact: true }, { timeoutMs: 30000 });
	await ui.click({ text: 'Add Project', exact: true });
	await ui.waitFor({ text: 'Start a new project', exact: true }, { timeoutMs: 15000 });
	await ui.sleep(1500);
	await ui.click({ text: 'Start a new project', exact: true });
	const opened = Date.now();
	const focus = await until(() => ui.eval(`document.activeElement?.dataset?.field || ''`), 3000, 100);
	check(focus === 'name', `the focus is in the name field when the form opens (it is on "${focus || 'nothing'}")`);
	const fields = await until(() => ui.exists({ css: '#dispatch-ap-gitEmail' }), 60000, 200);
	facts.email_field_after_ms = Date.now() - opened;
	check(!!fields, `the email field is on the form (after ${facts.email_field_after_ms} ms)`);
	await ui.screenshot('35-form-opened');
	await ui.mark({ css: '#dispatch-ap-name' }, { what: '焦点直接在项目名框', where: '对话框第一栏', how: 'Projects › Add Project › Start a new project' });
	await ui.type('计时器', { into: { css: '#dispatch-ap-name' } });
	await ui.sleep(800);
	const why = await ui.eval(`(() => { const w = document.querySelector('.dap-why'); const b = [...document.querySelectorAll('.dap-btn')].find(x => x.textContent.trim() === 'Create project'); return { why: w && !w.hidden ? w.textContent : '', disabled: b?.getAttribute('aria-disabled') }; })()`);
	facts.create_reason = why;
	check(/email/i.test(why.why) && why.disabled === 'true', `Create project is grey and says why: "${why.why}" (disabled ${why.disabled})`);
	await ui.screenshot('20-why-grey');
	await ui.mark({ css: '.dap-why' }, { what: 'Create project 为什么是灰的', where: '按钮左边', how: '填了项目名、没填邮箱' });
	// a click beside the dialog keeps what was typed
	await ui.mouse('mousePressed', 30, 450, { button: 'left', clickCount: 1 });
	await ui.mouse('mouseReleased', 30, 450, { button: 'left', clickCount: 1 });
	await ui.sleep(800);
	check(await ui.exists({ css: '#dispatch-ap-name' }), 'a click beside the filled-in dialog does not close it');
	await ui.type('apple@example.com', { into: { css: '#dispatch-ap-gitEmail' } });
	await ui.sleep(600);
	const ready = await ui.eval(`[...document.querySelectorAll('.dap-btn')].find(x => x.textContent.trim() === 'Create project')?.getAttribute('aria-disabled')`);
	check(ready === 'false', `with the email typed Create project can be pressed (aria-disabled ${ready})`);
	await ui.click({ text: 'Create project', exact: true });
	const made = await until(async () => !(await ui.exists({ css: '.dispatch-ap' })) || (await ui.eval(`document.querySelector('.dap-note.dap-error')?.textContent || ''`)), 120000, 1000);
	facts.create_result = made;
	const dir = path.join(home, 'Projects', '计时器');
	check(fs.existsSync(path.join(dir, '.git')), `the project folder was made with its history (${dir})`);
	let email = '';
	try { email = execFileSync('git', ['config', '--global', 'user.email'], { env: { ...process.env, HOME: home } }).toString().trim(); } catch { /* none */ }
	check(email === 'apple@example.com', `the email typed is what git has now (${email || 'none'})`);
	// the new project's page opens after the folder is made (slow on a busy Mac); Settings opened before it would be replaced
	facts.project_page = !!(await until(() => ui.eval(`document.body.innerText.includes(${JSON.stringify(dir + ' · ')})`), 90000, 1000));
	await ui.screenshot('20-created');
	await ui.press('Escape').catch(() => undefined);

	}

	// ---- task-lj06.23 / .32: MCP servers and Hooks
	await ui.openCustomizations('MCP Servers');
	// Dispatch's own tool server is on Settings › Soul now (pref 内置的放 Soul): MCP servers points there
	const link = await until(() => ui.eval(`document.querySelector('.dispatch-soul-link[data-soul-link="builtin-tools"]')?.innerText || ''`), 180000, 1000);
	const title = await ui.eval(`[...document.querySelectorAll('.dset-embed h2.section-title')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()).join(' | ')`);
	facts.tools_page = { title, link };
	check(/MCP servers/.test(title) && !/External tools/.test(title), `the page title says MCP servers (${title})`);
	check(/Dispatch's own tools/.test(link || ''), 'MCP servers has the line to Dispatch\'s own tools on Soul');
	const windowList = await ui.eval(`document.querySelector('.installed-mcp-servers-section, [class*=installed-mcp-servers-section]')?.innerText || ''`);
	check(!/No MCP servers are installed/.test(windowList), `the window's own list no longer says "No MCP servers are installed" (${windowList.replace(/\n/g, ' / ').slice(0, 120)})`);
	await ui.screenshot('23-mcp-servers');
	await ui.click({ css: '.dispatch-soul-link[data-soul-link="builtin-tools"]' });
	const card = '.dispatch-settings-page [data-setting="builtin-tools"]';
	const builtin = await until(() => ui.eval(`document.querySelector('${card}')?.innerText || ''`), 60000, 1000);
	facts.tools_page.builtin = builtin;
	check(/Dispatch's tools/.test(builtin || '') && /task board/.test(builtin || ''), 'Dispatch\'s own tool server is on Soul and says what it does');
	await ui.mark({ css: card }, { what: 'Dispatch 自带的工具服务，带开关', where: '设置 › Soul 的 Built into every agent', how: '设置 › Soul，或 MCP servers 页顶上那一行' });
	// the instance's Claude Code keeps its settings in CLAUDE_CONFIG_DIR (home/.claude)
	const claudeHas = () => { for (const f of [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')]) { try { return 'dispatch' in (JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}); } catch { /* the next */ } } return null; };
	facts.claude_before = claudeHas();
	const toggle = `${card} .dset-bi-head .monaco-custom-toggle`;
	const state = () => ui.eval(`document.querySelector('${card} .dset-bi-state')?.textContent || ''`);
	if (await until(() => ui.exists({ css: toggle }), 60000, 1000)) {
		await ui.click({ css: toggle });
		const off = await until(async () => /^Off\./.test(await state()) && claudeHas() === false, 120000, 1000);
		check(!!off, `the switch takes it out of the agents (Claude Code's file has it: ${claudeHas()})`);
		await ui.screenshot('23-external-tools-off');
		await ui.mark({ css: card }, { what: '关掉以后写 Off 和关掉的后果', where: 'Soul 页的 Dispatch\'s tools', how: '点开关' });
		await until(() => ui.exists({ css: `${toggle}[aria-checked="false"]:not([aria-disabled="true"])` }), 120000, 1000);
		await ui.click({ css: toggle });
		const on = await until(async () => /^In /.test(await state()) && claudeHas() === true, 120000, 1000);
		check(!!on, `the switch puts it back (Claude Code's file has it: ${claudeHas()})`);
	} else {
		check(false, 'the tools card has a switch');
	}
	const hooksCard = '.dispatch-settings-page [data-setting="builtin-hooks"]';
	const hooks = await until(() => ui.eval(`(() => { const h = document.querySelector('${hooksCard}'); return h && /Session brief/.test(h.innerText) ? h.innerText : ''; })()`), 60000, 1000);
	facts.hooks = (hooks || '').slice(0, 600);
	check(/OpenCode/.test(hooks || ''), 'Dispatch\'s hooks list OpenCode next to Claude Code and Codex');
	await ui.eval(`document.querySelector('${hooksCard}')?.scrollIntoView({ block: 'center' })`);
	await ui.screenshot('32-hooks');
	if (hooks) await ui.mark({ text: 'OpenCode', within: hooksCard }, { what: 'Hooks 里有 OpenCode', where: '每组开关的第三个', how: '设置 › Soul 的 Hooks' });
	// the Abilities counts: the agents' own tool servers, read from their settings (Dispatch's own is on Soul, not counted);
	// one of the person's put into Claude Code's file by the CLI, as a person who had one before Dispatch
	const mcpCli = args => JSON.parse(execFileSync('python3', [ui.rec.cli, ...args], { encoding: 'utf8', timeout: 60000,
		env: { ...process.env, HOME: home, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home,
			CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }).replace(/^[^{[]*/, ''));
	mcpCli(['mcp', 'add', 'demo-tool', '--engine', 'claude-code', '--json', '--', 'echo', 'hi']);
	const own = new Set(mcpCli(['mcp', 'list', '--json']).servers.filter(sv => sv.scope === 'user' && !sv.builtin).map(sv => sv.name)).size;
	// Settings reads the agents' settings again each time it opens: close it and open it, as a person would
	const navOpen = { css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false };
	for (let i = 0; i < 3 && (await ui.exists(navOpen)); i++) { await ui.press('Escape'); await ui.sleep(800); }
	await ui.press('Cmd+,');
	await ui.waitFor(navOpen, { timeoutMs: 15000 });
	await ui.click({ text: 'Abilities', exact: true, within: '.dispatch-settings-nav' });
	const tools = await until(async () => { const n = Number(await ui.eval(`document.querySelector('.dispatch-settings-page [data-ability="tools"] .dset-quiet')?.textContent || '0'`)); return n === own ? n || 'zero' : 0; }, 120000, 1000);
	facts.tools_count = { shown: tools === 'zero' ? 0 : tools, own };
	check(own > 0 && tools === own, `Abilities counts the agents' own tool servers (${JSON.stringify(facts.tools_count)})`);
	await ui.screenshot('23-abilities');
	mcpCli(['mcp', 'remove', 'demo-tool', '--engine', 'claude-code', '--json']);

	// ---- task-lj06.37: What Dispatch changed on a new Mac
	await ui.openCustomizations('Migrations');
	const changes = await until(() => ui.eval(`(() => { const p = document.querySelector('.migration-page'); return p && /Imported by Dispatch|Nothing imported/.test(p.innerText) ? p.innerText : ''; })()`), 60000, 1000);
	facts.changes = (changes || '').slice(0, 800);
	check(!!changes && !/Migrated/.test(changes) && !/migration checklist/i.test(changes), 'no "assistant Migrated" checklist on a new Mac');
	check(/None of your agent customization files/.test(changes || ''), 'one line says nothing needed migrating');
	await ui.screenshot('37-changes');
	await ui.mark({ css: '.migration-page' }, { what: '新用户不再看到 assistant Migrated', where: 'What Dispatch changed 页', how: '设置 › Abilities › What Dispatch changed on this Mac' });

	// ---- task-lj06.36: Settings › Phone and the pairing panel
	await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="phone"]' }).catch(() => ui.click({ text: 'Phone', exact: true, within: '.dispatch-settings-nav' }));
	const phone = await until(() => ui.eval(`(() => { const p = document.querySelector('.dispatch-settings-page'); return p && /App Store/.test(p.innerText) ? p.innerText : ''; })()`), 30000, 1000);
	check(/not in the App Store yet/.test(phone || ''), 'Settings › Phone says the iPhone app is not in the App Store yet');
	await ui.screenshot('36-settings-phone');
	if (phone) await ui.mark({ css: '.dispatch-settings-page .dset-empty, .dispatch-settings-page' }, { what: '说清 iPhone App 还没上架', where: '设置 › Phone', how: '还没配对手机时' });
	await ui.press('Escape').catch(() => undefined);
	await ui.click({ aria: 'Pair iPhone' }).catch(() => undefined);
	await ui.sleep(2000);
	if (await ui.exists({ text: 'Turn on phone access', exact: true })) {
		await ui.click({ text: 'Turn on phone access', exact: true });
	}
	const panel = await until(() => ui.eval(`(() => { const p = document.querySelector('.dispatch-mobile-get'); return p ? p.textContent : ''; })()`), 60000, 1000);
	facts.pair_panel = panel || await ui.eval(`document.querySelector('.dispatch-mobile-panel, .dispatch-mobile')?.innerText || ''`);
	check(/not in the App Store yet/.test(panel || ''), `the pairing panel says where the app is (${(panel || '').slice(0, 120)})`);
	await ui.screenshot('36-pair-panel');
	if (panel) await ui.mark({ css: '.dispatch-mobile-get' }, { what: '配对页说明 App 还没上架、即将上架', where: '二维码上方', how: '标题栏手机按钮' });
	await ui.press('Escape').catch(() => undefined);

	save();
	assert.deepEqual(facts.failed, [], `checks that did not hold: ${facts.failed.join(' · ')}`);
}
