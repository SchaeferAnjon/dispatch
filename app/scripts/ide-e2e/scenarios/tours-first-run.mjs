// Tips and Getting started on a Mac that has never run Dispatch: nothing shows over the setup page, the
// checklist entry and the first tips come after it, every tip shows once and is gone after a reload.
import assert from "node:assert/strict";

export const meta = { instance: { onboarding: 'fresh', tips: true },
  title: "新用户的提示和 Getting started 清单",
  description: "全新 HOME：向导期间没有任何提示；向导走完先出 Welcome 卡，关掉后标题栏出现带进度环的 Getting started，欢迎提示和新会话提示依次出现、各出现一次，重载后不再出现，Help 里的 Replay Tips 让它们回来。",
};

/** The tip on screen: its step, words, counter, side, box, and whether it is hidden behind something. */
const bubble = (ui) => ui.eval(`(() => {
  const t = document.querySelector('.dispatch-tour'); if (!t) return null;
  const r = t.getBoundingClientRect(), ring = document.querySelector('.dispatch-tour-ring')?.getBoundingClientRect();
  return { step: t.dataset.step, side: t.dataset.side, title: t.querySelector('.dispatch-tour-title')?.textContent, body: t.querySelector('.dispatch-tour-body')?.textContent,
    count: t.querySelector('.dispatch-tour-count')?.textContent, buttons: [...t.querySelectorAll('.dispatch-tour-btn')].map(b => b.textContent),
    hidden: getComputedStyle(t).visibility === 'hidden', inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    box: [r.left, r.top, r.width, r.height].map(Math.round), ring: ring ? [ring.left, ring.top, ring.width, ring.height].map(Math.round) : null };
})()`);

async function waitStep(ui, step, timeoutMs = 25000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await ui.sleep(300)) {
    const b = await bubble(ui);
    if (b && b.step === step && !b.hidden) return b;
    // Start here comes on a new chat's page whenever that page is up, before or after the others: out of the way
    if (b && b.step === "first-prompt-card" && step !== "first-prompt-card" && !b.hidden) {
      await ui.click({ text: "Got it", exact: true, within: ".dispatch-tour" }).catch(() => undefined);
      await ui.sleep(600);
    }
  }
  // why not, in the failure: what covers the page (dispatchToursDom.blockingSurface) and what is over the anchor
  const why = await ui.eval(`(() => {
    const shown = (s) => [...document.querySelectorAll(s)].some(e => e.offsetParent || getComputedStyle(e).position === 'fixed');
    const sels = ['.monaco-dialog-modal-block', '.monaco-modal-editor-block', '.quick-input-widget', '.context-view .monaco-menu-container, .context-view .context-view-content', '.spotlight-overlay', '.monaco-hover.dispatch-whats-new-hover, .monaco-hover.dispatch-checklist-hover', '.dispatch-onboarding', '.part.sidebar.dispatch-settings-open > .dispatch-settings-nav', '.notification-toast'];
    const cards = [...document.querySelectorAll('.new-session-prompt-option')].map(c => { const r = c.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { id: c.id, text: c.textContent.slice(0, 40), w: Math.round(r.width), over: top === c || c.contains(top) ? 'self' : (top && (top.className || top.tagName)) }; });
    return { blocking: sels.filter(shown), cards, visibility: document.visibilityState };
  })()`).catch((e) => String(e));
  throw new Error(`the tip "${step}" never showed; on screen: ${JSON.stringify(await bubble(ui))}; ${JSON.stringify(why)}`);
}

