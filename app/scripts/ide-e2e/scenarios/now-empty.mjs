// A new chat's side pane (user 2026-10-10: "if Now has nothing, don't show it for now"): before the first message
// there is no Now tab and no narrow column with "Nothing here yet" one word a line; the pane says what it is for
// across its whole width. After the first message Now joins without the pane moving. In a 750 px window nothing
// is wider than the window (the scroll bar along the bottom was the grid: sessions list 170 + conversation 300 +
// side pane 300 > 750), and no text in the side pane is squeezed narrower than 160 px.
// One short message to OpenCode's cheap test model.
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  title: 'Now 为空时不显示',
  description: '新会话发消息前右栏没有 Now 标签、整栏一个干净的空状态；发消息后 Now 出现且右栏不跳；750 px 宽窗口下页面不横向滚动，右栏没有被挤成一列的文字。',
  needs: ['opencode'],
  timeout: 900,
};

const READ = `(() => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const editor = document.getElementById('workbench.parts.editor');
  const shown = e => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
  const pane = shown(editor) ? box(editor) : null;
  const aux = document.getElementById('workbench.parts.auxiliarybar');
  const tabs = [...document.querySelectorAll('.part.editor .tabs-container .tab')].map(t => t.getAttribute('aria-label'));
  // what the side pane says, in words a person reads (leaves on screen, not covered)
  const seen = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.x < innerWidth && e.checkVisibility({ opacityProperty: true, visibilityProperty: true }); };
  const leaves = pane ? [...editor.querySelectorAll('*')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && seen(e)) : [];
  const text = leaves.map(e => e.textContent.trim()).join(' ').replace(/\\s+/g, ' ').slice(0, 240);
  // text squeezed into a column: narrower than 160 px and more than one line
  const squeezed = leaves.filter(e => { const r = e.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(e).lineHeight) || 18; return r.width < 160 && r.height > lh * 1.6; }).map(e => ({ t: e.textContent.trim().slice(0, 40), ...box(e) }));
  // anything of the window's own layout wider than the window
  const wider = [...document.querySelectorAll('.monaco-grid-view, .monaco-split-view2, .split-view-view, .part')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1; }).map(e => ({ cls: String(e.className).slice(0, 50), ...box(e) }));
  const se = document.scrollingElement;
  return { win: innerWidth, page: [se.scrollWidth, se.clientWidth], pane, aux: shown(aux) ? box(aux) : null, tabs, text, squeezed, wider,
    sidebar: shown(document.getElementById('workbench.parts.sidebar')) };
})()`;

export default async function (ui) {
  const qa = { checks: [], failed: [], steps: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    note();
  };
  const read = async (step) => { const s = { step, ...(await ui.eval(READ)) }; qa.steps.push(s); note(); return s; };
  const width = async (w) => { await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 882, deviceScaleFactor: 0, mobile: false }); await ui.sleep(1500); };

  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await ui.closeOverlays();
  // a new chat (no folder), the way a person starts one: the + on the side bar's Chats row
  // the rows under Waiting for you come in a moment after the window opens and push the list down a row: the pointer
  // goes on the Chats row again until its + is there
  for (let i = 0; i < 6; i++) {
    await ui.hover({ text: 'Chats', exact: true, within: '.part.sidebar', webview: false });
    await ui.sleep(500);
    if (await ui.exists({ aria: 'New Quick Chat', exact: true, within: '.part.sidebar', webview: false })) break;
    await ui.sleep(1000);
  }
  await ui.click({ aria: 'New Quick Chat', exact: true, within: '.part.sidebar', webview: false });
  await ui.waitFor({ css: '.sessions-chat-session-type-picker' }, { timeoutMs: 30000 });
  await ui.sleep(1500);
  if (await ui.exists({ aria: 'Show side panel', webview: false })) {
    await ui.click({ aria: 'Show side panel', webview: false });
    await ui.sleep(1500);
  }

  for (const w of [1440, 750]) {
    await width(w);
    const s = await read(`before-${w}`);
    check(`${w} px, before the first message: no Now tab`, !s.tabs.includes('Now'), s.tabs);
    check(`${w} px, before the first message: the open side pane says something`, !!s.pane && s.text.length > 10, { text: s.text });
    check(`${w} px: no text in the side pane squeezed under 160 px`, !s.squeezed.length, s.squeezed);
    check(`${w} px: the page does not scroll sideways (scrollWidth ${s.page[0]} <= clientWidth ${s.page[1]})`, s.page[0] <= s.page[1] && !s.wider.length, { page: s.page, wider: s.wider });
    await ui.screenshot(`now-empty-${w}-before`);
  }

  // the first message, at 1440: Now joins, the pane stays where it was
  await width(1440);
  const before = await read('before-send');
  await ui.pickEngine('OpenCode', 240000);
  await ui.pickCheapModel();
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.type('Reply exactly NOWTAB. Do not use any tools.');
  await ui.press('Enter', { send: true });
  await ui.waitFor({ text: 'NOWTAB', within: '.interactive-response' }, { timeoutMs: 360000 });
  let after;
  for (let i = 0; i < 20; i++) { after = await read('after-send'); if (after.tabs.includes('Now')) break; await ui.sleep(500); }
  check('after the first message: the Now tab is there', after.tabs.includes('Now'), after.tabs);
  check('after the first message: the side pane did not move', !!before.pane && !!after.pane && before.pane.x === after.pane.x && before.pane.w === after.pane.w, { before: before.pane, after: after.pane });
  // the Now it shows is direction A's (2026-11-11): three lines on the panel, no card; a chat has no Changes to see
  let head = null;
  for (let i = 0; i < 40 && !(head && head.mode === 'done'); i++) {
    head = await ui.eval(`(() => { const n = document.querySelector('.dispatch-now-tab'); const h = n && n.querySelector('[data-part="now-head"]'); return h ? { mode: h.dataset.mode, status: h.querySelector('.dispatch-now-status')?.textContent || '', say: h.querySelector('.dispatch-now-say')?.textContent || '', buttons: [...h.querySelectorAll('.dispatch-now-btn')].map(b => b.textContent), card: !!n.querySelector('.dispatch-now-card') } : null; })()`);
    if (!(head && head.mode === 'done')) await ui.sleep(500);
  }
  qa.now = head;
  check('after the first message: Now is three lines, no card, Done', !!head && head.mode === 'done' && /^Done/.test(head.status) && !!head.say && !head.card, head);
  check('after the first message: a chat without a folder offers no See changes', !!head && !head.buttons.includes('See changes'), head && head.buttons);
  await ui.screenshot('now-empty-1440-after');
  await width(750);
  const narrow = await read('after-750');
  check('750 px after the first message: no sideways scrolling, nothing squeezed', narrow.page[0] <= narrow.page[1] && !narrow.wider.length && !narrow.squeezed.length, { page: narrow.page, wider: narrow.wider, squeezed: narrow.squeezed });
  await ui.screenshot('now-empty-750-after');
  await ui.cdp.send('Emulation.clearDeviceMetricsOverride', {});

  note();
  if (qa.failed.length) throw new Error(`failed: ${qa.failed.join('; ')}`);
}
