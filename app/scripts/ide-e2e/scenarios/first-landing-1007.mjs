// A new person's first minutes, the 10-07 bug hunt's interface bugs on that path. Start the instance with
// `dispatch ide instance start <name> --onboarding fresh --agents` (a fresh HOME, no projects yet).
//   task-xw428  the setup's notes point at Settings pages that exist; an empty Settings › Projects can add one
//   task-5dom6  right after Start the Welcome card leaves the message box and Turbo clear, and no preview pops up
//               under the pointer that clicked Start
//   task-9oc82  Settings in the side bar: a NEW badge, whole, its explanation on hover; gone once Settings was opened
// FL_SOFT=1 notes a failed check and goes on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { instance: { onboarding: 'fresh', tips: true }, title: '10-07 新用户第一次进来', description: '向导里的指路、Start 后 Welcome 卡不挡输入框、左下角 Settings 的 NEW、空的 Projects 页能加项目。', timeout: 900 };

const rect = `(e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; })`;
const visible = `(s => [...document.querySelectorAll(s)].filter(e => e.offsetParent || getComputedStyle(e).position === 'fixed'))`;
const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

export default async function (ui) {
	assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
	const facts = { failed: [] };
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => {
		if (ok) return;
		facts.failed.push(message);
		save();
		if (process.env.FL_SOFT !== '1') assert.fail(message);
	};
	const text = () => ui.eval("document.querySelector('.dispatch-onboarding')?.innerText || ''");
	await ui.attach('agents', 60000);
	await ui.eval('window.resizeTo(1440, 900)');
	await ui.waitFor({ css: '.dispatch-onboarding' }, { timeoutMs: 90000 });

	// the setup, screen by screen, reading what each one points at
	const said = [];
	for (let i = 0; i < 14 && !(await ui.exists({ text: 'Start', exact: true })); i++) {
		await ui.sleep(1200);
		said.push(await text());
		if (/Pick how Dispatch looks/.test(said.at(-1))) await ui.screenshot('01-appearance-note');
		if (/Agent permissions/.test(said.at(-1))) await ui.screenshot('01-permissions-note');
		if (await ui.exists({ text: 'Set up Dispatch', exact: true })) {
			await ui.waitForText('Everything is listed in Settings', { timeoutMs: 60000 }).catch(() => undefined);
			said.push(await text());
			await ui.screenshot('01-setup-note');
			await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
			for (let j = 0; j < 180 && !(await ui.exists({ text: 'Start', exact: true })); j++) await ui.sleep(1000);
			break;
		}
		await ui.waitFor({ css: '.dob-foot .dob-btn.fill' }, { timeoutMs: 30000 });
		await ui.click({ css: '.dob-foot .dob-btn.fill' });
	}
	const all = said.join('\n');
	facts.setupNotes = all.split('\n').filter(l => /any time|Everything is listed|title bar/.test(l));
	check(!/in Customizations|Customizations ›/.test(all), `the setup still points at Customizations: ${facts.setupNotes.join(' / ')}`);
	check(!/sun and moon/.test(all), 'the setup still points at a sun and moon button');
	check(/Settings › Agents/.test(all) && /Settings › Appearance/.test(all), `the setup does not say where in Settings: ${facts.setupNotes.join(' / ')}`);
	save();

	// Start with the real pointer, which then stays where Start was
	const start = await ui.eval(`(() => { const b = [...document.querySelectorAll('.dob-btn')].find(x => x.textContent.trim() === 'Start'); const r = b.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
	await ui.mouse('mouseMoved', start[0], start[1]);
	await ui.click({ text: 'Start', exact: true });
	await ui.waitFor({ css: '.dispatch-whats-new-card' }, { timeoutMs: 30000 });
	const geometry = () => ui.eval(`(() => { const r = ${rect}; const v = ${visible};
		return { card: r(document.querySelector('.monaco-hover.dispatch-whats-new-hover')), detail: v('.dispatch-hover-detail-panel').map(r),
			input: r(v('.sessions-chat-editor').at(-1)), turbo: r(v('.dispatch-turbo-chip')[0]), send: r(v('.chat-execute-toolbar, .new-session-send, .sessions-chat-send').at(-1)) }; })()`);
	facts.landing = [];
	for (const ms of [400, 3000, 7000]) {
		await ui.sleep(ms - (facts.landing.length ? [400, 3000][facts.landing.length - 1] : 0));
		facts.landing.push({ at: ms, ...(await geometry()) });
	}
	const g = facts.landing.at(-1);
	check(facts.landing.every(s => s.detail.length === 0), `a preview popped up under the resting pointer: ${JSON.stringify(facts.landing.map(s => s.detail))}`);
	check(!overlap(g.card, g.input), `the Welcome card ${JSON.stringify(g.card)} covers the message box ${JSON.stringify(g.input)}`);
	check(!overlap(g.card, g.turbo), `the Welcome card covers Turbo ${JSON.stringify(g.turbo)}`);
	await ui.screenshot('02-welcome-clear');
	await ui.mark({ css: '.monaco-hover.dispatch-whats-new-hover' }, { what: 'Welcome 卡停在输入框上面', where: '标题栏右端往下', how: '向导点 Start 之后自动出现，点外面或 Esc 关' });
	if (g.turbo) await ui.mark({ css: '.dispatch-turbo-chip' }, { what: 'Turbo 和发送键露在外面', where: '输入框下面一行', how: '不用先关 Welcome 卡' });
	// the preview still comes once the pointer moves onto a row
	// (the card scrolls when the message box is high on the page, while the home is still reading: the row in view first)
	const row = await ui.eval(`(() => { const r = [...document.querySelectorAll('.dispatch-whats-new-card .wnrow')][1]; if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`);
	if (row) {
		await ui.sleep(300);
		for (let i = 1; i <= 6; i++) await ui.mouse('mouseMoved', row[0] - 60 + i * 10, row[1] + i);
		for (let i = 0; i < 6 * SCALE && !(await geometry()).detail.length; i++) await ui.sleep(400);
		facts.previewAfterMove = (await geometry()).detail.length;
		check(facts.previewAfterMove > 0, 'pointing at a row no longer shows its preview');
		await ui.screenshot('03-preview-on-move');
	}
	save();
	await ui.press('Escape');
	await ui.sleep(1200);

	// Settings at the bottom of the side bar: NEW, whole, with its sentence on hover and in its label
	const entry = () => ui.eval(`(() => { const r = ${rect}; const e = document.querySelector('.dset-entry'); const h = document.querySelector('.dset-entry-hint');
		return { entry: r(e), hint: r(h), hidden: !h || h.hidden || !h.offsetParent, text: h?.textContent || '', label: e?.getAttribute('aria-label') || '', cut: !!h && h.scrollWidth > h.clientWidth + 1 }; })()`);
	facts.entry = await entry();
	check(!facts.entry.hidden && facts.entry.text === 'New' && !facts.entry.cut, `the Settings row's hint: ${JSON.stringify(facts.entry)}`);
	check(facts.entry.hint && facts.entry.entry && facts.entry.hint.r <= facts.entry.entry.r, 'the NEW badge runs past the Settings row');
	check(/Skills, tools, hooks and sub-agents are in Settings now/.test(facts.entry.label), `the Settings row's label: ${facts.entry.label}`);
	await ui.hover({ css: '.dset-entry-hint' });
	await ui.sleep(1500);
	facts.badgeHover = await ui.eval(`[...document.querySelectorAll('.monaco-hover')].map(h => h.innerText).join(' | ')`);
	check(/Skills, tools, hooks and sub-agents are in Settings now/.test(facts.badgeHover), `hovering NEW says: ${facts.badgeHover}`);
	await ui.screenshot('04-settings-new');
	await ui.mark({ css: '.dset-entry' }, { what: '左下角 Settings 旁的 NEW', where: '左栏最底下', how: '鼠标停在 NEW 上看说明；打开过设置就不再出现' });
	// the side bar at its narrowest: the badge still whole
	const sash = await ui.eval(`(() => { const s = document.querySelector('.part.sidebar').getBoundingClientRect(); const h = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect()).find(b => b.height > 200 && Math.abs(b.x + b.width / 2 - s.right) < 14); return h ? [h.x + h.width / 2, h.y + h.height / 2] : null; })()`);
	if (sash) {
		await ui.mouse('mouseMoved', sash[0], sash[1]);
		await ui.mouse('mousePressed', sash[0], sash[1], { button: 'left', clickCount: 1 });
		// down to the side bar's narrowest (further would hide it)
		for (let i = 1; i <= 10; i++) await ui.mouse('mouseMoved', sash[0] - i * 4, sash[1], { button: 'left', buttons: 1 });
		await ui.mouse('mouseReleased', sash[0] - 40, sash[1], { button: 'left', clickCount: 1 });
		await ui.sleep(1000);
		facts.entryNarrow = await entry();
		facts.sidebarNarrow = await ui.eval(`Math.round(document.querySelector('.part.sidebar').getBoundingClientRect().width)`);
		check(!facts.entryNarrow.hidden && !facts.entryNarrow.cut && facts.entryNarrow.hint && facts.entryNarrow.hint.r <= facts.entryNarrow.entry.r, `in a narrow side bar the badge is cut: ${JSON.stringify(facts.entryNarrow)}`);
		await ui.screenshot('05-settings-new-narrow');
	}
	save();

	// Settings › Projects with no project: an Add Project button that opens Add Project
	await ui.press('Cmd+,');
	await ui.waitFor({ css: '.dispatch-settings-page' }, { timeoutMs: 15000 });
	await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="projects"]', webview: false });
	await ui.sleep(3000);
	facts.projectsPage = await ui.eval(`document.querySelector('.dispatch-settings-page')?.innerText.replace(/\\s+/g, ' ').slice(0, 300) || ''`);
	check(!/new session page/.test(facts.projectsPage), `Settings › Projects still points at the new session page: ${facts.projectsPage}`);
	if (/No projects yet/.test(facts.projectsPage)) {
		await ui.screenshot('06-projects-empty');
		await ui.mark({ text: 'Add Project', exact: true, within: '.dispatch-settings-page' }, { what: '空的 Projects 页直接能加项目', where: '设置 › Projects', how: '点 Add Project' });
		await ui.click({ text: 'Add Project', exact: true, within: '.dispatch-settings-page' });
		await ui.sleep(2500);
		facts.addProjectOpened = await ui.eval(`[...document.querySelectorAll('.dap-way-title')].filter(e => e.offsetParent).map(e => e.textContent.trim())`);
		facts.addProjectOpened = facts.addProjectOpened.length ? facts.addProjectOpened : false;
		check(facts.addProjectOpened, 'Add Project on the empty Projects page opened nothing');
		await ui.screenshot('07-add-project');
		await ui.press('Escape');
	}
	await ui.press('Escape');
	await ui.sleep(1500);
	// once Settings was opened the badge is gone
	facts.entryAfter = await entry();
	check(facts.entryAfter.hidden, 'NEW is still next to Settings after Settings was opened');
	save();
	assert.deepEqual(facts.failed, [], facts.failed.join('\n'));
}
