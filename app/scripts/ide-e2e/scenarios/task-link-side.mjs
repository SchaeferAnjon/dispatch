// A task link in a reply opens a task of this session in Now, its row open (user 2026-11-16, task-ewbvh, section 7);
// any other task in place in the side pane's Tasks tab (user 2026-11-15, task-86t0e): the
// conversation in the middle stays, the side pane opens when it was closed, Tasks comes to the front and the task is
// there opened (title, state mark, plan, what it delivered), although it belongs to another project and session; from
// the click to the opened card in less than a second (the reply's tasks are asked for as soon as it is drawn). The
// session runs on OpenCode with DeepSeek's or GLM's flash model, never Claude; it is asked to say one sentence with the
// link. Light and dark shots, the link and the opened task marked; the close button takes the task away again.
export const meta = { needs: ['opencode'], timeout: 1500,
  title: "对话里的任务链接在右栏 Tasks 页就地打开",
  description: "回复里点一个别的项目、别的会话的任务链接：中间对话不动，右栏打开切到 Tasks，这件任务就地展开（标题、状态记号、计划、交付物），从点到展开小于 1 秒；关闭键收走。浅色深色各一张，标出链接和展开的任务。",
};

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const run = promisify(execFile);
const TITLE = "Try the add-in in real Word";
const OTHER_PROJECT = "word-addin";
const OTHER_SESSION = "0ther5e5-0000-4000-8000-00000000a11d";
const STEPS = ["Build the add-in", "Sideload it into Word", "Click every button in Word", "Write down what broke"];

/** The instance's own dispatch CLI in the instance's environment, plus `extra` (an agent's DISPATCH_SESSION_ID). */
async function cli(ui, extra, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); x=json.loads(sys.argv[2]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); env.update(x); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[3:]],env)";
  const r = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), JSON.stringify(extra || {}), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240000 });
  return r.stdout;
}
const json = (text) => JSON.parse(text.slice(Math.min(...[text.indexOf("{"), text.indexOf("[")].filter(i => i >= 0))));

const activeTab = (ui) => ui.eval(`(document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label') || '').trim()`);
const responses = (ui) => ui.eval(`document.querySelectorAll('.interactive-response').length`);

/** What the window shows: the middle (the chat, or a page over it), the side pane, the task opened in place. */
const READ = (id) => `(() => {
  const shown = e => !!e && !!e.offsetParent && e.getBoundingClientRect().height > 0;
  const chat = [...document.querySelectorAll('.interactive-session')].find(shown);
  const link = [...document.querySelectorAll('.interactive-response .dispatch-task-link[data-task="${id}"]')].find(shown);
  const page = [...document.querySelectorAll('.dispatch-task-page')].find(shown);
  const tasks = [...document.querySelectorAll('.dispatch-tasks')].find(shown);
  const card = tasks && tasks.querySelector('[data-task-id="${id}"]');
  const block = card && card.closest('.dispatch-task-linked');
  const mark = card && card.querySelector('.dispatch-task-head .dispatch-task-mark');
  const cs = (e, p) => e ? getComputedStyle(e)[p] : '';
  return {
    chat: !!chat, link: link ? link.textContent : '', page: !!page,
    titlebar: (document.querySelector('.part.titlebar')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
    tasks: !!tasks, activeTab: (document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label') || '').trim(),
    card: card ? { open: card.classList.contains('open'), pending: card.classList.contains('dispatch-task-card-pending'),
      title: (card.querySelector('.dispatch-task-title') || {}).textContent || '',
      mark: mark ? { cls: String(mark.getAttribute('class')), status: mark.dataset.status, w: Math.round(mark.getBoundingClientRect().width) } : null,
      steps: [...card.querySelectorAll('.dispatch-task-plan li')].filter(shown).map(li => ({ text: li.textContent, state: ['done', 'active', 'todo'].find(k => li.classList.contains(k)) })),
      delivered: [...card.querySelectorAll('.dispatch-task-deliverables .dispatch-task-deliverable')].filter(shown).map(b => b.textContent),
      inLinked: !!block, top: tasks ? Math.round(card.getBoundingClientRect().top - tasks.getBoundingClientRect().top) : 0 } : null,
    head: block ? { text: (block.querySelector('.dispatch-task-linked-where') || {}).textContent || '', h: Math.round(block.querySelector('.dispatch-task-linked-head').getBoundingClientRect().height),
      font: cs(block.querySelector('.dispatch-task-linked-head'), 'fontSize') + '/' + cs(block.querySelector('.dispatch-task-linked-head'), 'fontWeight'),
      close: (block.querySelector('.dispatch-task-linked-close') || {}).getAttribute?.('aria-label') || '' } : null,
    overflowX: tasks ? tasks.scrollWidth > tasks.clientWidth + 1 : false,
    // the close button and the card's caret on one vertical line; what is under the block and how far
    align: block ? (() => { const c = block.querySelector('.dispatch-task-linked-close').getBoundingClientRect(); const k = block.querySelector('.dispatch-task-caret'); const r = k && k.getBoundingClientRect(); return r ? Math.round((c.left + c.width / 2) - (r.left + r.width / 2)) : null; })() : null,
    below: block ? (() => { const n = block.nextElementSibling; return n ? { cls: n.className, text: n.innerText.replace(/\\s+/g, ' ').slice(0, 120), gap: Math.round(n.getBoundingClientRect().top - block.getBoundingClientRect().bottom) } : null; })() : null,
  };
})()`;