async function entryLabel(ui) {
  // the entry is a status bar item that is always there, hidden until the setup is done: only a shown one counts
  return ui.eval("(() => { const e = document.querySelector('.dispatch-checklist-entry'); return e && e.offsetParent && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' ? e.getAttribute('aria-label') : null; })()");
}

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, "Start this instance with --onboarding fresh");
  await ui.attach("agents", 60000);
  await ui.waitFor({ text: "Continue", exact: true }, { timeoutMs: 90000 });

  // 1. over the setup page there is nothing: no tip, no checklist entry (eight seconds, longer than a tip waits)
  for (let i = 0; i < 8; i++) {
    assert.equal(await bubble(ui), null, "no tip over the setup page");
    assert.equal(await entryLabel(ui), null, "no checklist entry over the setup page");
    await ui.sleep(1000);
  }
  await ui.screenshot("01-setup-nothing-else");
  if (await ui.exists({ css: ".dispatch-whats-new-auto" })) await ui.press("Escape"); // closes the welcome card, not the setup
  // the screens between (Agent permissions and the others): no tip over any of them, Continue through them
  for (let i = 0; i < 6 && !(await ui.exists("Connect Dispatch to your agents")); i++) {
    await ui.click({ text: "Continue", exact: true });
    await ui.sleep(1200);
    assert.equal(await bubble(ui), null, "no tip over the setup's screens");
    assert.equal(await entryLabel(ui), null, "no checklist entry over the setup's screens");
  }
  await ui.waitFor("Connect Dispatch to your agents", { timeoutMs: 30000 });
  await ui.clickWhenEnabled({ text: "Set up Dispatch", exact: true });
  for (let i = 0; i < 120; i++) {
    if ((await ui.exists({ text: "Start", exact: true })) || (await ui.exists({ text: "Retry setup", exact: true }))) break;
    if (await ui.exists({ text: "Trust Publisher & Install", exact: true, within: ".monaco-dialog-box" })) await ui.click({ text: "Trust Publisher & Install", exact: true, within: ".monaco-dialog-box" });
    await ui.sleep(1000);
  }
  assert.equal(await bubble(ui), null, "no tip on the last setup screen");
  assert.equal(await entryLabel(ui), null, "no checklist entry on the last setup screen");
  await ui.click({ text: "Start", exact: true });
  // the Welcome card comes once the setup is done (it used to open over the setup page); no tip over it
  await ui.waitFor({ css: ".dispatch-whats-new-auto" }, { timeoutMs: 60000 }); // the Welcome card (no video placeholder since task-lj06.26)
  assert.equal(await bubble(ui), null, "no tip over the Welcome card");
  await ui.press("Escape");

  // 2. the checklist entry, with its ring
  await ui.waitFor({ css: ".dispatch-checklist-entry" }, { timeoutMs: 20000 });
  const label = await entryLabel(ui);
  assert.match(label, /^Getting started[,:] [01] of 8 done/, label); // "Getting started: 0 of 8 done. Click for the next step."
  await ui.mark({ css: ".dispatch-checklist-entry" }, { what: "Getting started", where: "左上角，What's new 右边，带进度环", how: "点它看清单，每项做完自己打勾" });

  // the first suggestion's tip (Start here) can come first on a new chat's page: read it through, as a person does
  for (let i = 0; i < 4; i++) {
    let b = null;
    for (const end = Date.now() + 8000; !(b = await bubble(ui)) && Date.now() < end; ) await ui.sleep(300);
    if (!b || !/^first-prompt/.test(b.step || "")) break;
    await ui.click({ text: b.buttons.at(-1), exact: true, within: ".dispatch-tour" });
    await ui.sleep(800);
  }
  // 3. the welcome tip: Waiting for you, Getting started (the Assistant's step went with it, 2026-11-11)
  const first = await waitStep(ui, "waiting-row");
  assert.equal(first.count, "1 of 2");
  assert.equal(first.side, "right");
  assert.ok(first.inside, JSON.stringify(first));
  assert.deepEqual(first.buttons, ["Next"]);
  assert.ok(first.ring && first.ring[2] > 100, "a ring round the row");
  await ui.screenshot("02-welcome-1");
  await ui.mark({ css: ".dispatch-tour" }, { what: "提示气泡", where: "贴着它说的那个元素，带箭头和圆环", how: "Next 看下一条，右上角 × 关掉这一组" });
  await ui.click({ text: "Next", exact: true, within: ".dispatch-tour" });
  const second = await waitStep(ui, "checklist");
  assert.equal(second.count, "2 of 2");
  await ui.click({ text: "Back", exact: true, within: ".dispatch-tour" });
  await waitStep(ui, "waiting-row");
  await ui.click({ text: "Next", exact: true, within: ".dispatch-tour" });
  const third = await waitStep(ui, "checklist");
  assert.equal(third.count, "2 of 2");
  assert.equal(third.side, "top"); // the entry sits in the status bar at the window's foot
  assert.deepEqual(third.buttons, ["Back", "Got it"]);
  await ui.screenshot("03-welcome-3");
  await ui.click({ text: "Got it", exact: true, within: ".dispatch-tour" });
  assert.equal(await bubble(ui), null, "Got it closes the tip");

  // 4. the next place: the new-session page
  const ns = await waitStep(ui, "new-workspace", 30000);
  assert.match(ns.count, /^1 of [2-4]$/);
  await ui.screenshot("04-new-session");
  await ui.click({ css: ".dispatch-tour-close" });
  assert.equal(await bubble(ui), null, "the cross closes the whole tour");

  // 5. a tip that is gone does not come back: not on its own, not after a reload
  await ui.sleep(6000);
  assert.equal(await bubble(ui), null, "a closed tip stays closed");
  await ui.reloadWindow(); // a real reload (location.reload() is refused by the workbench)
  await ui.sleep(2000);
  await ui.attach("agents", 60000);
  await ui.waitFor({ css: ".dispatch-checklist-entry" }, { timeoutMs: 60000 });
  await ui.sleep(11000);
  assert.equal(await bubble(ui), null, "nothing shows again after a reload");

  // 6. (the Assistant's own tip went with the Assistant, 2026-11-11)
  // 7. a new chat's page: its first suggestion card gets the first tip; a stand-in card with VS Code's own class and
  // the suggestion's words is put on screen when the page is not up.
  await ui.eval(`(() => { const b = document.createElement('button'); b.className = 'new-session-prompt-option'; b.id = 'tips-standin'; b.textContent = 'Check my projects for unfinished work';
    b.style.cssText = 'position:fixed;left:520px;top:420px;width:320px;height:36px;z-index:5'; document.body.appendChild(b); })()`);
  // Help > Replay Tips: they show again, the suggestion first
  await ui.click({ aria: "Claude and ChatGPT accounts", webview: false });
  // the menu grows while its account rows come in, and Getting Started sits right above Replay Tips: the click waits
  // until the row stops moving, as a person's eye does (10-08: the click opened the checklist, which held every tip back)
  const rowAt = () => ui.eval(`(() => { const e = [...document.querySelectorAll('.context-view *, .monaco-menu *')].find(x => !x.children.length && x.textContent.trim() === 'Replay Tips' && x.offsetParent); const r = e && e.getBoundingClientRect(); return r ? Math.round(r.y) : null; })()`);
  for (let last = null, same = 0, i = 0; i < 40 && same < 3; i++) {
    const y = await rowAt();
    same = y !== null && y === last ? same + 1 : 0;
    last = y;
    await ui.sleep(250);
  }
  await ui.click({ text: "Replay Tips", exact: true });
  // its toast may sit in the notification centre (the test Mac's Do Not Disturb): the tips coming back below are the proof
  await ui.waitForText("Tips will show again", { timeoutMs: 10000 }).catch(() => undefined);
  // its toast does not go by itself in a window without the focus (a test's), and tips wait while it covers the page:
  // close it, as a person does
  for (let i = 0; i < 3 && await ui.exists({ css: ".notification-toast", webview: false }); i++) {
    await ui.click({ css: ".notification-toast .codicon-notifications-clear, .notification-toast .codicon-close", webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(500);
  }
  const start = await waitStep(ui, "first-prompt-card", 90000); // a tip waits a while after the last one ended
  assert.equal(start.side, "top");
  assert.match(start.body, /what is unfinished in your projects/);
  assert.deepEqual(start.buttons, ["Got it"]);
  await ui.screenshot("06-first-prompt");
  await ui.mark({ css: ".dispatch-tour" }, { what: "第一条提示", where: "指着新对话页上的建议卡", how: "点那张卡，提示自己收起" });
  // the card the tip points at: a new chat's own when its page is up, else the stand-in
  const real = await ui.eval(`[...document.querySelectorAll('.new-session-prompt-option')].some(c => c.id !== 'tips-standin' && /Check my projects/.test(c.textContent) && c.offsetParent)`);
  if (real) {
    await ui.eval("document.getElementById('tips-standin')?.remove()");
    await ui.click({ css: ".new-session-prompt-option", index: 0 });
  } else {
    await ui.click({ css: "#tips-standin" });
    await ui.eval("document.getElementById('tips-standin')?.remove()");
  }
  for (let i = 0; i < 20 && await bubble(ui); i++) await ui.sleep(250); // it goes a moment after the press
  assert.equal(await bubble(ui), null, "clicking the card ends its tip");
  await waitStep(ui, "waiting-row", 30000);
  await ui.screenshot("07-replayed");

  // 8. the checklist: the card, hide, and back from the account menu
  await ui.click({ css: ".dispatch-tour-close" });
  await ui.click({ css: ".dispatch-checklist-entry" });
  await ui.waitFor({ css: ".dispatch-checklist-card" });
  const rows = await ui.eval("[...document.querySelectorAll('.dispatch-checklist-card .row .a')].map(e => e.textContent)");
  assert.equal(rows[0], "Ask what is unfinished", "the list starts with asking what is unfinished (in a chat)");
  assert.equal(rows.length, 8);
  await ui.screenshot("08-checklist");
  await ui.click({ text: "Hide this list", exact: true });
  await ui.waitFor({ css: ".dispatch-checklist-entry" }, { gone: true, timeoutMs: 10000 });
  await ui.click({ aria: "Claude and ChatGPT accounts", webview: false });
  await ui.click({ text: "Getting Started", exact: true });
  await ui.waitFor({ css: ".dispatch-checklist-card" }, { timeoutMs: 10000 });
  assert.ok(await ui.exists({ css: ".dispatch-checklist-entry" }), "the entry is back");
}
