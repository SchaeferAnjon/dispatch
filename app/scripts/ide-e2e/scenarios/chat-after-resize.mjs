const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
// The conversation stays on screen after the window changes size behind another page (task-0hk7): open a session
// that has messages, go to Waiting for you, make the window narrower and wider again, come back. The chat used to
// come back blank (every message measured at height 0 while hidden) until another session was opened. Also: in a
// narrow window the Waiting page's key hints end with a whole key, none cut off at the edge.
// It needs a session with messages: a new instance gets one first, a short OpenCode chat on the cheap test model.
export const meta = { needs: ['opencode'], timeout: 600, title: 'Chat after a resize', description: 'Resize the window behind Waiting for you; the conversation is still there when you come back.' };

const rows = `[...document.querySelectorAll('.part.sessionspart .interactive-list .monaco-list-rows')].filter(r => r.offsetParent).reduce((n, r) => n + r.childElementCount, 0)`;
const requestText = `([...document.querySelectorAll('.part.sessionspart .interactive-request')].find(e => e.offsetParent && e.getBoundingClientRect().height > 0) || { innerText: '' }).innerText.trim().slice(0, 80)`;

async function size(ui, w, h) {
  await ui.eval(`window.resizeTo(${w}, ${h})`);
  for (let i = 0; i < 20 && (await ui.eval('innerWidth')) > w; i++) await ui.sleep(250);
  await ui.sleep(1200);
}

async function until(ui, fn, what, ms = 20000) {
  for (const end = Date.now() + ms * SCALE; Date.now() < end; await ui.sleep(500)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`Timed out: ${what}`);
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await size(ui, 1440, 884);
  // a chat session (a terminal session has no messages to lose)
  const chatTitle = () => ui.eval(`([...document.querySelectorAll('.part.sidebar .monaco-list-row.session-list-inset-row')].map(r => r.innerText.split('\\n')[0].trim()).find(t => t && !/>_|Terminal|terminal/.test(t))) || ''`);
  let title = await chatTitle();
  if (!title) {
    // a conversation of its own: one short message to OpenCode on the instance's cheap model, as a person starts one
    await ui.newSession();
    await ui.pickEngine('OpenCode', 180000);
    await ui.click({ css: '.sessions-chat-editor' });
    await ui.type('Reply with the single word OK. Do not use any tools.');
    await ui.press('Enter', { send: true });
    await until(ui, async () => /\bOK\b/.test(await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`)), 'the answer to the first message', 240000);
    title = await until(ui, chatTitle, 'the conversation in the sidebar', 60000);
  }
  const session = { text: title, exact: true, within: '.part.sidebar' };
  await ui.click(session);
  const before = await until(ui, async () => (await ui.eval(rows)) > 0 && (await ui.eval(requestText)), 'the session shows its messages');

  // back at a width other than the one the chat had when it was covered: that is when it measured nothing
  for (const [w, h, stay] of [[1100, 800, true], [760, 800, false]]) {
    await ui.click({ text: 'Waiting for you', exact: true, within: '.part.sidebar' });
    await ui.waitFor({ css: '.part.customviewgridpart' }, { timeoutMs: 15000 });
    await size(ui, w, h);
    if (w === 760) {
      // the key hints end with a whole key: one that does not fit has gone to a hidden second line
      const cut = await ui.eval(`(() => { const k = document.querySelector('.dispatch-waiting-keys'); if (!k) return 'none'; const b = k.getBoundingClientRect();
        return [...k.querySelectorAll('.dispatch-waiting-key')].filter(e => { const r = e.getBoundingClientRect(); return r.top < b.bottom - 1 && r.right > b.right + 1; }).map(e => e.innerText.replace(/\\n/g, ' ')); })()`);
      if (cut !== 'none' && cut.length) throw new Error(`Key hints cut off at the edge: ${cut.join(', ')}`);
      await ui.screenshot('02-waiting-760');
    }
    if (!stay) await size(ui, 1440, 884);
    // the conversation by its title now: OpenCode names it a moment after the first answer, which may be after the
    // title read above
    await ui.click({ ...session, text: (await chatTitle()) || session.text });
    const back = await until(ui, async () => (await ui.eval(rows)) > 0 && (await ui.eval(requestText)), `the messages after the window went to ${w} px behind Waiting for you`, 15000);
    if (back !== before) throw new Error(`Another conversation came back: ${back} (was ${before})`);
  }
  await ui.screenshot('01-chat-after-resize');
  await ui.mark({ css: '.part.sessionspart .interactive-request' }, { what: '对话还在', where: '会话页中间', how: '在 Waiting for you 页改了窗口大小再回来，消息照常显示' });
}
