// Soul (kanban task-8cn69) on a new Mac, the way a person meets it: setup gives every agent the default Soul; in
// Settings › Soul they change a line and save, the line reaches Claude Code, Codex and OpenCode; Reset to default
// puts the default back; the switch takes Soul out of every agent and puts it back. Start the instance with
// `dispatch ide instance start <name> --onboarding fresh --agents` (a fresh HOME with stand-in agents).
// Every check is noted in facts.json; the run fails at the end when one did not hold.
import fs from 'node:fs';
import path from 'node:path';

export const meta = { instance: { onboarding: 'fresh' }, title: 'Soul：新用户默认有，设置里改、存、恢复默认、关掉', description: '首次设置后三个 Agent 的规则里都有默认 Soul；设置 › Soul 改一句保存，三个都跟着变；Reset to default 回到默认；关掉后规则里没有，打开又回来。', timeout: 1500 };

const LINE = 'Answer in the language the person writes in, in one short paragraph.';
const DEFAULT_MARK = 'Quick, exact, plain.';

export default async function (ui) {
	if (!ui.rec.fixture_home) {
		throw new Error('Start this instance with --onboarding fresh');
	}
	const home = ui.rec.fixture_home;
	const files = {
		claude: path.join(home, '.claude', 'CLAUDE.md'),
		codex: path.join(home, '.codex', 'AGENTS.md'),
		opencode: path.join(home, '.config', 'opencode', 'AGENTS.md'),
	};
	const soulFile = path.join(ui.rec.dispatch_home, 'rules', 'SOUL.md');
	const facts = { failed: [], passed: [] };
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => { (ok ? facts.passed : facts.failed).push(message); save(); };
	const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
	const until = async (fn, ms, step = 500) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => undefined); if (v) return v; await ui.sleep(step); } return v; };
	/** What each agent gets: Codex and OpenCode carry the text, Claude Code imports SOUL.md. */
	const agents = () => {
		const c = read(files.claude);
		const imports = /^@.*SOUL\.md$/m.test(c);
		const soul = read(soulFile);
		return {
			claude: imports ? soul : '',
			claudeImportsSoul: imports,
			codex: read(files.codex),
			opencode: read(files.opencode),
			soul,
		};
	};

	// ---- setup, as a new person does it
	await ui.attach('agents', 90000);
	await ui.eval('window.resizeTo(1440, 900)');
	await until(() => ui.exists({ css: '.dispatch-onboarding' }), 60000);
	for (let i = 0; i < 16 && !(await ui.exists({ text: 'Start', exact: true })); i++) {
		await ui.sleep(1200);
		if (/SOUL\.md/.test(await ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''"))) {
			facts.wizard_lists_soul = true;
			await ui.screenshot('00-setup-lists-soul');
		}
		if (await ui.exists({ text: 'Set up Dispatch', exact: true })) {
			// the button stays off until the page has read its plan (a busy Mac takes a few seconds): a person waits
			// until it is on, then presses it; a press on it while off does nothing
			const on = () => ui.eval(`[...document.querySelectorAll('.dispatch-onboarding .dob-btn.fill')].some(b => b.innerText.trim() === 'Set up Dispatch' && !b.classList.contains('disabled') && b.getAttribute('aria-disabled') !== 'true')`);
			await until(on, 60000);
			if (/SOUL\.md/.test(await ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''"))) {
				facts.wizard_lists_soul = true;
				await ui.screenshot('00-setup-lists-soul');
			}
			await ui.click({ text: 'Set up Dispatch', exact: true });
			for (let j = 0; j < 480 && !(await ui.exists({ text: 'Start', exact: true })); j++) await ui.sleep(1000);
			break;
		}
		await ui.waitFor({ css: '.dob-foot .dob-btn.fill' }, { timeoutMs: 60000 });
		await ui.click({ css: '.dob-foot .dob-btn.fill' });
	}
	check(facts.wizard_lists_soul, 'the setup page that lists the rules files names SOUL.md');
	await ui.click({ text: 'Start', exact: true });
	await ui.sleep(4000);
	await ui.press('Escape').catch(() => undefined);
	if (await ui.exists({ css: '.dispatch-tour' })) {
		await ui.click({ css: '.dispatch-tour-head button' }).catch(() => undefined);
	}

	let a = agents();
	facts.after_setup = { soul_lines: a.soul.split('\n').length, claude_imports: a.claudeImportsSoul };
	check(a.soul.startsWith('# Soul\n') && a.soul.includes(DEFAULT_MARK), 'a new person has the default Soul in ~/.dispatch/rules/SOUL.md');
	check(a.claudeImportsSoul && a.codex.includes(DEFAULT_MARK) && a.opencode.includes(DEFAULT_MARK), 'Claude Code, Codex and OpenCode all get the default Soul after setup');
	check([files.claude, files.codex, files.opencode].every(f => read(f).split('BEGIN DISPATCH GLOBAL RULES').length === 2), 'each agent\'s rules file has exactly one Dispatch block');

	// ---- Settings › Soul
	await ui.press('Cmd+,');
	await ui.waitFor({ css: '.dispatch-settings-nav .dsn-row[data-page="soul"]' }, { timeoutMs: 20000 });
	await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="soul"]' });
	await ui.waitFor({ css: '.dset-soul-editor .view-line' }, { timeoutMs: 30000 });
	await ui.sleep(800);
	const page = () => ui.eval(`(() => ({
		kind: document.querySelector('.dset-soul-kind')?.dataset.kind || '',
		on: document.querySelector('[data-soul="switch"] .monaco-custom-toggle')?.classList.contains('checked'),
		status: document.querySelector('.dset-soul-status')?.textContent || '',
		problem: document.querySelector('.dispatch-settings-page .dset-problem:not([hidden])')?.textContent || '',
		saveEnabled: !document.querySelector('[data-soul="save"]')?.classList.contains('disabled'),
		resetEnabled: !document.querySelector('[data-soul="reset"]')?.classList.contains('disabled'),
		text: [...document.querySelectorAll('.dset-soul-editor .view-line')].sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top).map(l => l.textContent.replace(/\\u00a0/g, ' ')).join('\\n'),
		title: document.querySelector('.custom-view-node[data-view-id="dispatch.settings"] .custom-view-header-title')?.textContent || '',
	}))()`);
	let p = await page();
	facts.page_first = p;
	check(p.title.endsWith('Soul'), `the page is titled Soul (${p.title})`);
	check(p.kind === 'default' && p.on === true, 'the page says Soul is on and is the default');
	check(p.text.includes(DEFAULT_MARK), 'the editor shows the default text');
	check(!p.saveEnabled && !p.resetEnabled, 'Save and Reset to default are grey while nothing is changed');
	await ui.screenshot('01-soul-default');
	await ui.mark({ css: '.dispatch-settings-nav .dsn-row[data-page="soul"]' }, { what: 'Soul 页入口', where: '设置左栏 Agents 下面', how: '⌘, 打开设置，点 Soul' });
	await ui.mark({ css: '[data-soul="switch"]' }, { what: 'Use Soul 开关和 Default 标签', where: '页面最上面一行', how: '关掉后所有 Agent 用各自原来的口气' });
	await ui.mark({ css: '.dset-soul-editor' }, { what: '所有 Agent 读的 Soul 原文', where: '页面中间', how: '直接改，⌘S 或 Save 保存' });
	await ui.mark({ css: '.dset-soul-actions' }, { what: 'Save / Undo changes / Reset to default', where: '原文下面', how: '改了才能点' });

	// ---- change one line and save: put it on the empty line under the first sentence
	await ui.eval(`(() => { const lines = [...document.querySelectorAll('.dset-soul-editor .view-line')].sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
		const empty = lines.find((l, i) => i > 0 && !l.textContent.trim()); if (empty) empty.setAttribute('data-e2e', 'soul-empty'); return !!empty; })()`);
	await ui.click({ css: '[data-e2e="soul-empty"]' });
	await ui.type(LINE);
	p = await until(async () => { const x = await page(); return x.saveEnabled ? x : undefined; }, 5000);
	check(p && p.saveEnabled && /Not saved yet/.test(p.status), 'typing makes Save clickable and says it is not saved yet');
	await ui.screenshot('02-soul-edited');
	await ui.click({ css: '[data-soul="save"]' });
	p = await until(async () => { const x = await page(); return /Saved/.test(x.status) ? x : undefined; }, 60000);
	facts.page_saved = p;
	check(p && p.kind === 'changed', 'after Save the tag says Changed by you');
	a = agents();
	check(a.soul.includes(LINE), 'the line is in ~/.dispatch/rules/SOUL.md');
	check(a.claude.includes(LINE) && a.codex.includes(LINE) && a.opencode.includes(LINE), 'the line reaches Claude Code, Codex and OpenCode');
	const backups = path.join(ui.rec.dispatch_home, 'backups');
	const kept = [];
	const walk = d => { for (const n of (fs.existsSync(d) ? fs.readdirSync(d) : [])) { const q = path.join(d, n); fs.statSync(q).isDirectory() ? walk(q) : kept.push(path.relative(backups, q)); } };
	walk(backups);
	facts.backups = kept;
	check(kept.some(k => k.endsWith(path.join('rules', 'SOUL.md'))), 'the replaced Soul is kept in ~/.dispatch/backups/<date>/');
	const beside = [files.claude, files.codex, files.opencode, soulFile].flatMap(f => fs.readdirSync(path.dirname(f)).filter(n => /\.(bak|orig|old)\b|\.bak-/.test(n)).map(n => path.join(path.dirname(f), n)));
	facts.beside = beside;
	check(beside.length === 0, `no .bak beside the rules files (${beside.join(', ') || 'none'})`);
	await ui.screenshot('03-soul-saved');
	await ui.mark({ css: '.dset-soul-kind' }, { what: '标签变成 Changed by you', where: 'Use Soul 后面', how: '保存后' });
	await ui.mark({ css: '.dset-soul-status' }, { what: '保存结果：新会话都用它', where: '按钮下面', how: '点 Save 之后' });

	// ---- Reset to default
	await ui.click({ css: '[data-soul="reset"]' });
	await ui.waitFor({ text: 'Reset', exact: true }, { timeoutMs: 10000 });
	await ui.screenshot('04-reset-confirm');
	await ui.click({ text: 'Reset', exact: true });
	p = await until(async () => { const x = await page(); return /Back to the default/.test(x.status) ? x : undefined; }, 60000);
	facts.page_reset = p;
	a = agents();
	check(p && p.kind === 'default' && !p.text.includes(LINE), 'Reset to default shows the default again');
	check(!a.soul.includes(LINE) && a.soul.includes(DEFAULT_MARK) && !a.codex.includes(LINE) && !a.opencode.includes(LINE) && a.codex.includes(DEFAULT_MARK), 'after Reset every agent has the default again');
	await ui.screenshot('05-soul-reset');

	// ---- off, then on again
	await ui.click({ css: '[data-soul="switch"] .monaco-custom-toggle' });
	p = await until(async () => { const x = await page(); return /Soul is off/.test(x.status) ? x : undefined; }, 60000);
	a = agents();
	facts.off = { claudeImportsSoul: a.claudeImportsSoul, codex: a.codex.includes(DEFAULT_MARK), opencode: a.opencode.includes(DEFAULT_MARK) };
	check(p && p.on === false, 'the switch shows off');
	check(!a.claudeImportsSoul && !a.codex.includes(DEFAULT_MARK) && !a.opencode.includes(DEFAULT_MARK), 'off: no agent\'s rules have Soul');
	check(a.codex.includes('# Dispatch rules for agents') && a.opencode.includes('# Dispatch rules for agents'), 'off: Dispatch\'s own rules stay');
	check(fs.existsSync(soulFile), 'off: the text is kept for later');
	await ui.screenshot('06-soul-off');
	await ui.mark({ css: '[data-soul="switch"]' }, { what: '关掉：三个 Agent 的规则里都没有 Soul', where: '页面最上面', how: '再点一次打开' });
	await ui.click({ css: '[data-soul="switch"] .monaco-custom-toggle' });
	p = await until(async () => { const x = await page(); return /Soul is on/.test(x.status) ? x : undefined; }, 60000);
	a = agents();
	check(p && p.on === true && a.claudeImportsSoul && a.codex.includes(DEFAULT_MARK) && a.opencode.includes(DEFAULT_MARK), 'on again: every agent has Soul back');

	// ---- search finds it by a plain word
	await ui.click({ css: '.dispatch-settings-nav .dsn-search input' }).catch(() => undefined);
	if (await ui.exists({ css: '.dispatch-settings-nav .dsn-search input' })) {
		await ui.type('tone', { into: { css: '.dispatch-settings-nav .dsn-search input' } });
		const found = await until(() => ui.eval("[...document.querySelectorAll('.dispatch-settings-page *')].some(e => e.children.length === 0 && /^Soul$/.test(e.textContent.trim()))"), 8000);
		check(found, 'searching Settings for "tone" finds Soul');
		await ui.screenshot('07-search-tone');
	}

	// ---- next to its neighbours, for the side by side DESIGN.md asks for
	await ui.press('Escape').catch(() => undefined);
	for (const [pg, shot] of [['notifications', '08-neighbour-notifications'], ['instructions', '09-neighbour-instructions']]) {
		if (await ui.exists({ css: `.dispatch-settings-nav .dsn-row[data-page="${pg}"]` })) {
			await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${pg}"]` });
			await ui.sleep(2500);
			await ui.screenshot(shot);
		}
	}

	save();
	if (facts.failed.length) {
		throw new Error(`${facts.failed.length} check(s) failed: ${facts.failed.join(' | ')}`);
	}
}
