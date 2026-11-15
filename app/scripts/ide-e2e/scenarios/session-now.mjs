// The session page in Dispatch's blocks (Dispatch IDE patches/305-composer.patch) and the Now tab of direction A
// (2026-11-11, task-0v1o9, kanban design/home-now/notes.md A4): three lines and one line of steps, first in a real
// session's side pane. The same session goes through the four heads the tab has: working ("Working · step 3 of 5",
// the falling blocks, the step it is on breathing), done ("Done", Open delivery page and See changes), waiting for you
// (a proposal to pick: Open proposal, the one solid button, and Reply), and a terminal session (its last line). The
// carets, the folds (Done in this session, Next in demo, Handed over) and the buttons are clicked, each head is
// screenshot in light and dark, and its sizes are read from the page into qa.json. The real session runs on OpenCode
// with GLM-5.3-Flash or DeepSeek's flash model only, never Claude.
export const meta = { instance: { motion: true }, needs: ['opencode'],
  title: "会话页：Now 页签（方向 A：三行头加一条步骤线）和方块输入框",
  description: "输入框里引擎是小方块头像、发送键是方块；真实会话右栏第一个页签 Now 不再有卡：状态行、一句话、第三行（在做时 Right now、等你时 Open proposal 和 Reply、做完时 Open delivery page 和 See changes、终端时最后一行输出），下面任务行和一条步骤线，做完的收进折叠行。四种情形浅色深色各拍一张，按钮、箭头、折叠行都真点。",
  timeout: 2400,
};

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const run = promisify(execFile);
/** The instance's own dispatch CLI in the instance's environment, plus `extra` (an agent's DISPATCH_SESSION_ID). */
async function cli(ui, extra, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); x=json.loads(sys.argv[2]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); env.update(x); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[3:]],env)";
  const r = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), JSON.stringify(extra || {}), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240000 });
  return r.stdout;
}
/** bd on the instance's own board (things lined up in Next up are put there the way capture.py puts them). */
async function bd(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); os.execvpe('bd',['bd',*sys.argv[2:]],env)";
  const r = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  return r.stdout;
}
const NOW = (expr) => `(() => { const n = document.querySelector('.dispatch-now-tab'); return n ? (${expr}) : null; })()`;

/** What the Now tab shows, with the sizes the spec gives (A4): read from the page, never from a picture. */
const READ = `(() => {
  const n = document.querySelector('.dispatch-now-tab');
  if (!n) return null;
  const shown = e => !!e && !!e.offsetParent && e.getBoundingClientRect().height > 0;
  const h = e => e ? Math.round(e.getBoundingClientRect().height) : 0;
  const w = e => e ? Math.round(e.getBoundingClientRect().width) : 0;
  const cs = (e, p) => e ? getComputedStyle(e)[p] : '';
  const font = e => e ? cs(e, 'fontSize') + '/' + cs(e, 'fontWeight') : '';
  const head = n.querySelector('[data-part="now-head"]');
  const status = head && head.querySelector('.dispatch-now-status');
  const say = head && head.querySelector('.dispatch-now-say');
  const sub = head && head.querySelector('.dispatch-now-sub');
  const mark = status && status.querySelector('.dispatch-now-slot > *');
  const plan = n.querySelector('[data-part="now-plan"]');
  return {
    mode: head ? head.dataset.mode : '',
    width: w(n), overflowX: n.scrollWidth > n.clientWidth + 1,
    headLeft: head ? Math.round(head.getBoundingClientRect().left - n.getBoundingClientRect().left) + parseFloat(cs(head, 'paddingLeft')) : 0,
    headTop: head ? Math.round(head.getBoundingClientRect().top - n.getBoundingClientRect().top) : 0,
    status: status ? status.textContent : '', statusH: h(status), statusFont: font(status), statusTip: status ? status.title : '',
    mark: mark ? String(mark.getAttribute('class')) : '', markW: mark && mark.classList && mark.classList.contains('codicon') ? parseFloat(cs(mark, 'fontSize')) : w(mark), markColor: cs(mark, 'color'),
    // the colours the symbol table's marks must have, resolved in this theme (DESIGN.md「符号表」)
    tokens: (() => { const t = {}; for (const [k, v] of Object.entries({ done: '--dispatch-state-done', working: '--dispatch-state-working', waiting: '--dispatch-state-waiting', stopped: '--dispatch-state-stopped', plan: '--dispatch-state-plan', text2: '--vscode-descriptionForeground' })) { const e = document.createElement('span'); e.style.color = 'var(' + v + ')'; n.appendChild(e); t[k] = getComputedStyle(e).color; e.remove(); } return t; })(),
    say: say ? say.textContent : '', sayFont: say ? font(say) + '/' + cs(say, 'lineHeight') : '', sayLines: say ? Math.round(h(say) / parseFloat(cs(say, 'lineHeight'))) : 0,
    sayGap: say && status ? Math.round(say.getBoundingClientRect().top - status.getBoundingClientRect().bottom) : 0,
    sub: sub ? sub.textContent : '', subClass: sub ? sub.className : '', subFont: sub ? cs(sub, 'fontSize') + ' ' + cs(sub, 'fontFamily').split(',')[0] : '',
    subAnim: sub ? cs(sub, 'animationName') + ' ' + cs(sub, 'animationDuration') : '',
    buttons: [...(head ? head.querySelectorAll('.dispatch-now-btn') : [])].map(b => ({ text: b.textContent, kind: ['fill', 'outline', 'ghost'].find(k => b.classList.contains(k)), h: h(b), font: font(b), radius: cs(b, 'borderRadius'), bg: cs(b, 'backgroundColor'), border: cs(b, 'borderTopColor') })),
    buttonsGap: (() => { const b = head && head.querySelector('.dispatch-now-btns'); const above = (head && head.querySelector('[data-part="why"]')) || say; return b && above ? Math.round(b.getBoundingClientRect().top - above.getBoundingClientRect().bottom) : null; })(),
    planGap: plan && head ? Math.round(plan.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : null,
    tasks: [...(plan ? plan.querySelectorAll(':scope > .dispatch-now-task') : [])].map(t => ({ id: t.dataset.task, title: t.querySelector('.dispatch-now-title').textContent, count: (t.querySelector('.dispatch-now-count') || {}).textContent || '', h: h(t), titleFont: font(t.querySelector('.dispatch-now-title')), countFont: font(t.querySelector('.dispatch-now-count')), open: t.querySelector('.dispatch-now-caret').getAttribute('aria-expanded'), caretLabel: t.querySelector('.dispatch-now-caret').getAttribute('aria-label') })),
    steps: [...n.querySelectorAll('[data-part="now-plan"] > .dispatch-now-body.open > .dispatch-now-body-in > [data-part="steps"] > .dispatch-now-step')].filter(shown).map(s => ({ kind: ['done', 'now', 'ask', 'stop', 'todo'].find(k => s.classList.contains(k)), text: s.textContent, h: h(s), font: font(s.querySelector('.dispatch-now-words')), mark: (() => { const m = s.querySelector('.dispatch-now-slot > *'); return m ? { cls: String(m.getAttribute('class')), w: m.classList.contains('codicon') ? parseFloat(cs(m, 'fontSize')) : w(m), color: cs(m, 'color'), breath: m.classList.contains('live') ? cs(m, 'animationName') : '' } : null; })(), line: getComputedStyle(s, '::before').content !== 'none' || getComputedStyle(s, '::after').content !== 'none' })),
    agents: [...n.querySelectorAll('[data-part="now-plan"] .dispatch-now-agent:not(.more)')].filter(e => shown(e) && !e.closest('.dispatch-now-body:not(.open)')).map(a => {
      let p = (a.parentElement.closest('li.dispatch-now-body') || a).previousElementSibling; while (p && !p.classList.contains('dispatch-now-step')) p = p.previousElementSibling;
      const dot = a.querySelector('.dispatch-now-slot > *');
      return { text: a.textContent, name: (a.querySelector('.dispatch-now-agent-name') || {}).textContent || '', state: a.dataset.state, under: p ? p.textContent : '', inSteps: !!a.closest('[data-part="steps"]'), dot: dot ? String(dot.getAttribute('class')) : '', dotW: dot ? Math.round(dot.getBoundingClientRect().width) : 0, dotColor: dot ? cs(dot, 'color') : '', indent: Math.round(a.querySelector('.dispatch-now-slot').getBoundingClientRect().left - a.getBoundingClientRect().left), font: font(a.querySelector('.dispatch-now-words')) };
    }),
    finished: (n.querySelector('[data-part="finished"]') || {}).textContent || '',
    delivered: [...n.querySelectorAll('[data-part="now-plan"] > .dispatch-now-body.open .dispatch-now-dl')].filter(shown).map(d => ({ text: d.textContent, h: h(d), icon: String((d.querySelector('.codicon') || {}).className || '') })),
    folds: [...n.querySelectorAll('.dispatch-now-fold')].map(f => ({ part: f.dataset.part, text: f.textContent, open: f.getAttribute('aria-expanded'), h: h(f), font: font(f) })),
    cut: [...n.querySelectorAll('.dispatch-now-title, .dispatch-now-words, .dispatch-now-sub, .dispatch-now-state, .dispatch-now-fold-label')].filter(shown).filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 80)),
    oldCard: !!n.querySelector('.dispatch-now-card'), oldHeads: n.querySelectorAll('h4.dispatch-now-head').length,
    unnamed: [...n.querySelectorAll('button')].filter(b => !b.disabled && !(b.getAttribute('aria-label') || b.textContent.trim())).length,
    text: n.innerText.replace(/\\s+/g, ' ').slice(0, 500),
  };
})()`;

