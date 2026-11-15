// OpenCode with a new enough copy (1.18+): no version notice above the input, a real message gets an answer.
// The instance starts with the PATH an app opened from the Dock has (meta.instance.env): Dispatch finds OpenCode in
// its usual folders by itself (~/.opencode/bin, ~/.bun/bin, Homebrew), whichever copy is new enough.
// Test model: OpenCode's cheap one (DeepSeek V4.1 Flash, GLM Flash or a free Flash), no Claude session.
import { writeFileSync } from 'node:fs';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { needs: ['opencode'], instance: { env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' } }, title: 'OpenCode version gate: new enough copy answers', description: 'No notice above the input; one message to the cheap test model gets a reply.' };
const fresh = '.sessions-chat-editor';
const picker = '.sessions-chat-session-type-picker';

async function until(ui, fn, what, ms = 120000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(1000);
  }
  throw new Error(`Timed out: ${what}`);
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('OpenCode');
  await ui.sleep(4000);
  const notice = await ui.eval(`document.querySelectorAll('.chat-input-notification-title').length`);
  await ui.click({ css: fresh });
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent, desc:r.querySelector('.dsm-desc')?.textContent}))`);
    return ui.cheapModel(rows);
  }, 'test model', 45000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  await ui.screenshot('01-new-session-no-notice');
  await ui.click({ css: fresh });
  await ui.type('Reply with the single word PONG and nothing else. Do not use tools.');
  await ui.press('Enter', { send: true });
  const text = await until(ui, async () => {
    const t = await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`);
    if (/401|unauthori[sz]ed/i.test(t)) throw new Error(`Got an auth error: ${t.slice(0, 200)}`);
    return /PONG/i.test(t) && t;
  }, 'the answer', 180000);
  await ui.screenshot('02-answer');
  writeFileSync(`${ui.out}/result-ok.json`, JSON.stringify({ noticesBeforeSend: notice, answer: text.slice(0, 200) }, null, 2));
  if (notice !== 0) throw new Error('A version notice showed for a new enough OpenCode');
}
