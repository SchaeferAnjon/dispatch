// VS Code's square-ish corners (user 2026-11-16, task-n1o60, DESIGN.md「尺寸」圆角): the input box, the user's bubble,
// buttons and cards take VS Code's small radii, no big rounded capsules. A real OpenCode session on the instance's cheap
// model answers once; the new-session page, the conversation (bubble and input), the side pane's Now tab, the model
// menu, Waiting for you, Settings and its Abilities page are shot in light, the conversation also in dark. On every
// screen each element drawn rounder than the largest token (12) is listed, unless it is a circle (as wide as high,
// a radius of half or more), into radii.json; known elements' corners are read too.
export const meta = { needs: ['opencode'], timeout: 900, title: "方圆角：输入框、气泡、按钮、卡片",
  description: "新会话页、对话（气泡和输入框）、右栏 Now、模型菜单、Waiting for you、设置和 Abilities 各截一张，读每个元素的圆角：除了圆，没有比 token 最大值 12 更圆的。" };

import fs from "node:fs";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const MAX = 12;
const ASK = "Reply with one short sentence saying hello. Do not use any tools.";

/** Elements on screen rounder than MAX that are not circles, and the corners of the ones named here. */
const READ = `(() => {
  const named = {
    input: '.session-view .interactive-input-part .chat-input-container',
    newInput: '.new-chat-input-area',
    bubble: '.interactive-item-container.interactive-request .value .rendered-markdown',
    send: '.interactive-input-part .chat-submit-button .action-label, .sessions-chat-send-button .monaco-button',
    picker: '.interactive-input-part .chat-input-toolbars .chat-input-picker-item .action-label, .sessions-chat-config-toolbar .action-label',
    folderChip: '.sessions-chat-picker-slot.sessions-workspace-category-picker-slot .action-label',
    sessionRow: '.sessions-list-control .monaco-list-row',
    card: '.agents-part-card',
    nowButton: '.dispatch-now-btn',
    button: '.monaco-button',
    menu: '.action-widget, .monaco-menu-container',
  };
  const shown = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  // the corners you see: a background drawn inside the padding (content-box) loses the padding beside each corner,
  // across and down; a corner is [across, down]
  const seen = e => {
    const cs = getComputedStyle(e); const inner = cs.backgroundClip === 'content-box';
    const pad = k => inner ? parseFloat(cs['padding' + k]) || 0 : 0;
    const corner = (prop, x, y) => { const [h, v = h] = cs[prop].split(' ').map(parseFloat); return [Math.max(0, h - pad(x)), Math.max(0, v - pad(y))]; };
    return [corner('borderTopLeftRadius', 'Left', 'Top'), corner('borderTopRightRadius', 'Right', 'Top'), corner('borderBottomRightRadius', 'Right', 'Bottom'), corner('borderBottomLeftRadius', 'Left', 'Bottom')];
  };
  const radius = e => Math.max(...seen(e).flat());
  const out = { named: {}, rounder: [] };
  for (const [k, sel] of Object.entries(named)) {
    const e = [...document.querySelectorAll(sel)].find(shown);
    if (e) out.named[k] = seen(e).map(c => c[0] === c[1] ? c[0] : c.join('/')).join(' ');
  }
  // every session row on screen, as you see its corners
  out.sessionRows = [...new Set([...document.querySelectorAll('.sessions-list-control .monaco-list-row')].filter(shown).map(e => seen(e).map(c => c.join('/')).join(' ')))];
  for (const e of document.querySelectorAll('body *')) {
    const r = radius(e);
    if (r <= ${MAX} || !shown(e)) continue;
    const b = e.getBoundingClientRect();
    const circle = Math.abs(b.width - b.height) <= 1 && r >= Math.min(b.width, b.height) / 2 - 0.5;
    // a radius larger than half the box draws the same as half: a 4 high line with 999 is a bar, not a capsule
    const tiny = Math.min(b.width, b.height) <= 2 * ${MAX} && r >= Math.min(b.width, b.height) / 2 && Math.min(b.width, b.height) <= 8;
    if (circle || tiny) continue;
    out.rounder.push({ cls: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).slice(0, 90), tag: e.tagName.toLowerCase(), r: getComputedStyle(e).borderRadius, w: Math.round(b.width), h: Math.round(b.height) });
  }
  return out;
})()`;

export default async function (ui) {
  const qa = { screens: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "radii.json"), JSON.stringify(qa, null, 2));
  const shot = async (name) => {
    await ui.sleep(900);
    await ui.screenshot(name);
    qa.screens[name] = await ui.eval(READ);
    const rows = qa.screens[name].sessionRows || [];
    console.error(`${name}: ${JSON.stringify(qa.screens[name].named)} rounder than ${MAX}: ${qa.screens[name].rounder.length}; session rows' corners: ${rows.join(' | ')}`);
    if (rows.some(r => r !== '6/6 6/6 6/6 6/6')) throw new Error(`${name}: a session row's corners are not 6 all round: ${rows.join(' | ')}`);
    if (qa.screens[name].rounder.length) throw new Error(`${name}: rounder than ${MAX}: ${JSON.stringify(qa.screens[name].rounder)}`);
    note();
  };
  const RUNNING = `!!document.querySelector('.session-view .interactive-input-part .chat-execute-toolbar .codicon-stop-circle')`;
  const lastReply = () => ui.eval(`(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`);

  await offscreen(ui);
  await onDemo(ui);
  await closeTips(ui);
  await ui.setTheme("light");

  // the new-session page: the folder and engine chips, the box, its pickers and the send key
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  qa.model = await chooseCheapModel(ui, ".sessions-chat-editor");
  await closeTips(ui);
  await shot("01-new-session");

  // a real turn: the bubble, the reply, the input box of a running session
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(ASK);
  await ui.press("Enter", { send: true });
  await until(ui, () => ui.eval(RUNNING), 90000, "the turn to start", 500).catch(() => {});
  await until(ui, async () => !(await ui.eval(RUNNING)) && (await lastReply()).length > 0, 300000, "the answer", 1500);
  await closeTips(ui);
  await shot("02-conversation");

  // the side pane's Now tab
  await ui.openNowTab();
  await shot("03-now");

  // the model menu above the input (a popover)
  if (await ui.exists({ css: ".session-view .interactive-input-part .model-picker-split" })) {
    await ui.click({ css: ".session-view .interactive-input-part .model-picker-split" });
    await ui.sleep(900);
    await shot("04-model-menu");
    await ui.press("Escape");
  }

  // dark: the conversation again
  await ui.setTheme("dark");
  await shot("05-conversation-dark");
  await ui.setTheme("light");

  // Waiting for you, the whole page
  await ui.click({ css: ".session-section.dispatch-waiting-section" });
  await ui.waitFor({ css: ".dispatch-waiting-page" }, { timeoutMs: 20000 });
  await shot("06-waiting");

  // Settings and its Abilities page (switches, engine chips, cards)
  await ui.press("Cmd+,");
  await ui.sleep(1500);
  await shot("07-settings");
  await ui.openCustomizations("Overview");
  await shot("08-abilities");
}