// two sub-agents one after the other, each counting a while: the session works with one running under the step it is
// on, then both are back (subagent-rows.mjs sends OpenCode the same kind of message)
const MESSAGE = 'Use your task tool twice, one after the other, to start two general subagents. First: description "Count to 1500 A", prompt "SUBCOUNT A: count from 1 to 3000, one number per line, then reply DONE.". Second: description "Count to 1500 B", prompt "SUBCOUNT B: count from 1 to 3000, one number per line, then reply DONE.". After both are back, reply with one short line: BLOCKS DONE.';

/** The test window goes off-screen: it must not jump in front of the person (shared brief). */
async function offscreen(ui) {
  try {
    const { windowId } = await ui.cdp.send("Browser.getWindowForTarget", {});
    await ui.cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* no Browser domain on this page: leave it */ }
}

/** The Agents window on the demo project, no tips in the way (this instance's own settings). */
async function onDemo(ui) {
  const st = path.join(ui.rec.root || path.dirname(path.dirname(ui.demoFolder)), "agents-user-data", "User", "settings.json");
  if (fs.existsSync(st)) { const j = JSON.parse(fs.readFileSync(st, "utf8") || "{}"); j["dispatch.tips.enabled"] = false; fs.writeFileSync(st, JSON.stringify(j, null, 1)); await ui.sleep(1500); }
  try { await ui.openAgents(ui.demoFolder); } catch (e) {
    if (!/editor window/.test(String(e && e.message))) throw e;
    await ui.click({ aria: "Editor" });
    await ui.sleep(8000);
    await ui.openAgents(ui.demoFolder);
  }
}

/** The new-session page on the demo project (the person's own folders stay untouched), the way a person gets there:
 *  the demo group's own New Session action in the side bar; the folder chip of the page as a second way. */
