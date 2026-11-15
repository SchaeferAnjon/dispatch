// The Now tab of a session the person stopped, and what the tab shows while it does not know yet (audit round 1,
// kanban task-cq11p):
//   1 a turn stopped with the stop key reads "Stopped" and "You stopped it. Send a message to go on.", with Reply.
//     It said "Done", as if the work had been finished.
//   2 coming back to the session shows what it showed last at once; after a reload, when nothing is known yet, quiet
//     bars stand in. The head said "Done" and "Looking..." for a second or two on every switch.
// Start: dispatch ide instance start <name> --agents ; dispatch ide e2e run now-stopped --instance <name> --out <dir>
export const meta = {
  needs: ["opencode"],
  title: "停下的会话：Now 写 Stopped，切回来不先说 Done",
  description: "真起一段 OpenCode 会话，按停止键：右栏 Now 写 Stopped 和「You stopped it. Send a message to go on.」，按钮是 Reply 和 See changes，没有 Done。离开再回来，Now 立刻是上次的样子；重载窗口后再打开，先是三条安静的占位条，再是 Stopped，中间不出现 Done。",
  timeout: 900,
};

import fs from "node:fs";
import path from "node:path";
import { READ, until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const MESSAGE = "Count from 1 to 3000, one number per line, in one reply. Do not use any tool and do not stop before 3000.";

// Every head the Now tab shows from now on, with the session it speaks for: read back after a switch.
const WATCH = `(() => {
  const log = window.__nowLog = [];
  const look = () => {
    const n = document.querySelector('.dispatch-now-tab');
    const head = n && n.querySelector('[data-part="now-head"]');
    const s = !n ? 'no tab' : n.querySelector('[data-part="now-head-loading"]') ? 'bars'
      : head ? head.dataset.mode + '|' + ((head.querySelector('.dispatch-now-status') || {}).textContent || '') + '|' + ((head.querySelector('.dispatch-now-say') || {}).textContent || '') : 'empty';
    const session = n ? n.dataset.session || '' : '';
    if (!log.length || log[log.length - 1].s !== s || log[log.length - 1].session !== session) log.push({ t: Math.round(performance.now()), s, session });
  };
  if (window.__nowWatch) window.__nowWatch.disconnect();
  window.__nowWatch = new MutationObserver(look);
  window.__nowWatch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-mode', 'data-session', 'data-part'] });
  look();
  return true;
})()`;

export default async function (ui) {
  const qa = { checks: [], failed: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 500)}`);
    note();
  };
  const waitNow = (fn, what, ms = 60000) => until(ui, async () => { const s = await ui.eval(READ); return s && fn(s) ? s : null; }, ms, what, 300);
  const selectedTitle = () => ui.eval(`(document.querySelector('.session-list-inset-row.selected .session-title, .session-list-inset-row.focused .session-title')?.textContent || '').trim()`);

  // a real session on the demo project that works for a while
  await offscreen(ui);
  await onDemo(ui);
  await offscreen(ui);
  await closeTips(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(MESSAGE);
  await ui.press("Enter", { send: true });
  const STOP = ".interactive-input-part .chat-execute-toolbar .codicon-stop-circle";
  await ui.waitFor({ css: STOP }, { timeoutMs: 90000 });
  await ui.openNowTab();
  const working = await waitNow(s => s.mode === "working", "the working head", 90000);
  check("while it works the head says Working", /^Working/.test(working.status), working.status);
  await ui.sleep(4000); // the reply is on its way, not just starting
  await ui.screenshot("01-working");

  // 1. the person stops it
  await ui.click({ css: STOP });
  const stopped = await waitNow(s => s.mode !== "working" && s.mode !== "", "the head after the stop key", 60000);
  await ui.sleep(2500); // what it settles on, not the first thing it shows
  const head = await ui.eval(READ);
  qa.stopped = { first: { mode: stopped.mode, status: stopped.status, say: stopped.say }, mode: head.mode, status: head.status, say: head.say, buttons: head.buttons.map(b => `${b.text}:${b.kind}`), mark: head.mark };
  check("stopped by the person: the head is Stopped, never Done", head.mode === "stopped" && /^Stopped\b/.test(head.status) && stopped.mode !== "done", qa.stopped);
  check("it says who stopped it and how to go on", head.say === "You stopped it. Send a message to go on.", head.say);
  check("Reply (outline) and See changes (ghost), no solid button", head.buttons.map(b => `${b.text}:${b.kind}`).join() === "Reply:outline,See changes:ghost", head.buttons);
  check("the mark is the 14 px coral filled circle (DESIGN.md「符号表」)", /codicon-circle-large-filled .*dispatch-mark stopped/.test(head.mark) && head.markW === 14 && head.markColor === head.tokens.stopped, { mark: head.mark, w: head.markW, color: head.markColor, token: head.tokens.stopped });
  check("no green circle left in the tab", !(await ui.eval(`!!document.querySelector('.dispatch-now-tab .dispatch-mark.now')`)));
  await ui.screenshot("02-stopped");
  await ui.mark({ css: '.dispatch-now-tab [data-part="now-head"]' }, { what: "被你停下的会话写 Stopped", where: "右栏 Now 头三行", how: "Reply 把光标放进输入框，接着说就继续" });
  const sid = await ui.eval(`document.querySelector('.dispatch-now-tab').dataset.session`);
  const title = await selectedTitle();
  check("the stopped session is the selected row", !!title, title);

  // 2a. away (a new-session page has no Now) and back: what it showed last is there at once
  await ui.eval(WATCH);
  await ui.newSession();
  await ui.sleep(1500);
  await ui.openSession(title);
  await ui.openNowTab();
  await waitNow(s => s.mode === "stopped", "the stopped head after coming back", 30000).catch(async e => {
    qa.backTimeout = { head: await ui.eval(READ), log: await ui.eval(`window.__nowLog`), tab: await ui.eval(`(document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label') || '')`), title, selected: await selectedTitle() };
    note();
    throw e;
  });
  await ui.sleep(2500);
  const back = (await ui.eval(`window.__nowLog`)).filter(e => e.session === sid);
  qa.back = back;
  check("back on the session: the first thing the tab shows is the Stopped head", back.length > 0 && /^stopped\|Stopped/.test(back[0].s), back.map(e => e.s));
  check("back on the session: never Done, never the bars", back.every(e => !/^done\|/.test(e.s) && e.s !== "bars"), back.map(e => e.s));

  // 2b. after a reload nothing is remembered: quiet bars until the answer is in, never a guessed Done
  await ui.newSession();
  await ui.sleep(1000);
  await ui.reloadWindow();
  await ui.sleep(1500);
  await ui.attach("agents", 60000);
  await offscreen(ui);
  await closeTips(ui);
  await ui.newSession();
  await ui.sleep(1500);
  await ui.eval(WATCH);
  await ui.openSession(title);
  await ui.openNowTab();
  const after = await waitNow(s => s.mode === "stopped", "the stopped head after a reload", 60000).catch(async e => { qa.afterReloadTimeout = { head: await ui.eval(READ), log: await ui.eval(`window.__nowLog`) }; note(); throw e; });
  await ui.sleep(2000);
  const fresh = (await ui.eval(`window.__nowLog`)).filter(e => e.session && e.s !== "no tab");
  qa.fresh = fresh;
  check("after a reload: still Stopped, with the same line", /^Stopped\b/.test(after.status) && after.say === "You stopped it. Send a message to go on.", { status: after.status, say: after.say });
  check("after a reload: the head never says Done on the way", fresh.every(e => !/^done\|/.test(e.s)), fresh.map(e => e.s));
  check("after a reload: nothing but the bars before the Stopped head", fresh.every(e => e.s === "bars" || e.s === "empty" || /^stopped\|/.test(e.s)), fresh.map(e => e.s));
  await ui.screenshot("03-after-reload");

  note();
  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 900)}`);
}
