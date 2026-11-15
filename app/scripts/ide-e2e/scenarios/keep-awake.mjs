// Keep awake (kanban task-vggq; app/cli/awake.py, Dispatch IDE patches/510-settings.patch and
// 120-status-bar.patch): the Mac is held awake only while an agent works or a phone is connected, in the
// mode Settings › Keep awake picks, and the bottom bar's cup shows exactly that. The way a person meets it: a real
// session with a cheap model starts working, the background service holds the Mac (caffeinate), the cup comes up
// and says why; the cup's panel leads to Settings › Keep awake, which says the same; "Keep the screen on too" holds
// the screen as well; "Let the Mac sleep" lets go at once and the cup goes; once the agent is done the Mac is let go.
// Only OpenCode with a flash or free model is ever used. Writes facts.json next to the screenshots.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { needs: ['opencode'],
  title: "防休眠只在 Agent 干活时",
  description: "便宜模型真跑一条会话：干活时 Mac 不睡、底栏出现杯子并说明原因；杯子面板进设置 Keep awake，同一个状态；切屏幕常亮、切不防休眠杯子马上跟着变；干完活放手。",
  timeout: 900, // a real agent job long enough to still be working when the screen-on switch is made
};

const BAR = ".dispatch-status-bar";
const CUP = `${BAR} [data-part="keep-awake"]`;
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

function cli(ui, args) {
  const env = { ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_DIR: ui.rec.dispatch_dir,
    BEADS_DIR: ui.rec.beads_dir, DISPATCH_FACTS_FILE: path.join(ui.rec.root, "rules/FACTS.md") };
  return JSON.parse(execFileSync("python3", [ui.rec.cli, ...args, "--json"], { env, cwd: ui.demoFolder, encoding: "utf8", timeout: 90000 }));
}
/** The caffeinate processes this instance's background service holds, with their flags (-is: the Mac; -dis: the
 *  screen too). Only those whose parent runs for this instance (DISPATCH_SESSION_ROOT in its environment): the
 *  person's own Dispatch on this Mac may hold one of its own at the same time. */
const caffeinates = (ui) => (spawnSync("pgrep", ["-lf", "caffeinate"], { encoding: "utf8" }).stdout || "").split("\n").filter(l => /caffeinate -d?is/.test(l)).map(l => l.trim())
  .filter(l => {
    const ppid = (spawnSync("ps", ["-o", "ppid=", "-p", l.split(/\s+/)[0]], { encoding: "utf8" }).stdout || "").trim();
    const env = ppid ? spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", ppid], { encoding: "utf8" }).stdout || "" : "";
    return env.includes(`DISPATCH_SESSION_ROOT=${ui.rec.root}`);
  });
const cupShown = (ui) => ui.eval(`(() => { const e = document.querySelector('${CUP}'); return !!e && !e.hidden && !!e.offsetParent; })()`);
const hoverText = (ui) => ui.eval(`[...document.querySelectorAll('.monaco-hover, .workbench-hover')].filter(h => h.offsetParent).map(h => h.innerText.trim()).join('\\n')`);

async function until(ui, what, fn, timeoutMs, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs * SCALE) throw new Error(`${what}: not after ${Math.round(timeoutMs / 1000)} s`);
    await ui.sleep(every);
  }
}

async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
}

async function settingsTitle(ui) {
  return ui.eval(`document.querySelector('.custom-view-node[data-view-id="dispatch.settings"] .custom-view-header-title')?.textContent || ''`);
}

async function pickAwake(ui, mode) {
  await ui.click({ css: `.dset-choice[data-awake="${mode}"]`, webview: false });
  await until(ui, `Keep awake ${mode} saved`, async () => cli(ui, ["awake"]).mode === mode, 20000, 700);
  await ui.sleep(1200);
}

// ---- the cheap model, picked the way a person does it: /model in the input box (as notify-sleep.mjs) ----
async function untilFn(ui, fn, timeoutMs, what, every = 1000) {
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
const waitMenu = (ui, check, what, timeoutMs = 15000) => untilFn(ui, async () => { const m = await readMenu(ui); return m && !(await ui.exists({ css: `${MENU} .dsm-loading` })) && check(m) ? m : null; }, timeoutMs, `menu: ${what}`, 300);
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
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, "facts.json"), JSON.stringify(facts, null, 2));
  try {
    await run(ui, facts);
  } finally {
    save();
  }
}

