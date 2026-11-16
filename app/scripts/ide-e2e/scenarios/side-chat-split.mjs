// The line between the side pane's tab and the side chat (direction B「Split pane」, user 2026-11-16, task-5im8n,
// design/side-chat-now), worked with a real mouse through Playwright (connectOverCDP to the instance), in the
// person's own window width (756 × 892, the width of b-756.png) and in a wide one. A real session answers once; a side
// chat is asked on a passage and answers at length; the Now tab is put in front over it. Then: the pointer on the line
// lights it after VS Code's sash delay; dragging it up and down moves it (the heights read from the page); dragged to
// the top, 32 stay over it and Now is one line, whose click puts the line back; dragged to the bottom the pane keeps
// 200; a double-click puts it back; the place dragged to stays when the pane is folded and opened, and when the
// window is made wide; a click on the pane's head folds it to the head and opens it again; the side chat scrolled down,
// the question is pinned as one quiet line, whose click scrolls back to it. Pictures in light and dark at 756.
//
// Codex on the cheap test model, as side-chat-pane.mjs (which shares its setup) says.
export const meta = { needs: ['codex'], instance: { motion: true },
  title: "旁聊和 Now 上下分栏：拖线、双击、收起、钉住那行",
  description: "756 × 892 窗口（和你的截图同宽）：Now 在上、旁聊在下；用 Playwright 真鼠标拖中间那条线，读页面高度核对：拖上拖下跟着走，拖到顶上面留 32、Now 收成一行，点那一行回默认；拖到底下格留 200；双击回默认；拖过的位置收起再展开、窗口变宽后还在；点格头收起展开；旁聊往下滚后你那句问话收成顶上一行，点它滚回去。浅色深色各截图。",
  timeout: 2400,
};

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { until, focusInput } from "./session-now.mjs";
import { PANE, STATE, ROWS_SHOWN, checker, prepare, askOnBlock, defaultPane } from "./side-chat-pane.mjs";

const QUESTION = "Write exactly 30 numbered lines, each a short sentence of advice for finishing this passage's work. Do not use any tools.";
const FOLLOW = "Now give the three most important ones, one line each. Do not use any tools.";

/** Playwright, from the global install (npm root -g) or PLAYWRIGHT_DIR; the e2e runner itself does not ship it. */
function playwright() {
  const dirs = [process.env.PLAYWRIGHT_DIR, (() => { try { return path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 20000 }).trim(), "playwright"); } catch { return undefined; } })(), "/opt/homebrew/lib/node_modules/playwright"].filter(Boolean);
  for (const d of dirs) {
    try {
      return createRequire(path.join(d, "package.json"))(d);
    } catch { /* the next place */ }
  }
  return undefined;
}