async function toDemo(ui) {
  const closeTours = async () => { for (let i = 0; i < 6 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); } };
  const where = async () => (await ui.eval(`(document.querySelector('.sessions-workspace-picker-trigger, .sessions-workspace-picker-trigger .action-label')?.innerText || '').trim()`)) || "";
  for (let i = 0; i < 4 && !/^demo\b/.test(await where()); i++) {
    await closeTours();
    if (await ui.exists({ text: "demo", exact: true, within: ".agent-sessions-viewpane" })) {
      await ui.hover({ text: "demo", exact: true, within: ".agent-sessions-viewpane" });
      await ui.eval(`(() => { const e = [...document.querySelectorAll('.agent-sessions-viewpane .session-section')].find(e => e.querySelector('.session-section-label')?.innerText.trim() === 'demo'); e?.setAttribute('data-e2e-group', 'demo'); })()`);
      if (await ui.exists({ aria: "New Session", exact: true, within: '[data-e2e-group="demo"]' })) {
        await ui.click({ aria: "New Session", exact: true, within: '[data-e2e-group="demo"]' });
        await ui.sleep(2500);
        continue;
      }
    }
    // no demo group yet: the page's folder chip
    await ui.newSession();
    await ui.sleep(2500);
    const chip = ".sessions-workspace-picker-trigger, .sessions-workspace-picker-trigger .action-label";
    if (await ui.exists({ css: chip })) {
      await ui.click({ css: chip });
      await ui.sleep(1200);
      if (await ui.exists({ text: "demo", exact: true, within: ".action-widget" })) await ui.click({ text: "demo", exact: true, within: ".action-widget" });
      else await ui.press("Escape");
      await ui.sleep(1200);
    }
  }
  const at = await where();
  assert(/^demo\b/.test(at), "the new session is not in the demo project, refusing to send: " + at);
  return at;
}

// ---- the cheap model, picked the way a person does it: /model in the input box (as notify-sleep.mjs) ----
async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) {
    const v = await fn();
    if (v) return v;
    await ui.sleep(every);
  }
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

/** One Now tab and a strip that settles, with a window that answers: ten one-second looks. The tab was once closed and
 *  added again tens of thousands of times as a session started, which froze the window. */
async function stripSettles(ui, where, looks = 10) {
  const look = () => ui.eval(`(() => { const tabs = [...document.querySelectorAll('.tabs-container .tab')]; return { tabs: tabs.length, now: tabs.filter(t => /^Now/.test(t.getAttribute('aria-label') || t.textContent.trim())).length }; })()`);
  const first = await look();
  const seen = [first];
  for (let i = 0; i < looks; i++) {
    await ui.sleep(1000);
    const t = Date.now();
    const s = await look();
    const ms = Date.now() - t;
    assert(ms < 3000, `${where}: the window took ${ms} ms to answer`);
    seen.push(s);
  }
  assert(seen.every(s => s.now <= 1), `${where}: more than one Now tab: ` + JSON.stringify(seen));
  assert(seen.slice(2).every(s => s.tabs === seen[2].tabs && s.now === seen[2].now), `${where}: the tab strip does not settle: ` + JSON.stringify(seen));
  return seen.at(-1);
}

/** First-run tips point at the tabs and the input box; a person closes them before looking. */
async function closeTips(ui) {
  for (let i = 0; i < 6 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
}

/** The side pane's tab in front (its aria-label, without the count). */
const activeTab = (ui) => ui.eval(`(document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label') || '').trim()`);

// now-stopped.mjs starts its session and reads the tab the same way
export { READ, until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips };

/** A folder `dispatch deliver` makes a page from: notes.md and one picture. */
function deliveryFolder(ui, name, notes, picture) {
  const dir = path.join(ui.rec.root, "deliver", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "notes.md"), notes);
  if (picture && fs.existsSync(picture)) fs.copyFileSync(picture, path.join(dir, "01-now.png"));
  return dir;
}

