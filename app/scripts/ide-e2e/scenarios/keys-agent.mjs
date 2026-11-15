// An agent saves a key in a chat (kanban task-d5ejn): OpenCode with the cheap test model runs `dispatch env set` in its
// shell, reading the made-up value from a file (fixtures/keys_home.py), and the session shows "Key saved: NAME — purpose"
// above its input, with Show and Undo. The reply names the key, never the value. Talks to a real agent: test instance
// only, and the instance has a HOME of its own, so this Mac's key store is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { newSession, replyDone, say } from './preferences.mjs';

export const meta = {
	instance: { fixture: 'keys-home' },
	needs: ['opencode'],
	env: { ENGINE: 'OpenCode', MODEL: '' },
	timeout: 900,
	title: 'Keys：Agent 在对话里存 key 也弹提示',
	description: 'OpenCode（便宜模型）在会话里用 dispatch env set 存一个假 key（值从文件读）：会话输入框上方弹 Key saved: 名字 — 用途，带 Show 和 Undo；回复里只说名字不说值；Show 跳到设置 › Keys 那一行，Undo 撤掉。',
};

const KEY = { name: 'FAKE_AGENT_KEY', note: 'Test key saved by an agent', value: 'fake-e2e-agent-0007' };
const AGENT_MS = 300000;

export default async function (ui) {
	const rec = ui.rec;
	if (!rec.keys_home) {
		throw new Error('Start this instance with --fixture keys-home (meta.instance), so it has a HOME of its own');
	}
	const store = path.join(rec.keys_home, '.config', 'dispatch', 'env');
	const has = () => (fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : '').includes(`${KEY.name}=${KEY.value}`);
	const facts = { failed: [], passed: [] };
	const save = () => fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 1));
	const check = (ok, message) => { (ok ? facts.passed : facts.failed).push(message); save(); };
	const toast = () => ui.eval(`(() => { const t = [...document.querySelectorAll('.dispatch-keys-toast')].find(e => e.getClientRects().length && !e.classList.contains('out')); return t ? { text: t.innerText.replace(/\\s+/g, ' ').trim(), inSlot: !!t.closest('.dispatch-keys-toast-slot'), inChat: !!t.closest('.interactive-input-part') } : null; })()`);

	await ui.openAgents(ui.demoFolder);
	await newSession(ui);
	await say(ui, `Save a made-up test key in Dispatch's key store. Run exactly this one command in the shell: dispatch env set ${KEY.name} --stdin --note "${KEY.note}" < ~/fake-agent-value.txt  Do not read or print that file. Then answer in one sentence.`);
	// the toast comes the moment the command has run, while the reply may still be going
	let t;
	for (const end = Date.now() + AGENT_MS; Date.now() < end && !(t && /Key saved:/.test(t.text)); await ui.sleep(1000)) {
		t = await toast();
		if (!t && await ui.exists({ text: 'Allow', exact: true }) && await ui.exists({ text: 'Skip', exact: true })) {
			await ui.click({ text: 'Allow', exact: true });
		}
	}
	facts.toast = t;
	check(t && t.text.includes(`Key saved: ${KEY.name} — ${KEY.note}`), `the session shows "Key saved: ${KEY.name} — ${KEY.note}" (${t && t.text})`);
	check(t && t.inChat, 'the toast sits above the session\'s input');
	check(t && !t.text.includes(KEY.value), 'the toast has no value');
	check(has(), 'the agent\'s key is in the store');
	await ui.screenshot('01-agent-key-saved');
	await ui.mark({ css: '.dispatch-keys-toast' }, { what: 'Agent 存了 key：会话输入框上方的提示', where: '会话底部，输入框上面', how: 'Show 跳到设置 › Keys 那一行，Undo 撤回' });
	// Show while it is up (8 s, held under the pointer): Settings › Keys at its row; Undo there takes it out again
	const row = `.dispatch-settings-page .dset-key-row[data-key="${KEY.name}"]`;
	if (await toast()) {
		await ui.click({ css: '.dispatch-keys-toast [data-toast="show"]' });
		await ui.waitFor({ css: row }, { timeoutMs: 15000 });
		check(true, 'Show opens Settings › Keys at the agent\'s key');
		await ui.screenshot('02-show-row');
		await ui.click({ css: '.dispatch-keys-toast [data-toast="undo"]' });
		await ui.waitFor({ css: row }, { timeoutMs: 15000, gone: true });
		check(!has(), 'Undo takes the agent\'s key out of the store');
		await ui.screenshot('03-undone');
		await ui.press('Escape');
	} else {
		check(false, 'the toast was still up for Show and Undo');
	}
	await ui.waitFor({ css: '.interactive-item-container' }, { timeoutMs: 20000 });
	await replyDone(ui);
	const reply = await ui.eval(`(() => { const all = [...document.querySelectorAll('.interactive-item-container.interactive-response')]; return (all[all.length - 1]?.innerText || ''); })()`);
	facts.reply = reply.slice(0, 1200);
	check(!reply.includes(KEY.value) && !(await ui.eval(`document.body.innerText.includes(${JSON.stringify(KEY.value)})`)), 'the value is nowhere in the window, the reply included');
	await ui.screenshot('04-reply');
	save();
	if (facts.failed.length) {
		throw new Error(`${facts.failed.length} check(s) failed: ${facts.failed.join(' | ')}`);
	}
}