export default async function (ui) {
  const { qa, check } = checker(ui);
  const resize = async (width, height) => {
    let real = false;
    try {
      const { windowId } = await ui.cdp.send("Browser.getWindowForTarget");
      await ui.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await ui.cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
      await ui.sleep(1500);
      real = (await ui.eval("innerWidth")) === width;
    } catch { /* not in this Electron */ }
    if (!real) {
      await ui.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
      await ui.eval("window.dispatchEvent(new Event('resize'))");
    }
    (qa.states.sizedBy ??= []).push(`${width}: ${real ? "window" : "emulation"}`);
    // the columns settle at the new width (dispatchColumnsKeeper.ts) a moment after the window changes
    await ui.sleep(3500);
  };
  const read = () => ui.eval(STATE);
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
  const pw = playwright();
  if (!pw) ui.skip("Playwright is not installed (npm i -g playwright, or set PLAYWRIGHT_DIR)");

  // ---- a session, a side chat with a long answer, Now over it ----
  const BODY = await prepare(ui, qa);
  await askOnBlock(ui, BODY, "Folio Reader 迁到本机", QUESTION);
  await ui.waitFor({ css: `${PANE}:not(.hidden)` }, { timeoutMs: 30000 });
  await until(ui, async () => (await read()).acts, 300000, "the side chat's long answer", 1500);
  await ui.openNowTab();
  await ui.sleep(1200);

  // ---- Playwright on the same window ----
  const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${ui.port}`);
  let page;
  for (const p of browser.contexts().flatMap(c => c.pages())) {
    if (await p.evaluate(() => !!document.querySelector(".agent-sessions-workbench .dispatch-side-chat-pane")).catch(() => false)) {
      page = p;
      break;
    }
  }
  check("Playwright reaches the Agents window over CDP", !!page);
  if (!page) throw new Error("no Agents window with the side chat for Playwright");
  const sashAt = async () => { const s = await read(); return { x: s.sash.box.x + s.sash.box.w / 2, y: s.sash.box.y + s.sash.box.h / 2, s }; };
  /** Drags the line by dy with the mouse, in steps, as a hand does. */
  const drag = async dy => {
    const { x, y } = await sashAt();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy / 2, { steps: 6 });
    await page.mouse.move(x, y + dy, { steps: 6 });
    await page.mouse.up();
    await ui.sleep(400);
    return read();
  };

  try {
    // the window made 756 × 892 for real when this Electron lets CDP size it, else the page is emulated at that size
    await resize(756, 892);
    const start = qa.states.start = await read();
    const room = start.top + start.pane.h;
    check("756 wide: Now over the side chat, both whole; the pane at its default (58% of the room, 420 at most, and its line)", start.window === 756 && !!start.now && start.now.shown && !start.now.oneLine && near(start.pane.h, defaultPane(room, 756), 1) && near(start.editor.b, start.pane.y, 2), { pane: start.pane, room, now: start.now, editor: start.editor });
    qa.states.startRows = await ui.eval(ROWS_SHOWN);
    await ui.screenshot("b-756");
    await ui.mark({ css: PANE }, { what: "Now 在上、旁聊在下，谁也不盖谁", where: "右栏", how: "拖中间那条线调高低" });

    // the pointer on the line: VS Code's sash lights it after its delay
    const { x, y } = await sashAt();
    await page.mouse.move(x, y);
    await ui.sleep(700);
    const lit = qa.states.sashHover = await page.evaluate(sel => { const s = document.querySelector(sel + " > .monaco-sash"); return { cls: s.className, cursor: getComputedStyle(s).cursor, before: getComputedStyle(s, "::before").backgroundColor }; }, PANE);
    check("the pointer on the line: a resize cursor, lit after the sash's delay", /hover/.test(lit.cls) && /resize/.test(lit.cursor), lit);

    // dragged up 150: the line follows the hand, Now gets shorter by as much, nothing overlaps
    const up = qa.states.up = await drag(-150);
    check("dragged up 150: the line moves 150 (the pane 150 taller, Now 150 shorter)", near(up.pane.y, start.pane.y - 150, 2) && near(up.pane.h, start.pane.h + 150, 2) && near(up.editor.b, up.pane.y, 2), { before: start.pane, after: up.pane, editor: up.editor });
    // and down 80 again
    const down = qa.states.down = await drag(80);
    check("dragged down 80: the line moves 80", near(down.pane.y, up.pane.y + 80, 2), { before: up.pane, after: down.pane });

    // to the very top: 32 stay over it and Now is one line
    const top = qa.states.top = await drag(-2000);
    const nowLine = qa.states.nowLine = await page.evaluate(() => { const n = document.querySelector(".dispatch-now-tab"); const t = n && n.querySelector(".dispatch-now-top"); const say = n && n.querySelector(".dispatch-now-say"); const c = n && n.querySelector(".dispatch-now-count"); return n ? { oneLine: n.classList.contains("one-line"), h: Math.round(n.getBoundingClientRect().height), row: t ? Math.round(t.getBoundingClientRect().height) : 0, sayOneLine: say ? say.scrollHeight <= 34 : false, sayCut: say ? getComputedStyle(say).textOverflow : "", count: c && c.getClientRects().length ? c.textContent : null, title: n.title } : null; });
    check("dragged to the top: 32 stay over the line", top.top === 32 && near(top.pane.y - top.tabs.b, 32, 3), { top: top.top, pane: top.pane, tabs: top.tabs });
    check("Now is one line there: 32 high, the agent's line cut to one, the whole line on the pointer", !!nowLine && nowLine.oneLine && nowLine.row === 32 && nowLine.sayOneLine && nowLine.sayCut === "ellipsis" && nowLine.title.length > 0, nowLine);
    await ui.screenshot("b-756-tall");
    await ui.mark({ css: ".dispatch-now-tab" }, { what: "线拖到顶：Now 收成一行摘要", where: "页签下面", how: "点这一行回到默认分栏" });

    // its click puts the line back where it starts
    const line = await page.evaluate(() => { const b = document.querySelector(".dispatch-now-tab .dispatch-now-top").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.click(line.x, line.y);
    await ui.sleep(500);
    const reset = qa.states.reset = await read();
    check("a click on Now's one line: back to the default split, Now whole again", near(reset.pane.h, start.pane.h, 1) && !!reset.now && !reset.now.oneLine, { pane: reset.pane, start: start.pane, now: reset.now });

    // to the very bottom: the pane keeps 200 under its line
    const bottom = qa.states.bottom = await drag(2000);
    check("dragged to the bottom: the pane keeps 200 under its line", bottom.pane.h === 201, bottom.pane);

    // a double-click puts it back
    const at = await sashAt();
    await page.mouse.dblclick(at.x, at.y);
    await ui.sleep(500);
    const dbl = qa.states.dbl = await read();
    check("a double-click on the line: back to the default split", near(dbl.pane.h, start.pane.h, 1), { pane: dbl.pane, start: start.pane });

    // dragged somewhere, the place stays when the pane is folded and opened again
    const placed = qa.states.placed = await drag(-100);
    const head = async () => page.evaluate(sel => { const b = document.querySelector(sel + " .dsc-head .dsc-t").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, PANE);
    let h = await head();
    await page.mouse.click(h.x, h.y);
    await ui.sleep(500);
    const fold = qa.states.fold = await read();
    check("a click on the head folds the pane: the head and its line at the bottom, Now has the room", fold.folded && fold.pane.h === 29 && near(fold.pane.b, fold.group.b) && near(fold.editor.b, fold.pane.y, 2) && !!fold.now && !fold.now.oneLine, { pane: fold.pane, editor: fold.editor });
    // a follow-up while folded: the head says it is answering, then that an answer came (the head is at the bottom now)
    h = await head();
    await page.mouse.click(h.x, h.y);
    await ui.sleep(500);
    await focusInput(ui, `${PANE} .interactive-input-part`);
    await ui.type(FOLLOW);
    await ui.press("Enter", { send: true });
    await ui.sleep(300);
    h = await head();
    await page.mouse.click(h.x, h.y);
    await until(ui, async () => { const s = await read(); return s.badge && /new answer/.test(s.badge.text); }, 300000, "the follow-up's answer, while folded", 800);
    const unread = qa.states.unread = await read();
    check("folded while it answered: the head says · 1 new answer in 500", unread.badge.text === "· 1 new answer" && Number(unread.badge.weight) === 500, unread.badge);
    await ui.screenshot("b-756-collapsed");
    await ui.mark({ css: `${PANE} .dsc-head` }, { what: "收起下格：右栏底部只剩格头，写 1 new answer", where: "右栏最下面", how: "点它展开" });
    h = await head();
    await page.mouse.click(h.x, h.y);
    await ui.sleep(700);
    const unfold = qa.states.unfold = await read();
    check("opened again: the line is where it was dragged to", near(unfold.pane.h, placed.pane.h, 1), { pane: unfold.pane, placed: placed.pane });

    // the question pinned as one line once the side chat is scrolled down; its click scrolls back to it
    const scrollable = `${PANE} .interactive-list .monaco-scrollable-element`;
    const list = await page.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, scrollable);
    await page.mouse.move(list.x, list.y);
    // up to the first question with the wheel, then down a little at a time until it has gone above
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, -400);
      await ui.sleep(60);
    }
    await ui.sleep(500);
    const PIN = `(() => { const pane = document.querySelector('${PANE}'); const list = pane.querySelector('.interactive-list'); const L = list.getBoundingClientRect(); const row = pane.querySelector('.monaco-tree-sticky-row.dispatch-sticky-ask'); const item = row && row.querySelector('.interactive-item-container.interactive-request'); const shown = !!item && !row.classList.contains('source-node-partially-visible') && getComputedStyle(item).visibility !== 'hidden' && Number(getComputedStyle(item).opacity) > 0.5; const first = [...pane.querySelectorAll('.monaco-list-row:not(.monaco-tree-sticky-row) .interactive-request')][0]; const fb = first && first.getBoundingClientRect(); return { pinned: shown, h: item ? Math.round(item.getBoundingClientRect().height) : 0, top: item ? Math.round(item.getBoundingClientRect().top - L.top) : null, text: item ? item.innerText.replace(/\\s+/g, ' ').trim() : '', oneLine: item ? item.querySelector('.rendered-markdown').scrollHeight <= 22 : false, firstInView: !!fb && fb.top >= L.top - 1 && fb.bottom <= L.bottom + 1, scrollTop: -parseFloat(list.querySelector('.monaco-list-rows').style.top || '0'), rule: (() => { const c = row && row.closest('.monaco-tree-sticky-container'); const P = pane.getBoundingClientRect(); return c ? { l: Math.round(c.getBoundingClientRect().left - P.left), w: Math.round(c.getBoundingClientRect().width), pane: Math.round(P.width) } : null; })(), arrow: item ? getComputedStyle(item, '::after').content === '"↑"' && parseFloat(getComputedStyle(item).paddingRight) >= 19 && Math.round(item.querySelector('.value').getBoundingClientRect().right) <= Math.round(pane.getBoundingClientRect().right) - 20 - 8 : false, widths: item ? [row, ...['.monaco-tl-row', '.monaco-tl-contents', '.interactive-item-container', '.value', '.rendered-markdown', '.rendered-markdown > p'].map(q => row.querySelector(q))].map(e => e ? Math.round(e.getBoundingClientRect().width) + '/' + (e.style.width || '') + '/' + getComputedStyle(e).display : '-') : null, cut: item ? (p => !!p && getComputedStyle(p).textOverflow === 'ellipsis' && p.scrollWidth > p.clientWidth)(item.querySelector('.rendered-markdown > p')) : false }; function P2(e) { return e.getBoundingClientRect(); } })()`;
    qa.states.atTop = await ui.eval(PIN);
    check("wheeled to the top: the question is in view, nothing pinned", qa.states.atTop.firstInView && !qa.states.atTop.pinned, qa.states.atTop);
    for (let i = 0; i < 30 && (await ui.eval(PIN)).firstInView; i++) {
      await page.mouse.wheel(0, 40);
      await ui.sleep(120);
    }
    await page.mouse.wheel(0, 80);
    await ui.sleep(600);
    const pinned = qa.states.pinned = await ui.eval(PIN);
    check("scrolled down, the question is pinned as one line 28 high at the top of the side chat", pinned.pinned && pinned.h === 28 && near(pinned.top, 0, 1) && pinned.oneLine && pinned.text.startsWith("Write exactly 30") && !pinned.firstInView, pinned);
    check("the pinned line's rule runs edge to edge; its words are cut with … and its ↑ stays inside, 20 from the edge", !!pinned.rule && pinned.rule.l === 0 && pinned.rule.w === pinned.rule.pane && pinned.cut && pinned.arrow, pinned);
    // whatever is drawn in the messages' left margin (the design has nothing there)
    qa.states.gutter = await ui.eval(`(() => { const pane = document.querySelector('${PANE}'); const L = pane.querySelector('.interactive-list').getBoundingClientRect(); const P = pane.getBoundingClientRect(); const seen = new Set(); for (let y = L.top + 30; y < L.bottom - 4; y += 3) for (const x of [P.left + 10, P.left + 16, P.left + 19]) { const e = document.elementFromPoint(x, y); if (e && !/monaco-list-row|monaco-tl|interactive-item-container|monaco-list-rows|monaco-scrollable|rendered-markdown|^value|chat-markdown-part|monaco-tree-sticky/.test(String(e.className))) seen.add(e.tagName + '.' + String(e.className).slice(0, 80) + ' < ' + String(e.parentElement && e.parentElement.className).slice(0, 60)); } return [...seen].slice(0, 12); })()`);
    await ui.screenshot("b-756-pinned");
    await ui.mark({ css: `${PANE} .monaco-tree-sticky-row.dispatch-sticky-ask` }, { what: "旁聊里你那句问话收成顶上一行", where: "下格消息顶上", how: "点它滚回那句话" });
    const pinBox = await page.evaluate(sel => { const b = document.querySelector(sel + " .monaco-tree-sticky-row.dispatch-sticky-ask .interactive-request").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, PANE);
    await page.mouse.click(pinBox.x, pinBox.y);
    await ui.sleep(900);
    const back = qa.states.pinBack = await ui.eval(PIN);
    check("a click on the pinned line scrolls back to the question: its bubble in view, nothing pinned", back.firstInView && !back.pinned && back.scrollTop < pinned.scrollTop, back);

    // dark, at the person's width
    await ui.setTheme("dark");
    await ui.sleep(900);
    await page.mouse.move(5, 5);
    const darkS = qa.states.dark = await read();
    check("dark: the pane where it was", !!darkS.pane && near(darkS.pane.h, unfold.pane.h, 1), darkS.pane);
    await ui.screenshot("b-756-dark");
    await ui.setTheme("light");
    await ui.sleep(600);

    // a wide window: the dragged share holds; a double-click there gives 55% of the room
    await resize(1440, 887);
    const wide = qa.states.wide = await read();
    const wroom = wide.top + wide.pane.h;
    const share = unfold.pane.h / (unfold.top + unfold.pane.h);
    check("1440 wide: the dragged share of the room holds", near(wide.pane.h / wroom, share, 0.01), { share, now: wide.pane.h / wroom });
    const wat = await sashAt();
    await page.mouse.dblclick(wat.x, wat.y);
    await ui.sleep(500);
    const wdef = qa.states.wideDefault = await read();
    check("1440 wide, double-clicked: 55% of the room for the pane", near(wdef.pane.h, defaultPane(wroom, 1440), 1), { pane: wdef.pane, want: defaultPane(wroom, 1440) });
    await ui.screenshot("b-1440");
  } finally {
    await browser.close().catch(() => {});
    await ui.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }

  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