export default async function (ui) {
  const qa = { checks: [], failed: [], heads: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const read = async (key) => { const s = await ui.eval(READ); if (key) { qa.heads[key] = s; note(); } return s; };
  const waitNow = async (fn, what, ms = 60000) => {
    const t0 = Date.now();
    try {
      return await until(ui, async () => { const s = await ui.eval(READ); return s && fn(s) ? s : null; }, ms, what, 500);
    } finally {
      (qa.waits = qa.waits || []).push([what, Date.now() - t0]);
    }
  };
  /** Both themes, the way a person switches them (Settings › Appearance): light first, the window left light. */
  const shots = async (name) => {
    await closeTips(ui);
    await ui.setTheme("light");
    await ui.sleep(800);
    await ui.screenshot(`${name}-light`);
    await ui.setTheme("dark");
    await ui.sleep(800);
    qa.heads[`${name}-dark`] = await ui.eval(READ);
    await ui.screenshot(`${name}-dark`);
    await ui.setTheme("light");
    await ui.sleep(500);
  };
  /** The common sizes of A4, for every head. */
  const sizes = (s, head) => {
    check(`${head}: no card, no group headings`, !s.oldCard && !s.oldHeads, { card: s.oldCard, heads: s.oldHeads });
    check(`${head}: three lines start 20 px from the pane's edge (8 + 12)`, s.headLeft === 20, s.headLeft);
    check(`${head}: status line 20 high, 12 px`, s.statusH === 20 && /^12px/.test(s.statusFont), { h: s.statusH, font: s.statusFont });
    check(`${head}: the line is 15/600, line height 1.35, at most three lines, 4 under the status`, /^15px\/600\/20\.25px$/.test(s.sayFont) && s.sayLines >= 1 && s.sayLines <= 3 && s.sayGap === 4, { font: s.sayFont, lines: s.sayLines, gap: s.sayGap });
    check(`${head}: engine and model in the status line's tooltip`, /OpenCode|Terminal|·/.test(s.statusTip), s.statusTip);
    check(`${head}: nothing wider than the pane`, !s.overflowX, s.width);
    check(`${head}: every button has a name`, s.unnamed === 0, s.unnamed);
    if (s.tasks.length) {
      check(`${head}: task rows 32 high, title 13/500, count 11 px`, s.tasks.every(t => t.h === 32 && t.titleFont === "13px/500" && (!t.count || t.countFont === "11px/400")), s.tasks);
      check(`${head}: tasks start 24 under the three lines`, s.planGap === 24, s.planGap);
    }
    if (s.steps.length) check(`${head}: steps 28 high`, s.steps.every(x => x.h === 28), s.steps.map(x => x.h));
    for (const b of s.buttons) check(`${head}: button ${b.text} is a 32 high pill, 13/500`, b.h === 32 && b.font === "13px/500" && parseFloat(b.radius) >= 16, b);
    if (s.buttons.length) check(`${head}: the buttons 12 under the line (the why line when there is one, task-39x97)`, s.buttonsGap === 12, s.buttonsGap);
    qa.cut = { ...(qa.cut || {}), [head]: s.cut };
  };

  await offscreen(ui);
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await offscreen(ui);
  await closeTips(ui);
  await ui.sleep(1500);
  // nothing in Next up starts by itself in this run (the things lined up below are only to be shown)
  await cli(ui, {}, "nextup", "pause");

  // 1. the input box on the new-session page: engine in a small block, a block send key, permission in words
  await onDemo(ui);
  await ui.newSession();
  await ui.sleep(1500);
  await toDemo(ui);
  await ui.sleep(1500);
  const box = await ui.eval(`(() => {
    const send = document.querySelector('.sessions-chat-send-button .monaco-button');
    const arrow = document.querySelector('.sessions-chat-send-button .codicon-arrow-up-compact');
    const eng = document.querySelector('.sessions-chat-session-type-picker .action-label > .codicon:first-child, .dispatch-harness-picker > .codicon:first-child');
    const perm = [...document.querySelectorAll('.sessions-chat-dropdown-label')].map(e => e.textContent.trim());
    return { sendRadius: send && getComputedStyle(send).borderRadius, arrowFont: arrow && getComputedStyle(arrow, '::before').fontFamily,
      engineBox: eng && [getComputedStyle(eng).width, getComputedStyle(eng).borderRadius], labels: perm };
  })()`);
  assert(box.sendRadius === "10px", "send key is not a block: " + JSON.stringify(box));
  assert(/dispatch-blocks/.test(box.arrowFont || ""), "send arrow is not Dispatch's: " + JSON.stringify(box));
  assert(box.engineBox && box.engineBox[0] === "18px" && box.engineBox[1] === "5px", "engine is not in a small block: " + JSON.stringify(box));
  if (box.labels.some(l => /Ask Before Edits|Manual permissions|^Default$/i.test(l))) throw new Error("permission still in engine words: " + JSON.stringify(box.labels));
  await closeTips(ui);
  await ui.screenshot("06-input-box");
  await ui.mark({ css: ".sessions-chat-send-button" }, { what: "发送键是方块", where: "输入框右下", how: "在跑时变成呼吸的停止块" });

  // 2. a real session that works for a while: the Now tab's working head
  await onDemo(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type(MESSAGE);
  await ui.press("Enter", { send: true });
  await ui.waitFor({ css: ".sessions-list-control .dispatch-status-blocks.running" }, { timeoutMs: 60000 });
  // the session has started: the window keeps answering, at most one Now tab, the strip settles
  await stripSettles(ui, "as the session starts", 5);
  await ui.openNowTab();
  const first = await ui.eval(`[...document.querySelectorAll('.tabs-container .tab')].map(t => t.getAttribute('aria-label') || t.textContent.trim())[0]`);
  assert(/^Now/.test(first || ""), "Now is not the first tab: " + first);
  // the tab wears a thin pulse line (a label's icon class sits on .monaco-icon-label without .codicon)
  const tabIcon = await ui.eval(`(() => { const l = document.querySelector('.tabs-container .tab .monaco-icon-label.codicon-pulse'); return l ? getComputedStyle(l, '::before').fontFamily : 'missing'; })()`);
  check("the Now tab's icon is the codicon pulse line", /codicon/.test(tabIcon || ""), tabIcon);
  // while the agent works the head says so before anything is on the board: the falling blocks, never "Resting"
  const early = await waitNow(s => s.mode === "working", "the working head");
  check("working, before the agent writes anything: the falling blocks and a line", /dispatch-status-blocks running/.test(early.mark) && /^Working/.test(early.status) && !!early.say && !/Resting|Finished|Looking/.test(early.say), early);
  await ui.screenshot("07-row-working");
  const stop = await ui.eval(`(() => { const s = document.querySelector('.interactive-input-part .chat-execute-toolbar .codicon-stop-circle'); return s ? getComputedStyle(s, '::before').animationName : 'missing'; })()`);
  if (stop !== "missing") assert(/breath/.test(stop), "the stop block does not breathe: " + stop);

  // the agent's board, as an agent in this session writes it: one request done earlier, the one it is on in five steps
  const sid = (await ui.eval(NOW("n.dataset.session"))).replace(/^[a-z][\w+.-]*:\/*/i, "").split("/").pop();
  const agent = { DISPATCH_SESSION_ID: sid };
  const taskOf = async (title) => { const tl = JSON.parse(await cli(ui, agent, "task", "list", "--session", sid, "--json")); return (tl.tasks || tl).find(t => t.title === title).id; };
  await cli(ui, agent, "begin", "Rename the demo button", "-P", "demo", "--session", sid, "-d", "Seeded by session-now: an earlier request of the session, finished.", "-a", "- [ ] renamed");
  const earlier = await taskOf("Rename the demo button");
  await cli(ui, agent, "task", "plan", earlier, "--set", "Find the button", "--set", "Rename it", "--done", "1,2");
  await cli(ui, agent, "done", earlier, "--reason", "Seeded: renamed.");
  await cli(ui, agent, "begin", "Now tab: show the steps on one line", "-P", "demo", "--session", sid, "-d", "Seeded by the session-now scenario: a task with five steps and a delivery.", "-a", "- [ ] the Now tab shows it");
  const tid = await taskOf("Now tab: show the steps on one line");
  await cli(ui, agent, "task", "plan", tid, "--set", "Draw the line", "--set", "Mark each step", "--set", "Hang the sub-agents under it", "--set", "Fold what is over", "--set", "Check on a real session", "--done", "1,2", "--active", "3");
  await cli(ui, agent, "now", "Drawing the steps on one thin line");
  await cli(ui, agent, "task", "deliver", tid, "--url", "https://example.com/steps", "--label", "Steps page");
  const seeded = Date.now();
  const stepped = await waitNow(s => s.mode === "working" && /step 3 of 5/.test(s.status) && s.steps.length === 5 && s.delivered.length === 1, "Working · step 3 of 5", 150000).catch(async e => { qa.heads.workingTimeout = await read(); note(); throw e; });
  qa.seenAfterMs = Date.now() - seeded; // from the last board write to the tab showing it
  qa.heads.workingStepped = stepped;
  // the moment the name promises: it runs, step 3 of 5, a sub-agent working under step 3, the Right now line
  const working = await waitNow(s => s.mode === "working" && /step 3 of 5/.test(s.status) && /^Right now: /.test(s.sub) && s.agents.some(a => a.state === "sub-agent"), "working with a sub-agent under step 3 and Right now", 240000).catch(async e => { qa.heads.workingRightNowTimeout = await read(); note(); throw e; });
  qa.heads.working = working;
  await ui.screenshot("now-working-light");
  fs.writeFileSync(path.join(ui.out, "now-working.json"), JSON.stringify({ at: new Date().toISOString(), head: { mode: working.mode, status: working.status, say: working.say, sub: working.sub }, tasks: working.tasks, steps: working.steps.map(x => ({ kind: x.kind, text: x.text })), agents: working.agents, text: working.text }, null, 1));
  await ui.setTheme("dark");
  await ui.sleep(800);
  const workingDark = await ui.eval(READ);
  fs.writeFileSync(path.join(ui.out, "now-working-dark.json"), JSON.stringify({ at: new Date().toISOString(), head: { mode: workingDark.mode, status: workingDark.status, say: workingDark.say, sub: workingDark.sub }, steps: workingDark.steps.map(x => ({ kind: x.kind, text: x.text })), agents: workingDark.agents }, null, 1));
  check("working, dark: still running with Right now and the sub-agent when shot", workingDark.mode === "working" && /^Right now: /.test(workingDark.sub) && workingDark.agents.some(a => a.state === "sub-agent"), workingDark);
  await ui.screenshot("now-working-dark");
  await ui.setTheme("light");
  check("working: a sub-agent working hangs under the step it is on, indented 22, the 14 px purple filled circle, 12 px", working.agents.some(a => a.state === "sub-agent" && a.inSteps && a.under === "Hang the sub-agents under it" && a.dotW === 14 && /codicon-circle-large-filled .*dispatch-mark sub-agent/.test(a.dot) && a.dotColor === working.tokens.plan && a.indent === 34 && a.font === "12px/400"), working.agents);
  sizes(working, "working");
  check("working: status reads Working · step 3 of 5 · <time>", /^Working · step 3 of 5 · \d+ min$/.test(working.status), working.status);
  check("working: the line is the agent's own", working.say === "Drawing the steps on one thin line", working.say);
  check("working: no buttons", !working.buttons.length, working.buttons);
  check("working: steps done, done, the one it is on, not started, not started", working.steps.map(s => s.kind).join() === "done,done,now,todo,todo", working.steps.map(s => s.kind));
  check("working: VS Code's marks, all 14 px: the grey filled check done, the green filled circle breathing on the step it is on, the grey large ring not started", /codicon-pass-filled .*dispatch-mark seen/.test(working.steps[0].mark.cls) && working.steps[0].mark.w === 14 && working.steps[0].mark.color === working.tokens.text2
    && /codicon-circle-large-filled .*dispatch-mark now live/.test(working.steps[2].mark.cls) && working.steps[2].mark.w === 14 && working.steps[2].mark.color === working.tokens.working && working.steps[2].mark.breath === "dispatch-mark-breathe"
    && /codicon-circle-large .*dispatch-mark todo/.test(working.steps[3].mark.cls) && working.steps[3].mark.w === 14 && working.steps[3].mark.color === working.tokens.text2, { steps: working.steps.map(s => s.mark), tokens: working.tokens });
  check("working: the step it is on is 13/500, the others 13/400", working.steps[2].font === "13px/500" && working.steps[0].font === "13px/400", working.steps.map(s => s.font));
  check("working: one line through the steps", working.steps.every(s => s.line), working.steps.map(s => s.line));
  check("working: the task it is on comes first and open, its count 2 of 5", working.tasks[0] && working.tasks[0].id === tid && working.tasks[0].open === "true" && working.tasks[0].count === "2 of 5", working.tasks);
  check("working: what it delivered is the task's last row, no box", working.delivered.length === 1 && /codicon-link/.test(working.delivered[0].icon) && working.delivered[0].h === 28, working.delivered);
  check("working: the earlier request folded into Done in this session · 1", working.folds.some(f => f.part === "fold-done" && /Done in this session/.test(f.text) && /1$/.test(f.text) && f.open === "false" && f.h === 28 && f.font === "12px/600"), working.folds);
  check("working: no Handed over when nothing was handed over", !working.folds.some(f => f.part === "fold-handoffs") && !/Handed over/.test(working.text), working.folds);
  check("working: Right now is one 12 px line with a 2 s shimmer", /shimmer/.test(working.subClass) && /^Right now: /.test(working.sub) && /dispatch-now-shimmer 2s/.test(working.subAnim), { sub: working.sub, anim: working.subAnim });

  // the caret: the steps fold away in place and come back
  const caret = { css: `.dispatch-now-task[data-task="${tid}"] .dispatch-now-caret` };
  await ui.click(caret);
  await ui.sleep(450);
  const closed = await ui.eval(`(() => { const b = document.querySelector('.dispatch-now-body[data-task="${tid}"]'); return { aria: document.querySelector('.dispatch-now-task[data-task="${tid}"] .dispatch-now-caret').getAttribute('aria-expanded'), open: b.classList.contains('open'), inert: b.inert, h: Math.round(b.getBoundingClientRect().height) }; })()`);
  check("caret click: the steps fold away (aria-expanded false, inert, no height)", closed.aria === "false" && !closed.open && closed.inert && closed.h === 0, closed);
  await ui.click(caret);
  await ui.sleep(450);
  const reopened = await ui.eval(`(() => { const b = document.querySelector('.dispatch-now-body[data-task="${tid}"]'); return { aria: document.querySelector('.dispatch-now-task[data-task="${tid}"] .dispatch-now-caret').getAttribute('aria-expanded'), h: Math.round(b.getBoundingClientRect().height) }; })()`);
  check("caret click again: the steps are back", reopened.aria === "true" && reopened.h >= 6 * 28, reopened);
  // Done in this session opens in place
  await ui.click({ css: '[data-part="fold-done"]' });
  await ui.sleep(450);
  const doneFold = await ui.eval(`(() => { const b = document.querySelector('[data-part="fold-done-body"]'); return { open: b.classList.contains('open'), rows: [...b.querySelectorAll('.dispatch-now-task')].map(t => t.innerText.replace(/\\s+/g, ' ')) }; })()`);
  check("Done in this session opens in place with the earlier request", doneFold.open && doneFold.rows.length === 1 && /Rename the demo button/.test(doneFold.rows[0]) && /Done/.test(doneFold.rows[0]), doneFold);
  await ui.screenshot("07a-now-working-folds-open");
  await ui.click({ css: '[data-part="fold-done"]' });
  await ui.sleep(300);
  await ui.mark({ css: '[data-part="now-head"]' }, { what: "三行头：状态行、Agent 自己写的一句话、Right now", where: "右栏 Now 最上面", how: "在做时状态行写第几步和多久" });
  await ui.mark({ css: '[data-part="steps"]' }, { what: "一条步骤线：做完灰色实心圆勾、正在做绿色实心大圆、没做大空心圈（VS Code 的圆形状态图标）", where: "任务行下面", how: "点任务前的箭头收起展开" });

  // reduce motion: the shimmer and the ping stand still, the blocks stop falling
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ui.sleep(7000);
  const still = await ui.eval(`(() => { const n = document.querySelector('.dispatch-now-tab'); const sub = n.querySelector('.dispatch-now-sub'); const ping = n.querySelector('.dispatch-mark.now'); return { sub: sub ? getComputedStyle(sub).animationName : 'none', ping: ping ? getComputedStyle(ping).animationName : 'none', caret: getComputedStyle(n.querySelector('.dispatch-now-caret .codicon')).transitionDuration, body: getComputedStyle(n.querySelector('.dispatch-now-body')).transitionDuration, blocks: n.querySelector('.dispatch-now-status .dispatch-status-blocks')?.className || '' }; })()`);
  check("reduce motion: no shimmer, the step it is on holds still, no fold or caret motion", still.sub === "none" && still.ping === "none" && /^0s/.test(still.caret) && /^0s/.test(still.body), still);
  check("reduce motion: the session's blocks stand still", /still|^$/.test(still.blocks), still.blocks);
  await ui.cdp.send("Emulation.setEmulatedMedia", { features: [] });

  // the task's title shows it in place, in Tasks
  await ui.click({ css: `.dispatch-now-task[data-task="${tid}"] .dispatch-now-title` });
  await until(ui, async () => /^Tasks/.test(await activeTab(ui)), 20000, "the Tasks tab after clicking the task's title", 300).then(() => check("the task's title opens it in Tasks, in the side pane", true)).catch(async () => check("the task's title opens it in Tasks, in the side pane", false, await activeTab(ui)));
  await ui.openNowTab();

  // the sub-agents back: one row "2 finished" under the step, it opens in place, a click opens what one did
  const back = await waitNow(s => !s.agents.some(a => a.state === "sub-agent") && /^2 finished$/.test(s.finished), "2 finished under the step", 900000).catch(async e => { qa.heads.finishedTimeout = await read(); note(); throw e; });
  qa.heads.finished = back;
  check("both back: one row 2 finished, no sub-agent rows shown", back.finished === "2 finished" && back.agents.length === 0, { finished: back.finished, agents: back.agents });
  await ui.screenshot("07b-now-2-finished");
  await ui.click({ css: '[data-part="finished"]' });
  await ui.sleep(450);
  const listed2 = await ui.eval(READ);
  qa.heads.finishedOpen = listed2;
  check("2 finished opens in place: the two with the grey filled check, under the step", listed2.agents.length === 2 && listed2.agents.every(a => a.state === "done" && /codicon-pass-filled .*dispatch-mark seen/.test(a.dot) && a.under === "Hang the sub-agents under it") && listed2.agents.some(a => /Count to 1500 A/.test(a.text)) && listed2.agents.some(a => /Count to 1500 B/.test(a.text)), listed2.agents);
  await ui.screenshot("07c-now-finished-open");
  fs.writeFileSync(path.join(ui.out, "now-subagents.json"), JSON.stringify({ working: working.agents, back: { finished: back.finished, agents: back.agents }, opened: listed2.agents }, null, 1));
  await ui.click({ text: "Count to 1500 A", within: '.dispatch-now-tab [data-part="steps"]' });
  const opened = await until(ui, () => ui.eval(`(() => {
    const req = [...document.querySelectorAll('.interactive-request')].filter(e => e.offsetParent).map(e => e.innerText).join(' ');
    return /SUBCOUNT A/.test(req) && !/Use your task tool/.test(req) ? req.slice(0, 200) : null;
  })()`), 30000, "the sub-agent's own conversation", 500).catch(() => null);
  check("a click on a sub-agent opens its own conversation (its prompt, not the session's)", !!opened, opened);
  await ui.screenshot("07d-subagent-opened");
  await ui.openNowTab();

  // 3. done: the reply is in. The agent finishes the task with a delivery page; things wait in line in the project; the
  // work was handed over once
  await waitNow(s => s.mode !== "working", "the session to finish its turn", 900000);
  // paused: the turn is over while the task it is on still has steps left. Not done: a hollow circle where it stopped,
  // Reply and See changes, no solid button, no green dot anywhere
  const paused = await waitNow(s => s.mode === "paused" && s.buttons.length === 2, "the paused head", 60000).catch(async e => { qa.heads.pausedTimeout = await read(); note(); throw e; });
  qa.heads.paused = paused;
  sizes(paused, "paused");
  check("paused: status reads Paused · step 3 of 5 · <time> ago", /^Paused · step 3 of 5 · (just now|\d+ min ago)$/.test(paused.status), paused.status);
  check("paused: the 14 px grey large ring in front", /codicon-circle-large .*dispatch-mark stop/.test(paused.mark) && paused.markW === 14 && paused.markColor === paused.tokens.text2, { mark: paused.mark, color: paused.markColor });
  check("paused: the agent's own line", paused.say === "Drawing the steps on one thin line", paused.say);
  check("paused: Reply (outline) and See changes (ghost), no solid button", paused.buttons.map(b => `${b.text}:${b.kind}`).join() === "Reply:outline,See changes:ghost", paused.buttons);
  check("paused: the steps stop at step 3, the large ring in strong words, no green circle", paused.steps.map(x => x.kind).join() === "done,done,stop,todo,todo" && paused.steps[2].font === "13px/500" && paused.steps[2].mark.w === 14 && /codicon-circle-large .*dispatch-mark stop/.test(paused.steps[2].mark.cls) && !/live/.test(paused.steps[2].mark.cls), paused.steps);
  const stopAria = await ui.eval(`(document.querySelector('[data-part="now-plan"] [data-part="steps"] .dispatch-now-step.stop') || {}).ariaLabel || ''`);
  check("paused: the step says Stopped here to a screen reader", /^Stopped here: Hang the sub-agents under it$/.test(stopAria), stopAria);
  check("paused: no green circle in the tab", !(await ui.eval(`!!document.querySelector('.dispatch-now-tab .dispatch-mark.now')`)));
  await shots("now-paused");
  await ui.click({ text: "Reply", exact: true, within: '[data-part="now-head"]' });
  const pausedReply = await until(ui, () => ui.eval(`!!document.activeElement && !!document.activeElement.closest('.interactive-input-part, .sessions-chat-editor, .chat-input-container')`), 10000, "the cursor in the message box", 300).catch(() => false);
  check("paused: Reply puts the cursor in the message box", !!pausedReply);
  await ui.openNowTab();
  // what was noted from the chat (the counting, capture.py) is over too: closed before the task the agent was on
  const listed = JSON.parse(await cli(ui, agent, "task", "list", "--session", sid, "--json"));
  for (const t of (listed.tasks || listed).filter(t => t.status !== "done" && t.id !== tid)) await cli(ui, agent, "done", t.id, "--reason", "Seeded: the counting is over.");
  await cli(ui, agent, "task", "plan", tid, "--done", "3,4,5");
  await cli(ui, agent, "now", "The steps of a task are one thin line under it now");
  const page = deliveryFolder(ui, "now-impl", "# Steps on one line\n\nThe steps of a task are one thin line under it now.\n\n![Working](01-now.png)\n", path.join(ui.out, "now-working-light.png"));
  await cli(ui, agent, "deliver", tid, "--from", page, "--model", "session-now · e2e");
  await cli(ui, agent, "done", tid, "--reason", "Seeded: delivered.");
  for (const [i, t] of [["1", "Bring the notes back after a reload"], ["2", "Rewrite the docs-tabs scenario"]]) {
    await bd(ui, "create", t, "-t", "task", "-p", "2", "--json", "-l", "from-chat,project:demo,nextup", "--metadata", JSON.stringify({ nextup: Number(i) }));
  }
  const notes = path.join(ui.rec.root, "deliver", "handoff.md");
  fs.writeFileSync(notes, "# Handoff\n\n## Goal\n\nThe Now tab draws the steps of a task on one line.\n\n## Completed\n\n- changed src/now.ts, 12 tests passed\n\n## Next\n\nCheck them on a real session.\n");
  await cli(ui, agent, "handoff", "write", tid, "--session", sid, "--from", notes).catch(e => qa.checks.push("handoff write did not take: " + String(e.message || e).slice(0, 200)));
  const done = await waitNow(s => s.mode === "done" && s.buttons.length === 2 && s.folds.some(f => f.part === "fold-next") && s.folds.some(f => f.part === "fold-handoffs"), "the done head with its buttons, Next in demo and Handed over", 90000).catch(async e => { qa.heads.doneTimeout = await read(); note(); throw e; });
  qa.heads.done = done;
  sizes(done, "done");
  check("done: status reads Done · <time> ago", /^Done · (just now|\d+ min ago)$/.test(done.status), done.status);
  check("done: the 14 px filled check in the done colour", /codicon-pass-filled .*dispatch-mark done/.test(done.mark) && done.markW === 14 && done.markColor === done.tokens.done, { mark: done.mark, w: done.markW, color: done.markColor, token: done.tokens.done });
  check("done: Open delivery page (outline) and See changes (ghost)", done.buttons.map(b => `${b.text}:${b.kind}`).join() === "Open delivery page:outline,See changes:ghost", done.buttons);
  check("done: the finished task stays the first row, open, counted Done", done.tasks[0] && done.tasks[0].id === tid && done.tasks[0].count === "Done" && done.tasks[0].open === "true", done.tasks);
  check("done: its deliveries are its last rows (the link, the page)", done.delivered.length === 2 && done.delivered.some(d => /Delivery page/.test(d.text) && /codicon-file/.test(d.icon)), done.delivered);
  check("done: Next in demo · 2", done.folds.some(f => f.part === "fold-next" && /Next in demo/.test(f.text) && /2$/.test(f.text)), done.folds);
  const handed = done.folds.find(f => f.part === "fold-handoffs");
  if (handed) check("done: handed over once, one folded row", /Handed over/.test(handed.text) && /1$/.test(handed.text) && handed.open === "false", handed);
  else qa.checks.push("handed over: the handoff did not reach the board in this run (no row, as when nothing was handed over)");
  // the folds open in place
  await ui.click({ css: '[data-part="fold-next"]' });
  await ui.sleep(450);
  const next = await ui.eval(`[...document.querySelectorAll('[data-part="fold-next-body"] .dispatch-now-rowbtn')].map(b => b.textContent)`);
  check("Next in demo opens in place: the two things in line", next.length === 2 && /Bring the notes back/.test(next.join()), next);
  if (handed) {
    await ui.click({ css: '[data-part="fold-handoffs"]' });
    await ui.sleep(450);
    const rows = await ui.eval(`[...document.querySelectorAll('[data-part="fold-handoffs-body"] .dispatch-now-step')].map(b => b.textContent)`);
    check("Handed over opens in place, with how long ago", rows.length === 1 && /fresh session.*along(now|\d+m)$/.test(rows[0]), rows);
  }
  await ui.screenshot("08a-now-done-folds-open");
  await ui.click({ css: '[data-part="fold-next"]' });
  if (handed) await ui.click({ css: '[data-part="fold-handoffs"]' });
  await ui.sleep(300);
  await shots("now-done");
  // Open delivery page: the page opens in the side pane, the way its delivery row opens it
  await ui.click({ text: "Open delivery page", exact: true, within: '[data-part="now-head"]' });
  const afterPage = await until(ui, async () => { const t = await activeTab(ui); return t && t !== "Now" ? t : null; }, 30000, "a tab with the delivery page", 300).catch(() => "");
  check("Open delivery page opens the page in a tab of the side pane", !!afterPage, afterPage);
  await ui.screenshot("08b-delivery-page-opened");
  await ui.openNowTab();
  await ui.click({ text: "See changes", exact: true, within: '[data-part="now-head"]' });
  const afterChanges = await until(ui, async () => { const t = await activeTab(ui); return /^Changes/.test(t) ? t : null; }, 20000, "the Changes tab", 300).catch(async () => await activeTab(ui));
  check("See changes shows the Changes tab", /^Changes/.test(afterChanges || ""), afterChanges);
  await ui.openNowTab();

  // 4. waiting for you: the agent puts two directions in front of the person and stops
  await cli(ui, agent, "begin", "Pick the icon set", "-P", "demo", "--session", sid, "-d", "Seeded by session-now: a proposal waits for the person.", "-a", "- [ ] picked");
  const pick = await taskOf("Pick the icon set");
  await cli(ui, agent, "task", "plan", pick, "--set", "Shoot the four sets", "--set", "Wait for the pick", "--set", "Change the code", "--done", "1", "--active", "2");
  const proposal = deliveryFolder(ui, "icons", "# Pick the icon set\n\nTwo ways to draw the marks.\n\n## Direction A: Thin lines\n\n![A](01-now.png)\n\n## Direction B: Thin lines with dots\n\nThe dots carry the state.\n", path.join(ui.out, "now-done-light.png"));
  await cli(ui, agent, "deliver", pick, "--from", proposal, "--kind", "proposal", "--model", "session-now · e2e");
  // the board says the task waits a moment before Waiting for you has its row: the head is read once both are in
  const waiting = await waitNow(s => s.mode === "waiting" && s.buttons.length === 2 && s.steps.length === 3 && / · /.test(s.status), "the waiting head with Open proposal", 90000).catch(async e => { qa.heads.waitingTimeout = await read(); note(); throw e; });
  qa.heads.waiting = waiting;
  sizes(waiting, "waiting");
  check("waiting: status reads Waiting for you · <time>", /^Waiting for you · \d+ min$/.test(waiting.status), waiting.status);
  check("waiting: the 14 px amber filled circle", /codicon-circle-large-filled .*dispatch-mark waiting/.test(waiting.mark) && waiting.markW === 14 && waiting.markColor === waiting.tokens.waiting, { mark: waiting.mark, color: waiting.markColor });
  check("waiting: Open proposal is the one solid button, Reply outline", waiting.buttons.map(b => `${b.text}:${b.kind}`).join() === "Open proposal:fill,Reply:outline", waiting.buttons);
  check("waiting: the step that waits is the amber filled circle", waiting.steps.map(s => s.kind).join() === "done,ask,todo" && waiting.steps[1].mark.w === 14 && /dispatch-mark waiting/.test(waiting.steps[1].mark.cls) && waiting.steps[1].mark.color === waiting.tokens.waiting, waiting.steps);
  check("waiting: what was done before is folded (Done in this session · 2)", waiting.folds.some(f => f.part === "fold-done" && Number((f.text.match(/(\d+)$/) || [])[1]) >= 2), waiting.folds);
  await shots("now-waiting");
  await ui.click({ text: "Open proposal", exact: true, within: '[data-part="now-head"]' });
  const afterProposal = await until(ui, async () => { const t = await activeTab(ui); return t && t !== "Now" ? t : null; }, 30000, "the proposal's tab", 300).catch(() => "");
  check("Open proposal opens the proposal in the side pane", !!afterProposal, afterProposal);
  await ui.screenshot("09b-proposal-opened");
  await ui.openNowTab();
  await ui.click({ text: "Reply", exact: true, within: '[data-part="now-head"]' });
  const focused = await until(ui, () => ui.eval(`!!document.activeElement && !!document.activeElement.closest('.interactive-input-part, .sessions-chat-editor, .chat-input-container')`), 10000, "the cursor in the message box", 300).catch(() => false);
  check("Reply puts the cursor in the message box", !!focused, await ui.eval(`document.activeElement ? document.activeElement.className : ''`));

  // 5. a session in the terminal: what Dispatch can see of it, the last line it printed
  if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('.part.editor')`)) await ui.click({ css: ".part.sessionspart", webview: false });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "t", code: "KeyT", windowsVirtualKeyCode: 84, modifiers: 4 });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "t", code: "KeyT", windowsVirtualKeyCode: 84, modifiers: 4 });
  await ui.waitFor({ css: ".dispatch-new-picker" }, { timeoutMs: 15000 });
  await ui.click({ text: "Blank terminal", within: ".dispatch-new-picker" });
  for (const t = Date.now(); Date.now() - t < 40000 * SCALE; await ui.sleep(500)) {
    if (await ui.exists("Use your Ghostty look in Dispatch's terminal?")) await ui.click({ text: "Not now", exact: true });
    if (await ui.exists({ css: ".dispatch-terminal-view .dispatch-xterm .xterm-screen" })) break;
  }
  await ui.sleep(2000);
  await ui.click({ css: ".dispatch-terminal-view .dispatch-xterm .xterm-screen" });
  await ui.cdp.send("Input.insertText", { text: "echo Applied 3 edits to src/reader.ts" });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await ui.openNowTab();
  const term = await waitNow(s => s.mode === "terminal" && /Applied 3 edits/.test(s.sub), "the terminal head with its last line", 60000).catch(async e => { qa.heads.terminalTimeout = await read(); note(); throw e; });
  qa.heads.terminal = term;
  sizes(term, "terminal");
  check("terminal: status reads In the terminal · <time>", /^In the terminal · \d+ min$/.test(term.status), term.status);
  check("terminal: the >_ mark, 14 px", /dispatch-now-term/.test(term.mark) && term.markW === 14, term.mark);
  check("terminal: the last line in the mono font, 12 px", /mono/.test(term.subClass) && /^12px/.test(term.subFont) && !/-apple-system|system-ui/.test(term.subFont), term.subFont);
  check("terminal: a plain terminal says so", /A terminal in this project/.test(term.say), term.say);
  await shots("now-terminal");

  note();
  if (qa.failed.length) throw new Error(`failed: ${qa.failed.join("; ")}`);
}