async function run(ui, facts) {
  // no tips in the way (this instance's own settings)
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const st = dir && path.join(dir, "User", "settings.json");
    if (st && fs.existsSync(st)) { const j = JSON.parse(fs.readFileSync(st, "utf8") || "{}"); j["dispatch.tips.enabled"] = false; fs.writeFileSync(st, JSON.stringify(j, null, 1)); }
  }
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await ui.waitFor({ css: BAR }, { timeoutMs: 60000 });
  await ui.sleep(4000);
  await closeTips(ui);

  // 0. the default: keep the Mac awake while agents work; the background service of this instance makes its passes
  facts.before = await until(ui, "the background service's first pass", async () => { const s = cli(ui, ["awake"]); return s.running ? s : null; }, 90000, 2000);
  assert(facts.before.mode === "system", `Keep awake starts as ${facts.before.mode}, not system`);
  facts.cupBefore = await cupShown(ui);
  // with nothing working on this Mac nothing holds it, and there is no cup
  if (!facts.before.working && !facts.before.holding) assert(!facts.cupBefore, "the cup shows while nothing works");
  await ui.screenshot("01-idle-no-cup");

  // 1. a real session with a cheap model: the Mac is held while it works
  await ui.newSession();
  await closeTips(ui);
  await ui.pickEngine("OpenCode", 180000);
  const cheap = await chooseCheapModel(ui, ".sessions-chat-editor");
  facts.model = `${cheap.name} (${cheap.desc})`;
  await focusInput(ui, ".sessions-chat-editor");
  // a job of a known length: a fast model wrote 3000 lines before the screen-on switch could be tried
  await ui.type("Run the shell command `sleep 100` once and wait for it to finish. Then write AWAKE DONE. Do nothing else.");
  const sentAt = Date.now();
  await ui.press("Enter", { send: true });

  facts.held = await until(ui, "the Mac held awake while the agent works", async () => { const s = cli(ui, ["awake"]); return s.holding ? s : null; }, 90000, 1500);
  facts.heldAfterSeconds = Math.round((Date.now() - sentAt) / 1000);
  assert(facts.held.reason === "working", `held for "${facts.held.reason}", not an agent working`);
  facts.caffeinateSystem = caffeinates(ui);
  assert(facts.caffeinateSystem.some(l => /caffeinate -is /.test(l)), `no caffeinate -is: ${facts.caffeinateSystem.join(" | ")}`);
  await until(ui, "the cup in the bottom bar", () => cupShown(ui), 40000, 700);
  facts.cupAfterSeconds = Math.round((Date.now() - sentAt) / 1000);
  await ui.hover({ css: CUP });
  await ui.sleep(1400);
  facts.cupTip = await hoverText(ui);
  assert(/stays awake while agents work/.test(facts.cupTip), `the cup's tip: ${facts.cupTip}`);
  assert(!/window is open/.test(facts.cupTip), `the cup still says it holds while the window is open: ${facts.cupTip}`);
  await ui.screenshot("02-working-cup");
  await ui.mark({ css: CUP }, { what: "Agent 在干活，Mac 不睡", where: "底栏右边的杯子", how: "悬停看原因，点开看详情" });

  // 2. the cup's panel, and from it Settings › Keep awake: the same state
  await ui.click({ css: CUP });
  await ui.waitFor({ css: ".dispatch-status-panel.awake" }, { timeoutMs: 5000 });
  facts.cupPanel = await ui.eval(`document.querySelector('.dispatch-status-panel.awake').innerText.replace(/\\s+/g, ' ').trim()`);
  assert(/until the last agent finishes/.test(facts.cupPanel), `the cup's panel: ${facts.cupPanel}`);
  await ui.screenshot("03-cup-panel");
  await ui.mark({ css: ".dispatch-status-panel.awake" }, { what: "为什么不睡、什么时候放手", where: "点底栏杯子", how: "Keep awake settings 进设置" });
  await ui.click({ text: "Keep awake settings", within: ".dispatch-status-panel.awake" });
  await until(ui, "Settings › Keep awake", async () => /Keep awake$/.test(await settingsTitle(ui)), 15000, 300);
  await until(ui, "the page says what it holds", () => ui.eval(`/Awake right now|Nothing is working/.test(document.querySelector('.dset-hero')?.innerText || '')`), 15000, 500);
  facts.heroWorking = await ui.eval(`document.querySelector('.dset-hero')?.innerText.replace(/\\s+/g, ' ').trim()`);
  facts.pickedOnPage = await ui.eval(`document.querySelector('.dset-choice[data-awake][aria-checked="true"]')?.dataset.awake || ''`);
  assert(facts.pickedOnPage === "system", `the page has ${facts.pickedOnPage} picked, the CLI ${facts.held.mode}`);
  await ui.screenshot("04-settings-awake-now");
  await ui.mark({ css: ".dset-hero" }, { what: "设置页说的和杯子一样", where: "设置 › Keep awake", how: "底栏杯子面板点 Keep awake settings" });

  // 3. screen on too: the background service takes a caffeinate that holds the screen, the cup says so
  facts.beforeScreenOn = cli(ui, ["awake"]);
  assert(facts.beforeScreenOn.working > 0, `the agent finished ${Math.round((Date.now() - sentAt) / 1000)} s after the message, before the screen-on switch could be tried: give it a longer job`);
  await pickAwake(ui, "display");
  facts.caffeinateDisplay = await until(ui, "caffeinate -dis", async () => { facts.awakeScreenOn = cli(ui, ["awake"]); const c = caffeinates(ui); return c.some(l => /caffeinate -dis /.test(l)) ? c : null; }, 45000, 1500);
  await until(ui, "the cup says the screen too", async () => {
    if (!(await cupShown(ui))) return false;
    await ui.hover({ css: CUP });
    await ui.sleep(1200);
    facts.cupTipScreen = await hoverText(ui);
    return /its screen stay awake/.test(facts.cupTipScreen);
  }, 45000, 1500);
  await ui.screenshot("05-screen-on-too");

  // 4. let the Mac sleep: nothing holds it any more and the cup goes at once, while the agent still works
  await pickAwake(ui, "off");
  facts.off = cli(ui, ["awake"]);
  assert(!facts.off.holding && facts.off.mode === "off", `after Let the Mac sleep: ${JSON.stringify(facts.off)}`);
  await until(ui, "the cup gone after Let the Mac sleep", async () => !(await cupShown(ui)), 10000, 500);
  facts.heroOff = await ui.eval(`document.querySelector('.dset-hero-h')?.textContent`);
  await ui.screenshot("06-let-it-sleep");
  await pickAwake(ui, "system");

  // 5. the agent finishes: the Mac is let go a little later (the hold lasts 90 s after the last pass that saw work)
  await ui.press("Escape");
  await ui.sleep(1500);
  await until(ui, "the agent done", async () => {
    if (await ui.eval(`/AWAKE DONE/.test([...document.querySelectorAll('.interactive-list')].map(e => e.innerText).join(' '))`)) return (facts.doneBy = "reply");
    const s = cli(ui, ["awake"]);
    return Date.now() - sentAt > 30000 && !s.working ? (facts.doneBy = "nothing working") : null;
  }, 600000, 3000);
  facts.doneAfterSeconds = Math.round((Date.now() - sentAt) / 1000);
  const doneAt = Date.now();
  facts.after = await until(ui, "the Mac let go after the agent finished", async () => {
    const s = cli(ui, ["awake"]);
    if (s.working > 0) { facts.otherAgentsWorking = s.working; return Date.now() - doneAt > 60000 ? s : null; } // another agent on this Mac works
    return s.holding ? null : s;
  }, 180000, 3000);
  facts.letGoAfterSeconds = Math.round((Date.now() - doneAt) / 1000);
  if (!facts.after.holding) {
    await until(ui, "the cup gone once nothing works", async () => !(await cupShown(ui)), 40000, 1000);
    facts.cupGone = true;
  }
  await ui.screenshot("07-done-let-go");
}
