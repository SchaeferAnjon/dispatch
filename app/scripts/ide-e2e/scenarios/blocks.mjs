// Dispatch's block symbols and seven motions (Dispatch IDE patches/050-blocks.patch; design/identity/bold
// A4, A5): the side bar's entries in Dispatch's glyphs, the Symbols and Motion page with every glyph and each motion
// replayed, the same page with reduce motion on (all still), and a real session's row going from the falling blocks
// to the teal done block (OpenCode with GLM-5.3-Flash or DeepSeek's flash model only, never Claude; BLOCKS_NO_MODEL=1
// leaves the real session out). The Now tab and the input box have their own scenario (session-now.mjs).
export const meta = { instance: { motion: true }, needs: ['opencode'],
  title: "方块符号和七个动效",
  description: "左栏入口换成 Dispatch 的方块符号；命令面板 Show Dispatch Symbols and Motion 打开符号和动效页，每个动效能重放，减少动态效果时全部静止；会话行的状态是方块。",
};

import fs from "node:fs";
import path from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
async function showPage(ui) {
  // a page left open from before is shown afresh (its motions start over)
  if (await ui.eval(`!!document.querySelector('.dispatch-blocks-showcase')`)) { await ui.click("Waiting for you"); await ui.sleep(800); }
  await ui.press("F1");
  await ui.sleep(600);
  await ui.type("Show Dispatch Symbols and Motion");
  await ui.sleep(800);
  await ui.press("Enter");
  const t0 = Date.now();
  while (!(await ui.eval(`!!document.querySelector('.dispatch-blocks-showcase .dbs-glyph')`))) {
    assert(Date.now() - t0 < 20000, "the Symbols and Motion page did not open");
    await ui.sleep(250);
  }
  await ui.eval(`document.querySelector('.dispatch-blocks-showcase .dbs-group').scrollIntoView({ block: 'start' })`);
  await ui.sleep(600);
}

/** The running animation of each motion's moving part, read from the page. */
async function motionState(ui) {
  return ui.eval(`(() => {
    const q = (s) => document.querySelector('.dispatch-blocks-showcase ' + s);
    const anim = (el, pseudo) => el ? getComputedStyle(el, pseudo).animationName : 'missing';
    return {
      glyphs: document.querySelectorAll('.dispatch-blocks-showcase .dbs-glyph').length,
      glyphFont: getComputedStyle(q('.dbs-glyph .dbs-big'), '::before').fontFamily,
      done: anim(q('[data-motion=done] .dispatch-block .b')),
      working: anim(q('[data-motion=working] .dispatch-block.working .b')),
      stepNow: anim(q('[data-motion=working] .dispatch-block.step-now .pin')),
      phone: anim(q('[data-motion=phone] .dispatch-link > i')),
      thinking: anim(q('[data-motion=assistant] .dispatch-assistant-mark .slot')),
      handoffLine: anim(q('[data-motion=handoff] .dispatch-handoff-track > b')),
      reduce: !!document.querySelector('.monaco-workbench.monaco-reduce-motion'),
    };
  })()`);
}

/** The test window goes off-screen: it must not jump in front of the person (shared brief). */
async function offscreen(ui) {
  try {
    const { windowId } = await ui.cdp.send("Browser.getWindowForTarget", {});
    await ui.cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* no Browser domain on this page: leave it */ }
}

/** The Agents window on the demo project, no tips in the way (this instance's own settings). */
async function onDemo(ui) {
  // no tips in the way (this instance's own settings)
  const st = path.join(ui.rec.root || path.dirname(path.dirname(ui.demoFolder)), "agents-user-data", "User", "settings.json");
  if (fs.existsSync(st)) { const j = JSON.parse(fs.readFileSync(st, "utf8") || "{}"); j["dispatch.tips.enabled"] = false; fs.writeFileSync(st, JSON.stringify(j, null, 1)); await ui.sleep(1500); }
  // the window on the demo project (the person's own folders stay untouched): an editor window takes the request
  try { await ui.openAgents(ui.demoFolder); } catch (e) {
    if (!/editor window/.test(String(e && e.message))) throw e;
    await ui.click({ aria: "Editor" });
    await ui.sleep(8000);
    await ui.openAgents(ui.demoFolder);
  }
}

