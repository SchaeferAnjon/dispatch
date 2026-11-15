// A new user's first half hour with a release, clicked the way a person clicks it and timed: first-run.sh --as-download
// --scenario newuser.mjs runs this inside the VM with the app's own Electron as Node (scripts/ide-e2e/runner.mjs; `ui`
// is its Ui), right after the person's own first open of Dispatch IDE got through Gatekeeper. Written for the 0.9.1
// release walk (kanban task-7mmi3); what it found that night is checked here so it stays fixed.
//
//   the wizard: what is on this Mac, Install OpenCode, Add provider (OpenCode's own login, in a terminal under the
//   wizard: DeepSeek with the key first-run.sh left in ~/fresh-e2e/k), Codex says why it cannot be installed,
//   name on commits, appearance, a test banner from the app itself, Set up Dispatch
//   a project from Projects › Add a project, a session on OpenCode with DeepSeek V4.1 Flash, its first answer
//   Settings › Keys saves a made-up key and says Key saved; Soul is there
//   Settings › Agents › OpenCode › Add Provider…: its terminal shows under Settings
//
// Each check prints PASS / FAIL and each timing TIME (first-run.sh counts and shows them); all of it goes into
// checks.json and times.json next to the screenshots. A failed check does not stop the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const meta = { title: 'A new user, timed', description: 'From the first window to an answer from DeepSeek, Keys and Soul, the way a new user goes.', timeout: 2700 };

const HOME = os.homedir();
const KEY = path.join(HOME, 'fresh-e2e', 'k');
const checks = [];
const times = {};
let out = '';

function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) });
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
	fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
	return !!ok;
}

function time(name, since) {
	times[name] = Math.round((Date.now() - since) / 100) / 10;
	console.log(`  TIME  ${name}: ${times[name]} s`);
	fs.writeFileSync(path.join(out, 'times.json'), JSON.stringify(times, null, 1));
	return times[name];
}

/** The whole screen as a person sees it (first-run.sh takes it through Screen Sharing): a system dialog, a banner.
 *  With `steps` (screen.py's: click X Y …) a person's mouse on it instead, for macOS's own dialogs. */
async function screen(ui, name, steps = '') {
	fs.mkdirSync('/tmp/fresh-screen', { recursive: true });
	const f = path.join('/tmp/fresh-screen', name);
	fs.writeFileSync(f, steps);
	for (let i = 0; i < 60 && fs.existsSync(f); i++) {
		await ui.sleep(500);
	}
}

async function until(ui, fn, ms, every = 500) {
	const end = Date.now() + ms;
	for (; ;) {
		const r = await fn().catch(() => null);
		if (r) {
			return r;
		}
		if (Date.now() > end) {
			return null;
		}
		await ui.sleep(every);
	}
}

const text = (ui, css = 'body') => ui.eval(`document.querySelector(${JSON.stringify(css)})?.innerText || ''`);
const wizardRow = (ui, name) => ui.eval(`(() => { const r = [...document.querySelectorAll('.dispatch-onboarding .dob-row')].find(x => x.querySelector('.dob-n')?.innerText.trim() === ${JSON.stringify(name)}); return r ? r.innerText : ''; })()`);
const panelShown = ui => ui.eval(`(() => { const p = document.querySelector('.part.panel'); if (!p) return false; const r = p.getBoundingClientRect(); return !!p.offsetParent && r.height > 60; })()`);
const picker = ui => ui.eval(`document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim() || ''`);

/** Marks a button of a wizard row so a click can find it (rows have no ids). */
async function rowButton(ui, row, label) {
	const ok = await ui.eval(`(() => { const r = [...document.querySelectorAll('.dispatch-onboarding .dob-row')].find(x => x.querySelector('.dob-n')?.innerText.trim() === ${JSON.stringify(row)}); const b = r && [...r.querySelectorAll('a, button, .monaco-button')].find(x => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.setAttribute('data-newuser', 'target'); return true; })()`);
	return ok ? { css: '[data-newuser="target"]' } : undefined;
}

async function clearMark(ui) {
	await ui.eval(`document.querySelectorAll('[data-newuser]').forEach(e => e.removeAttribute('data-newuser'))`);
}

/** OpenCode's own `opencode auth login`, answered as a person does: the maker's name, Enter, the key, Enter. */
async function answerLogin(ui) {
	await ui.click({ css: '.part.panel .xterm-screen' });
	await ui.sleep(1500);
	await ui.type('deepseek');
	await ui.sleep(1200);
	await ui.press('Enter');
	await ui.sleep(1500);
	await ui.type(fs.readFileSync(KEY, 'utf8').trim());
	await ui.sleep(400);
	await ui.press('Enter');
}