export default async function (ui) {
  const qa = { checks: [], failed: [] };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };

  await offscreen(ui);
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await offscreen(ui);
  await closeTips(ui);
  await ui.sleep(1500);
  await cli(ui, {}, "nextup", "pause");

  // 1. the task the reply will name: another project's, filed by another session, three of four steps under way and a page delivered
  const other = { DISPATCH_SESSION_ID: OTHER_SESSION };
  const begun = json(await cli(ui, other, "begin", TITLE, "-P", OTHER_PROJECT, "--session", OTHER_SESSION, "-d", "Seeded by task-link-side: another project's task the reply links to.", "-a", "- [ ] it runs in Word", "--force", "--json"));
  const id = begun.id;
  qa.task = id;
  await cli(ui, other, "task", "plan", id, ...STEPS.flatMap(s => ["--set", s]), "--done", "1,2", "--active", "3");
  await cli(ui, other, "task", "deliver", id, "--url", "https://example.com/word-addin-notes", "--label", "Word test notes");
  const seeded = json(await cli(ui, {}, "task", "show", id, "--brief", "--json"));
  check("the seeded task is another project's, with four steps and one deliverable", seeded.project === OTHER_PROJECT && seeded.plan.length === 4 && seeded.deliverables.length === 1, { project: seeded.project, plan: seeded.plan, deliverables: seeded.deliverables });

  // 2. a real session on the demo project that says one sentence with the link (OpenCode, the cheap model)
  await onDemo(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  const before = await responses(ui);
  await ui.type(`Reply with exactly this sentence and nothing else, no tools: Next I will check it in Word (${TITLE}, ${id}).`);
  await ui.press("Enter", { send: true });
  const linkCss = `.interactive-response .dispatch-task-link[data-task="${id}"]`;
  await until(ui, async () => (await responses(ui)) > before && await ui.exists({ css: linkCss }), 300000, "the reply with the task link", 2000);
  // the turn is over (no Stop button), and the reply has had a moment, as a person reads it before clicking
  await until(ui, async () => !(await ui.eval(`[...document.querySelectorAll('.interactive-input-part [aria-label]')].some(e => e.offsetParent && /^(Stop|Cancel)\\b/.test(e.getAttribute('aria-label')))`)), 120000, "the end of the turn", 1000);
  await ui.sleep(4000);
  await closeTips(ui);

  // the side pane closed, on another tab when it was open: the click has to open it and bring Tasks to the front
  await ui.openNowTab().catch(() => undefined);
  if (await ui.exists({ aria: "Hide side panel", webview: false })) {
    await ui.click({ aria: "Hide side panel", webview: false });
    await ui.sleep(1200);
  }
  const was = await ui.eval(READ(id));
  qa.before = was;
  check("before the click: the chat in the middle with the link, Tasks not shown", was.chat && !!was.link && !was.page && !was.tasks, was);

  // 3. the click, timed in the page: from the click to the opened card with its steps
  await ui.eval(`(() => {
    const t = window.__dispatchTaskLink = { click: 0, title: 0, steps: 0 };
    document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.dispatch-task-link[data-task="${id}"]')) t.click = performance.now(); }, true);
    const look = () => {
      const card = [...document.querySelectorAll('.dispatch-tasks [data-task-id="${id}"]')].find(e => e.offsetParent);
      if (card && !t.title && t.click && card.querySelector('.dispatch-task-title')?.textContent) t.title = performance.now();
      if (card && t.click && card.classList.contains('open') && [...card.querySelectorAll('.dispatch-task-plan li')].some(li => li.offsetParent)) { t.steps = performance.now(); return; }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  })()`);
  await ui.click({ css: linkCss });
  const timing = await until(ui, async () => { const t = await ui.eval(`window.__dispatchTaskLink`); return t && t.steps ? t : null; }, 15000, "the task opened in Tasks", 100).catch(async () => ui.eval(`window.__dispatchTaskLink`));
  qa.ms = { title: timing.title ? Math.round(timing.title - timing.click) : null, opened: timing.steps ? Math.round(timing.steps - timing.click) : null };
  check("from the click to the opened task with its steps: under 1000 ms", !!timing.steps && timing.steps - timing.click < 1000, qa.ms);
  await ui.sleep(2500);
  const after = await ui.eval(READ(id));
  qa.after = after;
  check("the conversation stays in the middle, no task page over it", after.chat && !!after.link && !after.page, { chat: after.chat, link: after.link, page: after.page, titlebar: after.titlebar });
  check("the side pane opened on Tasks", after.tasks && /^Tasks/.test(after.activeTab), after.activeTab);
  check("the task is opened in place, on its own above the list", !!after.card && after.card.open && !after.card.pending && after.card.inLinked, after.card);
  check("its title", after.card && after.card.title === TITLE, after.card && after.card.title);
  check("its state mark from the symbol table: in progress, the 14 px filled circle", after.card && after.card.mark && after.card.mark.status === "in_progress" && /dispatch-mark/.test(after.card.mark.cls) && after.card.mark.w === 14, after.card && after.card.mark);
  check("its plan: done, done, the one it is on, not yet", after.card && after.card.steps.map(s => s.state).join() === "done,done,active,todo" && after.card.steps.map(s => s.text).join("|") === STEPS.join("|"), after.card && after.card.steps);
  check("what it delivered, by name", after.card && after.card.delivered.length === 1 && /Word test notes/.test(after.card.delivered[0]), after.card && after.card.delivered);
  check("the head says where it is from: its project, 28 high, 12/600, with Close", after.head && after.head.text === `In ${OTHER_PROJECT}` && after.head.h === 28 && after.head.font === "12px/600" && after.head.close === "Close", after.head);
  check("nothing wider than the pane", !after.overflowX, after.overflowX);
  check("the close button is on the same vertical line as the card's caret", after.align !== null && Math.abs(after.align) <= 1, after.align);
  check("the list goes on 16 under the block; an empty list still says so", !!after.below && after.below.gap === 16 && (!/dispatch-tasks-line/.test(after.below.cls) || /No tasks in this session yet|Nothing in progress/.test(after.below.text)), after.below);

  // 4. light and dark, the link and the opened task marked
  const linked = `.dispatch-tasks .dispatch-task-linked`;
  for (const theme of ["light", "dark"]) {
    await closeTips(ui);
    await ui.setTheme(theme);
    await ui.sleep(900);
    await ui.eval(`document.querySelector('${linkCss}')?.scrollIntoView({ block: 'center' })`);
    // the pointer off the card and the link: no hover card in the picture
    await ui.mouse("mouseMoved", await ui.eval(`Math.round(innerWidth / 2)`), 8);
    await ui.sleep(700);
    await ui.screenshot(`task-link-${theme}`);
    await ui.mark({ css: linkCss }, { what: "回复里的任务链接（别的项目、别的会话的任务）", where: "中间对话里", how: "点它：对话不动，右栏 Tasks 就地展开这件任务" });
    await ui.mark({ css: linked }, { what: "就地展开的任务：从哪来、状态记号、计划、交付物", where: "右栏 Tasks 页签最上面", how: "点关闭键收走；点标题进整页任务" });
  }
  await ui.setTheme("light");
  await ui.sleep(500);

  // 5. a second click on the same link while it shows: nothing doubles; then Close takes it away
  await ui.click({ css: linkCss });
  await ui.sleep(800);
  const again = await ui.eval(`document.querySelectorAll('.dispatch-tasks [data-task-id="${id}"]').length`);
  check("a second click shows the task once", again === 1, again);
  await ui.click({ css: `${linked} .dispatch-task-linked-close` });
  await ui.sleep(600);
  const closed = await ui.eval(READ(id));
  check("Close takes the task away; the chat is still there", !closed.card && closed.chat && !closed.page, { card: closed.card, chat: closed.chat });

  // 6. the board moved on since the reply was drawn (another session ticked step 3): the click shows what the window
  // knew at once, then the board's answer fills in behind it; this is the time a question to the board takes (the
  // CLI through dispatch-bridge), what a click would wait for without the answers kept
  await cli(ui, other, "task", "plan", id, "--done", "1,2,3", "--active", "4");
  await ui.eval(`(() => {
    const t = window.__dispatchTaskLink2 = { click: 0, shown: 0, fresh: 0 };
    document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.dispatch-task-link[data-task="${id}"]')) t.click = performance.now(); }, true);
    const look = () => {
      const card = [...document.querySelectorAll('.dispatch-tasks [data-task-id="${id}"]')].find(e => e.offsetParent);
      const lis = card ? [...card.querySelectorAll('.dispatch-task-plan li')] : [];
      if (t.click && !t.shown && lis.length) t.shown = performance.now();
      if (t.click && lis.length === 4 && lis[2].classList.contains('done') && lis[3].classList.contains('active')) { t.fresh = performance.now(); return; }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  })()`);
  await ui.click({ css: linkCss });
  const t2 = await until(ui, async () => { const t = await ui.eval(`window.__dispatchTaskLink2`); return t && t.fresh ? t : null; }, 20000, "the board's newer plan in the opened task", 100).catch(async () => ui.eval(`window.__dispatchTaskLink2`));
  qa.msAgain = { shown: t2.shown ? Math.round(t2.shown - t2.click) : null, boardAnswer: t2.fresh ? Math.round(t2.fresh - t2.click) : null };
  check("clicked again after the board changed: the known task at once (< 1000 ms), the board's answer fills in after", !!t2.shown && t2.shown - t2.click < 1000 && !!t2.fresh, qa.msAgain);

  // 7. a link to a task of this very session (task-ewbvh, the person 2026-11-16): the side pane goes to Now, not Tasks,
  // and the task's row there opens in place and flashes once; a link to any other task still opens in Tasks (above)
  await ui.openNowTab();
  const sid = (await until(ui, async () => ui.eval(`document.querySelector('.dispatch-now-tab')?.dataset.session || ''`), 30000, "the Now tab's session", 500)).replace(/^[a-z][\w+.-]*:\/*/i, "").split("/").pop();
  const mine = { DISPATCH_SESSION_ID: sid };
  const OWN = "Hang the pills under the step";
  await cli(ui, mine, "begin", OWN, "-P", "demo", "--session", sid, "-d", "Seeded by task-link-side: a task of this session, which Now lists.", "-a", "- [ ] Now lists it");
  const tl = json(await cli(ui, mine, "task", "list", "--session", sid, "--json"));
  const own = (tl.tasks || tl).find(t => t.title === OWN).id;
  qa.ownTask = own;
  await cli(ui, mine, "task", "plan", own, "--set", "Draw the pill", "--set", "Put it in Now", "--set", "Check it", "--done", "1", "--active", "2");
  const rowCss = `.dispatch-now-tab .dispatch-now-task[data-task="${own}"]`;
  // the shown Now tab's row (a closed group can keep a Now tab of its own, hidden)
  const ROW = `[...document.querySelectorAll('${rowCss}')].find(e => e.offsetParent)`;
  await until(ui, async () => ui.exists({ css: rowCss }), 60000, "the session's own task in Now", 1000);
  // the side pane was closed above (section 2): open it again, so the row can be closed by hand first
  await until(ui, async () => {
    if (await ui.eval(`!!${ROW}`)) return true;
    if (await ui.exists({ aria: "Show side panel", webview: false })) await ui.click({ aria: "Show side panel", webview: false });
    await ui.openNowTab().catch(() => undefined);
    return ui.eval(`!!${ROW}`);
  }, 60000, "the session's own task row on screen in Now", 1500);
  // its row closed, and the side pane on another tab: the click has to bring Now back and open the row
  if (await ui.eval(`${ROW}?.querySelector('.dispatch-now-caret')?.getAttribute('aria-expanded') === 'true'`)) {
    await ui.click({ css: `${rowCss} .dispatch-now-caret` });
    await ui.sleep(400);
  }
  const closedBefore = await ui.eval(`${ROW}?.querySelector('.dispatch-now-caret')?.getAttribute('aria-expanded')`);
  await ui.click({ css: '.tabs-container .tab[aria-label^="Tasks"]' }).catch(() => undefined);
  await ui.sleep(800);
  const before2 = await responses(ui);
  await focusInput(ui, ".interactive-input-part");
  await ui.type(`Reply with exactly this sentence and nothing else, no tools: I am on ${OWN} (${own}).`);
  await ui.press("Enter", { send: true });
  const ownLink = `.interactive-response .dispatch-task-link[data-task="${own}"]`;
  await until(ui, async () => (await responses(ui)) > before2 && await ui.exists({ css: ownLink }), 300000, "the reply with this session's task link", 2000);
  await until(ui, async () => !(await ui.eval(`[...document.querySelectorAll('.interactive-input-part [aria-label]')].some(e => e.offsetParent && /^(Stop|Cancel)\\b/.test(e.getAttribute('aria-label')))`)), 120000, "the end of the turn", 1000);
  await ui.sleep(2000);
  await closeTips(ui);
  const tabBeforeOwn = await activeTab(ui);
  await ui.eval(`(() => { const t = window.__dispatchOwnLink = { click: 0, open: 0, flash: false };
    document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.dispatch-task-link[data-task="${own}"]')) t.click = performance.now(); }, true);
    // the row opened, then (a frame later) its flash: looked for during a second after the click
    const look = () => { const row = ${ROW}; const c = row && row.querySelector('.dispatch-now-caret');
      if (t.click && row && c && c.getAttribute('aria-expanded') === 'true' && !t.open) t.open = performance.now();
      if (t.click && row && row.classList.contains('flash')) t.flash = true;
      if (t.click && performance.now() - t.click > 1500 && t.open) return;
      requestAnimationFrame(look); };
    requestAnimationFrame(look); })()`);
  await ui.click({ css: ownLink });
  await until(ui, async () => { const t = await ui.eval(`window.__dispatchOwnLink`); return t && t.open ? t : null; }, 15000, "the row opened in Now", 100).catch(() => null);
  await ui.sleep(1700);
  const ownTiming = await ui.eval(`window.__dispatchOwnLink`);
  const ownAfter = { tab: await activeTab(ui), open: await ui.eval(`${ROW}?.querySelector('.dispatch-now-caret')?.getAttribute('aria-expanded')`), flash: !!ownTiming.flash, tasksShown: await ui.eval(`!![...document.querySelectorAll('.dispatch-tasks')].find(e => e.offsetParent)`), chat: await ui.eval(`!![...document.querySelectorAll('.interactive-session')].find(e => e.offsetParent)`), ms: ownTiming.open ? Math.round(ownTiming.open - ownTiming.click) : null };
  qa.ownLink = { closedBefore, tabBeforeOwn, ...ownAfter };
  check("a link to this session's own task: the side pane goes to Now (not Tasks), its row opens and flashes, the chat stays", closedBefore === "false" && !/^Now/.test(tabBeforeOwn) && /^Now/.test(ownAfter.tab) && ownAfter.open === "true" && ownAfter.flash && !ownAfter.tasksShown && ownAfter.chat, qa.ownLink);
  await ui.screenshot("task-link-own-now");
  await ui.mark({ css: ownLink }, { what: "回复里本会话任务的链接", where: "中间对话里", how: "点它：右栏切到 Now，这件任务那一行就地展开、闪一次" }).catch(() => undefined);
  await ui.mark({ css: rowCss }, { what: "Now 里展开的那一行", where: "右栏 Now", how: "不跳 Tasks" }).catch(() => undefined);

  note();
  if (qa.failed.length) throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(" | ").slice(0, 1500)}`);
}