/** The new-session page on the demo project (the person's own folders stay untouched); returns the folder chip's text. */
async function toDemo(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
  const FOLDER = ".sessions-workspace-picker-trigger .action-label";
  const folderNow = async () => (await ui.eval(`document.querySelector('${FOLDER}')?.innerText.trim() || ''`)) || "";
  for (let i = 0; i < 3 && !/^demo\b/.test(await folderNow()); i++) {
    await ui.sleep(1500);
    for (let j = 0; j < 6 && await ui.exists({ css: ".dispatch-tour-close" }); j++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(500); }
    await ui.click({ css: FOLDER });
    await ui.sleep(1200);
    if (await ui.exists({ text: "demo", exact: true, within: ".action-widget" })) await ui.click({ text: "demo", exact: true, within: ".action-widget" });
    else await ui.press("Escape");
    await ui.sleep(1200);
  }
  const where = await folderNow();
  assert(/^demo\b/.test(where), "the new session is not in the demo project, refusing to send: " + where);
  return where;
}

// ---- the cheap model, picked the way a person does it: /model in the input box (as notify-sleep.mjs) ----
async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) { const v = await fn(); if (v) return v; await ui.sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
const MENU = ".dispatch-slash-menu";
const inputText = (ui, input) => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
const readMenu = (ui) => ui.eval(`(() => {
  const m = document.querySelector('${MENU}');
  if (!m) return null;
  const heads = [...m.querySelectorAll('.dsm-head')].map(h => ({ name: h.querySelector('.dsm-head-name')?.textContent }));
  const rows = [...m.querySelectorAll('.dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent, desc: r.querySelector('.dsm-desc')?.textContent || '', selected: r.classList.contains('selected') }));
  return { heads, rows };
})()`);
const waitMenu = (ui, check, what, timeoutMs = 15000) => until(ui, async () => { const m = await readMenu(ui); return m && !(await ui.exists({ css: `${MENU} .dsm-loading` })) && check(m) ? m : null; }, timeoutMs, `menu: ${what}`, 300);
/** The input box has the keyboard focus (a click right after a menu closes can land before the box is back). */
async function focusInput(ui, input) {
  const has = () => ui.eval(`!!document.activeElement?.closest('${input}')`);
  for (let i = 0; i < 6 && !(await has()); i++) {
    await ui.click({ css: `${input} .monaco-editor .view-lines` });
    await ui.sleep(500);
    if (!(await has())) await ui.eval(`document.querySelector('${input} .native-edit-context, ${input} textarea')?.focus()`);
  }
  if (!(await has())) throw new Error("the input box does not take the keyboard focus");
}
async function clearInput(ui, input) {
  await focusInput(ui, input);
  await ui.press("End");
  for (let i = 0; i < 200 && (await inputText(ui, input)).length; i++) await ui.press("Backspace");
}
/** GLM-5.3 Flash or DeepSeek's flash model (CLAUDE.md: cheap models only, never Claude), else a free OpenCode Zen one. */
async function chooseCheapModel(ui, input) {
  await clearInput(ui, input);
  await ui.type("/model");
  const models = await waitMenu(ui, m => m.heads.length === 1 && m.heads[0].name === "Model", "Model group", 30000);
  const row = ui.cheapModel(models.rows);
  if (!row) throw new Error(`no cheap test model (listed: ${models.rows.map(r => r.name + " / " + r.desc).slice(0, 30).join("; ")})`);
  await clearInput(ui, input);
  await ui.type(`/${row.name.replace(/\s+/g, "")}`);
  let choices = await waitMenu(ui, m => m.rows.some(r => r.name === row.name && r.desc === row.desc), row.name);
  for (let n = 0; n < choices.rows.length + 2 && !choices.rows.some(r => r.selected && r.name === row.name && r.desc === row.desc); n++) {
    await ui.press("ArrowDown");
    choices = await readMenu(ui);
  }
  await ui.press("Enter", { send: true });
  await ui.sleep(1500);
  await clearInput(ui, input);
  await ui.press("Escape");
  return row;
}

export default async function (ui) {
  await offscreen(ui);
  // on the demo project when the window can be pointed at it; an instance with only the Agents window stays where it is
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await offscreen(ui);
  for (let i = 0; i < 4 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
  await ui.sleep(1500);

  if (process.env.BLOCKS_ONLY_MODEL !== "1") {
  // 1. the side bar: entries in Dispatch's glyphs (the font, not codicon)
  const side = await ui.eval(`(() => {
    const out = {};
    for (const el of document.querySelectorAll('.agent-sessions-workbench .session-section-icon')) {
      const cls = [...el.classList].find(c => c.startsWith('codicon-'));
      if (cls) out[cls] = getComputedStyle(el, '::before').fontFamily;
    }
    return out;
  })()`);
  // Waiting for you keeps the codicon's thin bell (2026-11-11 direction A, task-0v1o9); the others are Dispatch's
  const theirs = Object.entries(side).filter(([c, f]) => /calendar|folder|comment-discussion/.test(c) && !/dispatch-blocks/.test(f));
  assert(Object.keys(side).length > 0, "no side bar entries found: " + JSON.stringify(side));
  assert(theirs.length === 0, "side bar entries still in codicon: " + JSON.stringify(theirs));
  await ui.screenshot("01-sidebar");
  if (await ui.exists({ text: "Waiting for you" })) await ui.mark({ text: "Waiting for you" }, { what: "Waiting for you 前面是琥珀色的等你方块", where: "左栏入口", how: "看一眼就知道是等你的事" });

  // 2. the page: every glyph, every motion moving
  await showPage(ui);
  const on = await motionState(ui);
  assert(on.glyphs >= 36, "glyphs on the page: " + on.glyphs);
  assert(/dispatch-blocks/.test(on.glyphFont), "the glyphs are not in Dispatch's font: " + on.glyphFont);
  for (const k of ["working", "stepNow", "phone", "thinking", "handoffLine"]) assert(on[k] && on[k] !== "none" && on[k] !== "missing", `${k} does not move: ${on[k]}`);
  await ui.screenshot("02-symbols");
  await ui.mark({ css: ".dispatch-blocks-showcase .dbs-glyphs", index: 0 }, { what: "Dispatch 自己的一套符号：状态、东西、设备、地方和动作", where: "命令面板 Show Dispatch Symbols and Motion 打开的页", how: "别的页面用 $(dispatch-<名字>)" });
  await ui.eval(`document.querySelector('.dispatch-blocks-showcase .dbs-cards').scrollIntoView({ block: 'start' })`);
  await ui.sleep(400);
  await ui.screenshot("02b-motion");
  // replay each one-off motion the way a person would: the Replay buttons
  // every animation that starts on the page is noted, so a 200ms one-off can be checked after the click
  await ui.eval(`(() => { window.__anims = []; document.querySelector('.dispatch-blocks-showcase').addEventListener('animationstart', e => window.__anims.push((e.target.closest('[data-motion]')?.dataset.motion || '') + ':' + e.animationName), true); })()`);
  for (const m of ["done", "waiting", "delivery", "handoff", "phone", "assistant"]) {
    await ui.eval(`document.querySelector('.dispatch-blocks-showcase [data-motion=${m}]').scrollIntoView({ block: 'center' })`);
    await ui.sleep(300);
    await ui.click({ text: "Replay", within: `.dispatch-blocks-showcase [data-motion=${m}]` });
    await ui.sleep(400);
    const started = await ui.eval(`window.__anims.splice(0)`);
    if (m === "phone" || m === "assistant") {
      // loops: Replay puts them back to connecting / thinking (a loop already running does not start again)
      const on = await ui.eval(`!!document.querySelector('.dispatch-blocks-showcase ${m === "phone" ? ".dispatch-link.connecting" : ".dispatch-assistant-mark.think"}')`);
      assert(on, `${m} is not ${m === "phone" ? "connecting" : "thinking"} after Replay`);
    } else {
      const want = { done: /fill/, waiting: /knock/, delivery: /drop/, handoff: /ring/ }[m];
      assert(started.some(x => x.startsWith(m + ":") && want.test(x)), `${m} did not play on Replay: ` + JSON.stringify(started));
    }
    if (m === "delivery") {
      const count = await ui.eval(`document.querySelector('.dispatch-blocks-showcase [data-motion=delivery] .dbs-count').textContent`);
      assert(count === "2", "the count did not tick up: " + count);
      await ui.screenshot("03-delivery-arrived");
    }
  }
  await ui.sleep(4000); // the phone joins, the Assistant settles
  const settled = await ui.eval(`({ phone: !!document.querySelector('.dispatch-blocks-showcase .dispatch-link.connected'), found: document.querySelector('.dispatch-blocks-showcase [data-motion=assistant] b')?.textContent })`);
  assert(settled.phone && /things wait for you|was delivered/.test(settled.found || ""), "phone or Assistant did not settle: " + JSON.stringify(settled));
  await ui.screenshot("04-settled");

  // 3. reduce motion (what accessibility.reduceMotion "on", or the Mac's setting, puts on the workbench): all still
  await ui.eval(`document.querySelector('.monaco-workbench').classList.add('monaco-reduce-motion')`);
  await ui.sleep(300);
  const still = await motionState(ui);
  for (const k of ["working", "stepNow", "phone", "thinking", "handoffLine"]) assert(still[k] === "none", `${k} still moves with reduce motion: ${still[k]}`);
  await ui.screenshot("05-reduce-motion");
  await ui.eval(`document.querySelector('.monaco-workbench').classList.remove('monaco-reduce-motion')`);

  }

  // 4. a real session's row: falling blocks while it works, a thin check in the done colour once it finished unread
  //    (2026-11-11 direction A, task-0v1o9: the teal block became the check)
  if (process.env.BLOCKS_NO_MODEL !== "1") {
    await ui.press("Escape");
    await onDemo(ui);
    await ui.newSession();
    const where = await toDemo(ui);
    await ui.pickEngine("OpenCode", 180000);
    await ui.sleep(1500);
    await chooseCheapModel(ui, ".sessions-chat-editor");
    await focusInput(ui, ".sessions-chat-editor");
    await ui.type("Count slowly from 1 to 40, one number per line, then write BLOCKS DONE. Do not use tools.");
    await ui.press("Enter", { send: true });
    await ui.waitFor({ css: ".sessions-list-control .dispatch-status-blocks.running" }, { timeoutMs: 60000 });
    await ui.screenshot("07-row-working");
    // leave the session for the new-session page, so its reply arrives unread
    await ui.newSession();
    // the session's group (demo, or Worktrees for a session in its own copy) is opened so its row shows
    for (const g of ["demo", "Worktrees"]) {
      const row = { text: g, exact: true, within: ".sessions-list-control" };
      if ((await ui.exists(row)) && await ui.eval(`[...document.querySelectorAll('.sessions-list-control .monaco-list-row')].some(r => r.innerText.trim() === ${JSON.stringify(g)} && r.getAttribute('aria-expanded') === 'false')`)) {
        await ui.click(row);
        await ui.sleep(500);
      }
    }
    const t0 = Date.now();
    while (!(await ui.exists({ css: ".sessions-list-control .dispatch-row-state.done" }))) {
      if (Date.now() - t0 > 240000) {
      const rows = await ui.eval(`[...document.querySelectorAll('.sessions-list-control .monaco-list-row')].slice(0, 12).map(r => r.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) + ' [' + [...r.querySelectorAll('.dispatch-status-blocks, .dispatch-block, .dispatch-status-dot')].map(e => e.className).join(' | ') + ']')`);
      throw new Error("the row never turned into the done block: " + JSON.stringify(rows));
    }
      await ui.sleep(250);
    }
    const check = await ui.eval(`(() => { const e = document.querySelector('.sessions-list-control .dispatch-row-state.done'); const i = e.querySelector('.codicon-pass-filled.dispatch-mark'); const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), size: getComputedStyle(i).fontSize, colour: getComputedStyle(i).color, token: getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--dispatch-state-done').trim() }; })()`);
    await ui.screenshot("08-row-done");
    await ui.mark({ css: ".sessions-list-control .dispatch-row-state.done" }, { what: "会话做完、回复还没看：14px 实心圆勾（VS Code 的 pass-filled）", where: "左栏会话行最前面", how: "点开读了以后对勾消失" });
    assert(check.w === 14 && check.h === 14 && check.size === '14px', "the done check is a 14px mark: " + JSON.stringify(check));
    // read: the block goes, the row is plain again
    await ui.click({ css: ".sessions-list-control .dispatch-row-state.done" });
    const t1 = Date.now();
    while (await ui.exists({ css: ".sessions-list-control .dispatch-row-state.done" })) {
      assert(Date.now() - t1 < 20000, "the done check stayed after the session was opened");
      await ui.sleep(250);
    }
  }
}