async function focusInput(ui) {
	const css = (await ui.exists({ css: '.sessions-chat-editor' })) ? '.sessions-chat-editor' : '.interactive-session .chat-input-container .monaco-editor';
	for (let i = 0; i < 8; i++) {
		await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
		await ui.sleep(400);
		if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) {
			return true;
		}
	}
	return false;
}

async function closeTip(ui) {
	for (let i = 0; i < 3 && (await ui.exists({ css: '.dispatch-tour button.dispatch-tour-close' })); i++) {
		await ui.click({ css: '.dispatch-tour button.dispatch-tour-close' }).catch(() => undefined);
		await ui.sleep(500);
	}
}

export default async function (ui) {
	out = ui.out;
	const hasKey = fs.existsSync(KEY);
	let t = Date.now();
	// NEWUSER_FROM=setup|project|session|settings: go on from there with a VM that is already past the steps before
	const order = ['start', 'setup', 'project', 'session', 'settings'];
	const from = order.indexOf(process.env.NEWUSER_FROM || 'start');
	const runs = name => order.indexOf(name) >= from;
	if (from > 0) {
		await ui.attach('agents', 60000);
	}

	if (runs('start')) {
	// 0 a new Mac has no command line tools (git, python3): their page comes first, then macOS's own installer. Where
	// its buttons are on this VM's 2048x1536 screen: Install, then Agree, then Done when it is in.
	await ui.attach('agents', 60000);
	const first = await until(ui, async () => (await ui.exists({ css: '.dispatch-onboarding.dispatch-tools' })) ? 'tools'
		: (await ui.exists({ css: '.dispatch-onboarding .dob-row' })) ? 'wizard' : null, 90000);
	if (first === 'tools') {
		time('tools: their page is up', t);
		const page = await text(ui, '.dispatch-onboarding');
		check("a Mac without Apple's command line tools gets their page first, with Install", /command line tools/i.test(page) && await ui.exists({ text: 'Install', exact: true, within: '.dispatch-onboarding' }), page.split('\n')[0]);
		await ui.screenshot('00-tools-page');
		await screen(ui, '00s-tools-screen');
		t = Date.now();
		await ui.click({ text: 'Install', exact: true, within: '.dispatch-onboarding' });
		await ui.sleep(4000);
		await screen(ui, '00t-macos-asks');
		await screen(ui, 'click-install', 'click 1380 641');
		await ui.sleep(4000);
		await screen(ui, '00u-license');
		await screen(ui, 'click-agree', 'click 1539 1096');
		const git = '/Library/Developer/CommandLineTools/usr/bin/git';
		const inn = await until(ui, async () => fs.existsSync(git), 1200000, 5000);
		time("tools: Apple's download and install", t);
		check("macOS's installer puts the command line tools in", !!inn);
		// macOS says "The software was installed" a little after the files are in: Done, once it is there
		await ui.sleep(15000);
		await screen(ui, '00v-installed');
		await screen(ui, 'click-done', 'click 1429 515 sleep 1 click 1429 515');
		// the page sees them and the window starts again with the wizard
		t = Date.now();
		await ui.sleep(8000);
		await ui.attach('agents', 60000);
		const wizard = await until(ui, () => ui.exists({ css: '.dispatch-onboarding:not(.dispatch-tools)' }), 90000);
		time('tools: back in the wizard', t);
		check('once they are in the window starts again with the setup wizard', !!wizard);
	} else {
		check('this Mac has the command line tools (the VM image has them; a new Mac does not)', first === 'wizard');
	}

	// 1 the first window: the wizard looks at this Mac
	t = Date.now();
	check('the first window is the Agents window with the setup wizard', await until(ui, () => ui.exists({ css: '.dispatch-onboarding' }), 90000));
	const drawn = await until(ui, () => ui.eval(`!document.querySelector('.dispatch-onboarding .dob-skeleton') && !!document.querySelector('.dispatch-onboarding .dob-row')`), 60000);
	time('wizard: Looking at this Mac', t);
	check('the agents page is drawn', !!drawn);
	await ui.screenshot('01-welcome');
	await screen(ui, '01s-welcome-screen');

	// 2 agents: Codex says why, OpenCode is installed, then connected to DeepSeek with its own login
	const codex = await wizardRow(ui, 'Codex');
	check('Codex, which needs Node.js here, says so instead of a bare Not installed', /Node\.js/.test(codex), codex.replace(/\s+/g, ' '));
	const install = await rowButton(ui, 'OpenCode', 'Install');
	if (check('OpenCode has Install', !!install)) {
		t = Date.now();
		await ui.click(install);
		await clearMark(ui);
		const done = await until(ui, async () => /\d+\.\d+/.test(await wizardRow(ui, 'OpenCode')) && !/Installing/.test(await wizardRow(ui, 'OpenCode')), 300000, 1000);
		time('wizard: Install OpenCode', t);
		check('OpenCode installs from the wizard', !!done, (await wizardRow(ui, 'OpenCode')).replace(/\s+/g, ' '));
	}
	const add = await rowButton(ui, 'OpenCode', 'Add provider');
	check('OpenCode without an AI service has Add provider in the wizard', !!add, (await wizardRow(ui, 'OpenCode')).replace(/\s+/g, ' '));
	await ui.screenshot('02-agents');
	if (add && hasKey) {
		t = Date.now();
		await ui.click(add);
		await clearMark(ui);
		const shown = await until(ui, () => panelShown(ui), 20000, 300);
		check("Add provider's terminal shows under the wizard, which stays", !!shown && await ui.exists({ css: '.dispatch-onboarding' }));
		await ui.sleep(1500);
		await ui.screenshot('03-add-provider-terminal');
		await answerLogin(ui);
		const set = await until(ui, async () => /1 provider set up/.test(await wizardRow(ui, 'OpenCode')), 60000, 1000);
		time('wizard: Add provider (DeepSeek)', t);
		check('after the login the wizard says OpenCode has 1 provider', !!set, (await wizardRow(ui, 'OpenCode')).replace(/\s+/g, ' '));
		await ui.screenshot('04-provider-set');
	} else if (add) {
		await clearMark(ui);
	}

	// 3 the pages after it: permissions and the name on commits, appearance, notifications
	await ui.click({ css: '.dob-foot .dob-btn.fill' });
	await ui.waitFor({ text: 'Agent permissions', exact: true }, { timeoutMs: 30000 });
	if (await ui.exists({ text: 'Add', exact: true, within: '.dispatch-onboarding' })) {
		await ui.click({ text: 'Add', exact: true, within: '.dispatch-onboarding' });
		await ui.sleep(800);
		await ui.type('Fresh Mac');
		await ui.press('Enter');
		await ui.sleep(800);
		await ui.type('fresh-mac@example.com');
		await ui.press('Enter');
		await ui.sleep(1200);
	}
	check('the name on commits is saved', /Fresh Mac · fresh-mac@example\.com/.test(await text(ui, '.dispatch-onboarding')));
	await ui.screenshot('05-permissions');
	await ui.click({ css: '.dob-foot .dob-btn.fill' });
	await ui.waitFor({ text: 'Pick how Dispatch looks', exact: true }, { timeoutMs: 30000 });
	await ui.screenshot('06-appearance');
	await ui.click({ css: '.dob-foot .dob-btn.fill' });
	await ui.waitFor({ text: 'Stay in the loop', exact: true }, { timeoutMs: 30000 });
	await ui.click({ text: 'Tell me when an agent finishes or needs me', exact: true, within: '.dispatch-onboarding' });
	await ui.click({ text: 'Send a test notification', exact: true, within: '.dispatch-onboarding' });
	await ui.sleep(1500);
	await screen(ui, '07s-test-banner');
	const said = await text(ui, '.dispatch-onboarding');
	check('the test banner comes from Dispatch IDE itself', /allow Dispatch IDE/.test(said), (said.match(/A banner was sent[^\n]*/) || [''])[0]);
	await ui.screenshot('07-notifications');

	}

	// 4 set up
	if (runs('setup')) {
	if (!/Connect Dispatch to/.test(await text(ui, '.dispatch-onboarding'))) {
		await ui.click({ css: '.dob-foot .dob-btn.fill' });
	}
	// "Connect Dispatch to OpenCode" with one agent, "… to your agents" with more
	await until(ui, async () => /Connect Dispatch to/.test(await text(ui, '.dispatch-onboarding')), 30000);
	await until(ui, () => ui.eval(`[...document.querySelectorAll('.dispatch-onboarding .dob-btn')].some(b => b.innerText.trim() === 'Set up Dispatch' && b.getAttribute('aria-disabled') !== 'true' && !b.classList.contains('disabled'))`), 60000);
	await ui.screenshot('08-connect');
	t = Date.now();
	await ui.click({ text: 'Set up Dispatch', exact: true, within: '.dispatch-onboarding' });
	const result = await until(ui, async () => {
		if (await ui.exists({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' })) {
			await ui.click({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' });
		}
		return (await ui.exists({ text: 'Start', exact: true, within: '.dispatch-onboarding' })) ? 'start'
			: (await ui.exists({ text: 'Retry setup', exact: true, within: '.dispatch-onboarding' })) ? 'retry' : null;
	}, 360000, 1000);
	time('wizard: Set up Dispatch', t);
	check('setup finishes', result === 'start', result === 'retry' ? await text(ui, '.dispatch-onboarding .dob-well.prog') : result || 'no Start after 6 min');
	await ui.screenshot('09-setup-done');
	await ui.click({ text: 'Start', exact: true, within: '.dispatch-onboarding' }).catch(() => undefined);
	await ui.sleep(6000);
	await ui.screenshot('10-assistant-whats-new');
	for (let i = 0; i < 3 && (await ui.exists({ css: '.dispatch-whats-new-card' })); i++) {
		await ui.press('Escape');
		await ui.sleep(500);
	}
	await screen(ui, '10s-after-setup-screen');

	}

	// 5 a project
	if (runs('project')) {
	for (let i = 0; i < 3 && (await ui.exists({ css: '.dispatch-whats-new-card' })); i++) {
		await ui.press('Escape');
		await ui.sleep(500);
	}
	await ui.click({ text: 'Projects', exact: true });
	await ui.waitFor({ css: 'button.dispatch-ap-empty-btn' }, { timeoutMs: 30000 });
	await ui.click({ css: 'button.dispatch-ap-empty-btn' });
	await ui.waitFor({ css: '.dispatch-ap' }, { timeoutMs: 15000 });
	await ui.click({ text: 'Start a new project', exact: true, within: '.dispatch-ap' });
	await ui.type('demo', { into: { css: '.dispatch-ap input[data-field="name"]' } });
	await ui.screenshot('11-new-project');
	t = Date.now();
	await ui.press('Enter');
	await ui.waitFor({ css: '.dispatch-ap' }, { gone: true, timeoutMs: 240000 });
	time('project: Create project', t);
	if (await until(ui, () => ui.exists({ text: 'Trust Folder & Continue', exact: true, within: '.monaco-dialog-box' }), 8000)) {
		check('a folder Dispatch just made does not ask whether to trust it', false);
		await ui.click({ text: 'Trust Folder & Continue', exact: true, within: '.monaco-dialog-box' });
	}
	check('the project is made', fs.existsSync(path.join(HOME, 'Projects', 'demo')));
	await ui.sleep(1500);
	await closeTip(ui);
	await ui.screenshot('12-project-page');

	}

	// 6 the first message: OpenCode with DeepSeek V4.1 Flash
	if (runs('session')) {
	await ui.click({ text: 'New Session', exact: true });
	await until(ui, () => ui.exists({ css: '.sessions-chat-editor' }), 30000);
	await closeTip(ui);
	if ((await picker(ui)) !== 'OpenCode') {
		await ui.click({ css: '.sessions-chat-session-type-picker' });
		await ui.sleep(800);
		await ui.click({ text: 'OpenCode', exact: true, within: '.action-widget' });
		await until(ui, async () => (await picker(ui)) === 'OpenCode', 20000);
	}
	await closeTip(ui);
	check('the new session is on OpenCode', (await picker(ui)) === 'OpenCode', await picker(ui));
	// the model picker under the input (a leaf with the model's name, outside answers and open menus)
	const model = () => ui.eval(`[...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && e.offsetParent && !e.closest('.interactive-response, .action-widget, .context-view') && /DeepSeek|Pickle|Free$/.test(e.textContent.trim())).map(e => e.textContent.trim())[0] || ''`);
	if (hasKey && !/DeepSeek/.test(await model())) {
		await ui.click({ text: await model(), exact: true });
		await ui.sleep(1200);
		if (await ui.exists({ text: 'Other Models', exact: true })) {
			await ui.click({ text: 'Other Models', exact: true });
			await ui.sleep(800);
		}
		await ui.eval(`[...document.querySelectorAll('.action-widget .monaco-list-row')].find(r => r.innerText.includes('DeepSeek V4.1 Flash'))?.scrollIntoView({ block: 'center' })`);
		await ui.click({ text: 'DeepSeek V4.1 Flash', exact: true });
		await ui.sleep(1000);
	}
	if (hasKey) {
		check('the model is DeepSeek V4.1 Flash', /DeepSeek V4\.1 Flash/.test(await model()), await model());
	}
	if (await focusInput(ui)) {
		await ui.type('Write a file hello.txt in this project that says hello from a new Mac, then tell me in one short sentence what you did.');
		await ui.screenshot('13-first-message');
		t = Date.now();
		await ui.press('Enter', { send: true });
		let first = 0;
		const reply = await until(ui, async () => {
			const r = await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r ? { text: r.innerText, loading: r.classList.contains('chat-response-loading') || !!document.querySelector('.chat-response-loading') } : null; })()`);
			if (r && r.text.trim() && !first) {
				first = Date.now();
			}
			return r && r.text.trim() && !r.loading ? r.text : null;
		}, 300000, 500);
		if (first) {
			times['session: first words'] = Math.round((first - t) / 100) / 10;
		}
		time('session: whole answer', t);
		const file = path.join(HOME, 'Projects', 'demo', 'hello.txt');
		check('the agent answers and wrote hello.txt', !!reply && fs.existsSync(file), (reply || 'no answer').replace(/\s+/g, ' ').slice(-200));
		check(hasKey ? 'the answer came from DeepSeek V4.1 Flash' : 'the answer came from OpenCode', hasKey ? /DeepSeek V4\.1 Flash/.test(reply || '') : !!reply, (reply || '').split('\n').pop());
		await ui.sleep(1500);
		await closeTip(ui);
		await ui.screenshot('14-first-answer');
	} else {
		check('the message box takes the focus', false);
	}

	}

	// 7 Settings: Keys saves a made-up key and says so; Soul is there
	if (!(await ui.exists({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }))) {
		await ui.press('Cmd+,');
	}
	await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }, { timeoutMs: 15000 });
	await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]', webview: false });
	// a key saved already (a walk that goes on from here): the form's own button instead of the empty list's
	if (!(await until(ui, () => ui.exists({ css: '[data-keys="add-first"]', webview: false }), 8000))) {
		await ui.eval(`(() => { const k = [...document.querySelectorAll('.dispatch-settings-page [data-keys]')].find(e => /Add a key/.test(e.innerText)); k?.setAttribute('data-keys', 'add-first'); })()`);
	}
	await ui.click({ css: '[data-keys="add-first"]', webview: false });
	await ui.type('WEATHER_API_KEY', { into: { css: '.dispatch-settings-page input[aria-label="Name"]', webview: false } });
	await ui.type('fake-0000-1111-2222', { into: { css: '.dispatch-settings-page input[aria-label="Value"]', webview: false } });
	await ui.type('Test key for the new-user walk', { into: { css: '.dispatch-settings-page input[aria-label="What it is for"]', webview: false } });
	await ui.screenshot('15-keys-form');
	t = Date.now();
	await ui.press('Enter');
	const toast = await until(ui, () => ui.eval(`[...document.querySelectorAll('.dispatch-keys-toast')].map(x => x.innerText).join(' ')`), 15000, 200);
	time('settings: Key saved', t);
	check('saving a key brings up Key saved', /Key saved: WEATHER_API_KEY/.test(toast || ''), String(toast).replace(/\s+/g, ' '));
	await ui.screenshot('16-key-saved');
	await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="soul"]', webview: false });
	const soul = await until(ui, async () => /SOUL\.md/.test(await text(ui, '.dispatch-settings-page')), 15000);
	check('Settings › Soul shows ~/.dispatch/rules/SOUL.md', !!soul);
	await ui.screenshot('17-soul');

	// 8 Settings › Agents › OpenCode › Add Provider…: its terminal under Settings (closed again without an answer)
	await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
	await ui.click({ css: '.dispatch-settings-page .dset-row[data-agent="opencode"]', webview: false });
	// below the fold on a short window: there in the page first, then scrolled to
	for (let i = 0; i < 180 && !(await ui.eval(`!!document.querySelector('.opencode-settings-add-provider')`)); i++) await ui.sleep(500);
	await ui.eval(`document.querySelector('.opencode-settings-add-provider').scrollIntoView({ block: 'center' })`);
	await ui.click({ css: '.opencode-settings-add-provider', webview: false });
	const under = await until(ui, () => panelShown(ui), 20000, 300);
	check('Settings › OpenCode › Add Provider… shows its terminal under Settings', !!under && await ui.exists({ css: '.dispatch-settings-page', webview: false }));
	await ui.sleep(1500);
	await ui.screenshot('18-settings-add-provider');

	const failed = checks.filter(c => !c.ok).length;
	console.log(`  checks: ${checks.length - failed} passed, ${failed} failed`);
	return { times, failed };
}
