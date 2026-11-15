// The cup's panel sets Keep awake right there (design/awake-card): the bottom bar's cup, clicked, shows what is held and
// why, with the two switches of Settings › Keep awake (keep the Mac awake; the screen too). Each switch takes at once:
// the panel's words change, the setting (`dispatch.keepAwake`) and the CLI's keep_awake follow, the background service
// holds in the new mode; Settings › Keep awake shows the same, and a change on the page shows in the panel.
// The agent at work is the fixture's (fixtures/awake_card.py): no model is asked, and its caffeinate is a stand-in, so
// the Mac's sleep and screen are never held. Writes facts.json and the panel's boxes (for crops) next to the shots.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = {
  title: "Awake 卡片里直接设置",
  description: "底栏杯子点开的卡片里有防休眠的两个开关，拨了立即生效、文字跟着变，和设置页 Keep awake 两边同步。",
  instance: { fixture: "awake-card" },
  timeout: 600,
};

const BAR = ".dispatch-status-bar";
const CUP = `${BAR} [data-part="keep-awake"]`;
const PANEL = ".dispatch-status-panel.awake";
const KEEP = `${PANEL} .dispatch-awake-switch-row[data-awake="keep"]`;
const SCREEN = `${PANEL} .dispatch-awake-switch-row[data-awake="screen"]`;
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

const cliEnv = (ui) => ({ ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_DIR: ui.rec.dispatch_dir,
  BEADS_DIR: ui.rec.beads_dir, HOME: ui.rec.fake_home, DISPATCH_FACTS_FILE: path.join(ui.rec.root, "rules/FACTS.md") });
function cli(ui, args) {
  return JSON.parse(execFileSync("python3", [ui.rec.cli, ...args, "--json"], { env: cliEnv(ui), cwd: ui.rec.root, encoding: "utf8", timeout: 90000 }));
}
/** `dispatch.keepAwake` as the Agents window's own settings file has it now. */
function setting(ui) {
  for (const dir of [ui.rec.agents_user_data_dir, ui.rec.user_data_dir]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, "User", "settings.json"), "utf8") || "{}")["dispatch.keepAwake"];
      if (v !== undefined) return v;
    } catch { /* the next one */ }
  }
  return "(unset)";
}
const fakeCalls = (ui) => fs.readFileSync(ui.rec.caffeinate_log, "utf8").split("\n").filter(Boolean);
/** Real caffeinate processes whose parent runs for this instance: there must be none (the stand-in execs `sleep`). */
const realCaffeinates = (ui) => (spawnSync("pgrep", ["-lf", "caffeinate"], { encoding: "utf8" }).stdout || "").split("\n").map(l => l.trim()).filter(l => /^\d+ (\/usr\/bin\/)?caffeinate /.test(l))
  .filter(l => {
    const ppid = (spawnSync("ps", ["-o", "ppid=", "-p", l.split(/\s+/)[0]], { encoding: "utf8" }).stdout || "").trim();
    const env = ppid ? spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", ppid], { encoding: "utf8" }).stdout || "" : "";
    return env.includes(`DISPATCH_SESSION_ROOT=${ui.rec.root}`) || env.includes(`DISPATCH_DIR=${ui.rec.dispatch_dir}`);
  });
const cupShown = (ui) => ui.eval(`(() => { const e = document.querySelector('${CUP}'); return !!e && !e.hidden && !!e.offsetParent; })()`);
const panel = (ui) => ui.eval(`(() => {
  const p = document.querySelector('${PANEL}');
  if (!p || !p.offsetParent) return null;
  const sw = id => { const r = p.querySelector('.dispatch-awake-switch-row[data-awake="' + id + '"]'); return r ? { on: r.getAttribute('aria-checked') === 'true', enabled: !r.disabled } : null; };
  const box = (p.closest('.monaco-hover') || p).getBoundingClientRect();
  return { mode: p.dataset.mode, head: p.querySelector('.dispatch-status-prow-title')?.textContent || '', sub: p.querySelector('.dispatch-status-prow-sub')?.textContent || '',
    keep: sw('keep'), screen: sw('screen'), links: [...p.querySelectorAll('a')].map(a => a.textContent), text: p.innerText.replace(/\\s+/g, ' ').trim(),
    box: { x: box.x, y: box.y, w: box.width, h: box.height, dpr: devicePixelRatio } };
})()`);

async function until(ui, what, fn, timeoutMs, every = 300) {
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
async function openCard(ui) {
  if (!(await panel(ui))) await ui.click({ css: CUP });
  return until(ui, "the cup's panel", () => panel(ui), 5000);
}
async function closeCard(ui) {
  if (await panel(ui)) await ui.press("Escape");
  await until(ui, "the panel closed", async () => !(await panel(ui)), 5000);
}
/** Flip a switch in the panel; the panel's words must change within a second (they follow the setting, not the service). */
async function flip(ui, facts, step, sel, want) {
  const before = await panel(ui);
  // in the page: from the mouse going down on the switch to the panel's words in the new mode
  await ui.eval(`(() => {
    const p = document.querySelector('${PANEL}'), row = document.querySelector('${sel}');
    window.__awake = { down: 0, words: 0 };
    row.addEventListener('mousedown', () => { window.__awake.down = performance.now(); }, { once: true });
    new MutationObserver((_, o) => { if (p.dataset.mode === '${want}') { window.__awake.words = performance.now(); o.disconnect(); } }).observe(p, { attributes: true, attributeFilter: ['data-mode'] });
  })()`);
  const t0 = Date.now();
  await ui.click({ css: sel });
  const after = await until(ui, `${step}: the panel says ${want}`, async () => { const p = await panel(ui); return p && p.mode === want ? p : null; }, 3000, 50);
  const ms = Date.now() - t0;
  const inPage = await ui.eval(`(() => { const a = window.__awake; return a.down && a.words ? Math.round((a.words - a.down) * 10) / 10 : null; })()`);
  const settingNow = await until(ui, `${step}: the setting is ${want}`, async () => setting(ui) === want ? want : null, 5000, 100);
  const cliNow = await until(ui, `${step}: the CLI has ${want}`, async () => { const s = cli(ui, ["awake"]); return s.mode === want ? s : null; }, 60000, 700);
  facts.steps.push({ step, from: before.mode, to: want, headBefore: before.head, headAfter: after.head, sub: after.sub, keep: after.keep, screen: after.screen,
    wordsChangedInMs: inPage, clickRoundTripMs: ms, setting: settingNow, cliMode: cliNow.mode, cupShownWhileOpen: await cupShown(ui) });
  assert(after.head !== before.head, `${step}: the panel's head did not change (${after.head})`);
  return after;
}
const PAGE_TEXT = "(document.querySelector('.dispatch-settings-page')?.innerText || '')";
async function openSettingsAwake(ui) {
  if (!(await ui.exists({ css: ".dispatch-settings-nav", webview: false }))) await ui.press("Cmd+,");
  await ui.waitFor({ css: ".dispatch-settings-nav", webview: false }, { timeoutMs: 20000 });
  await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="awake"]`, webview: false });
  await until(ui, "Settings › Keep awake", async () => (await ui.eval(PAGE_TEXT)).includes("While an agent works or your phone is connected"), 20000);
  await ui.sleep(600);
}
const pagePicked = (ui) => ui.eval(`document.querySelector('.dset-choice[data-awake][aria-checked="true"]')?.dataset.awake || ''`);
const pageHero = (ui) => ui.eval(`document.querySelector('.dset-hero-h')?.textContent || ''`);

export default async function (ui) {
  const facts = { steps: [], boxes: {} };
  const save = () => fs.writeFileSync(path.join(ui.out, "facts.json"), JSON.stringify(facts, null, 2));
  const shot = async (name) => { await ui.screenshot(name); const p = await panel(ui); if (p) facts.boxes[name] = p.box; };
  try {
    await run(ui, facts, shot);
  } finally {
    try { process.kill(ui.rec.worker_pid); facts.workerEnded = true; } catch { facts.workerEnded = "already gone"; }
    save();
  }
}

async function run(ui, facts, shot) {
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await ui.waitFor({ css: BAR }, { timeoutMs: 60000 });
  await ui.sleep(3000);
  await closeTips(ui);
  facts.home = ui.rec.fake_home;

  // 0. the fixture's agent works: the background service holds (with the stand-in caffeinate) and the cup comes up.
  // The bridge starts the window's chatd once, with a 20 s limit; on a loaded Mac that can run out, and then this does
  // what it did (`dispatch chatd ensure`), with the stand-in first on PATH as the instance has it
  const t0 = Date.now();
  let ensured = false;
  facts.held = await until(ui, "the Mac held for the fixture's agent", async () => {
    const s = cli(ui, ["awake"]);
    if (!s.running && !ensured && Date.now() - t0 > 45000 * SCALE) {
      ensured = true;
      assert((process.env.PATH || "").split(":")[0] === path.dirname(ui.rec.fake_caffeinate), `the stand-in caffeinate is not first on PATH: ${process.env.PATH}`);
      // its own 10 s wait can run out on a loaded Mac while the service still comes up: the wait here goes on
      const r = spawnSync("python3", [ui.rec.cli, "chatd", "ensure"], { env: cliEnv(ui), cwd: ui.rec.root, encoding: "utf8", timeout: 120000 });
      facts.chatdEnsuredByScenario = r.status === 0 ? "ok" : (r.stderr || "").trim().split("\n").pop();
    }
    return s.holding ? s : null;
  }, 240000, 2000);
  assert(facts.held.reason === "working" && facts.held.mode === "system", `held: ${JSON.stringify(facts.held)}`);
  await until(ui, "the cup in the bottom bar", () => cupShown(ui), 60000, 700);
  facts.fakeCallsAtStart = fakeCalls(ui);
  assert(facts.fakeCallsAtStart.some(l => / -is -t 90$/.test(l)), `the stand-in caffeinate was not asked: ${facts.fakeCallsAtStart.join(" | ")}`);
  facts.realCaffeinatesAtStart = realCaffeinates(ui);
  assert(!facts.realCaffeinatesAtStart.length, `a real caffeinate for this instance: ${facts.realCaffeinatesAtStart.join(" | ")}`);
  await shot("01-bar-cup");

  // 1. the panel: words, two switches, nothing that leads away
  const first = await openCard(ui);
  facts.cardDefault = first;
  assert(first.mode === "system" && first.keep.on && first.keep.enabled && !first.screen.on && first.screen.enabled, `the panel at first: ${JSON.stringify(first)}`);
  assert(/stays awake while agents work/.test(first.head) && /1 agent is working now/.test(first.sub), `the panel's words: ${first.head} / ${first.sub}`);
  assert(!first.links.length && !/Keep awake settings|More settings/.test(first.text), `the panel still leads to Settings: ${first.text}`);
  await shot("02-card-default");
  await ui.mark({ css: PANEL }, { what: "防休眠就在卡片里设置", where: "底栏 Awake 点开", how: "拨开关立即生效，上面的说明跟着变" });

  // 2. the screen too: the words say so at once, the service takes caffeinate -dis (the stand-in)
  await flip(ui, facts, "screen on", SCREEN, "display");
  await until(ui, "the service holds the screen too", async () => fakeCalls(ui).some(l => / -dis -t 90$/.test(l)), 45000, 1000);
  facts.fakeCallsScreen = fakeCalls(ui);
  await shot("03-card-screen-on");

  // 3. let the Mac sleep: the screen switch waits (shows what it goes back to), the cup stays while the panel is open
  const off = await flip(ui, facts, "let it sleep", KEEP, "off");
  assert(!off.keep.on && !off.screen.enabled && off.screen.on, `after Keep the Mac awake off: ${JSON.stringify({ keep: off.keep, screen: off.screen })}`);
  assert(/sleeps as usual/.test(off.head), `off says: ${off.head}`);
  facts.offService = await until(ui, "the service lets go", async () => { const s = cli(ui, ["awake"]); return !s.holding ? s : null; }, 30000, 1000);
  await shot("04-card-off");
  // a click on the waiting switch does nothing
  await ui.click({ css: SCREEN });
  await ui.sleep(600);
  facts.disabledClick = { mode: (await panel(ui)).mode, setting: setting(ui) };
  assert(facts.disabledClick.mode === "off" && facts.disabledClick.setting === "off", `the waiting switch flipped: ${JSON.stringify(facts.disabledClick)}`);

  // 4. on again: back to the screen too, as before; then the Mac only
  const again = await flip(ui, facts, "on again", KEEP, "display");
  assert(again.keep.on && again.screen.on && again.screen.enabled, `on again: ${JSON.stringify(again)}`);
  await flip(ui, facts, "screen off", SCREEN, "system");
  await shot("05-card-back-to-system");

  // 5. a closed panel after Let the Mac sleep takes the cup away; Settings says off
  await flip(ui, facts, "off before close", KEEP, "off");
  await closeCard(ui);
  await until(ui, "the cup gone once the panel closed", async () => !(await cupShown(ui)), 5000, 200);
  facts.cupGoneAfterClose = true;
  await openSettingsAwake(ui);
  facts.pageAfterCardOff = { picked: await pagePicked(ui), hero: await pageHero(ui) };
  assert(facts.pageAfterCardOff.picked === "off", `Settings has ${facts.pageAfterCardOff.picked} after the panel set off`);
  await shot("06-settings-after-card-off");

  // 6. the page sets it back: the cup returns once the service holds again, and its panel shows the page's pick
  await ui.click({ css: `.dset-choice[data-awake="display"]`, webview: false });
  await until(ui, "the page's pick saved", async () => setting(ui) === "display", 5000, 100);
  facts.pageHeroDisplay = await pageHero(ui);
  await until(ui, "the cup back after the page's pick", () => cupShown(ui), 60000, 700);
  const fromPage = await openCard(ui);
  facts.cardAfterPage = fromPage;
  assert(fromPage.mode === "display" && fromPage.keep.on && fromPage.screen.on, `the panel after the page picked display: ${JSON.stringify(fromPage)}`);
  await shot("07-card-after-settings-pick");

  // 7. the panel changes it while the page is open behind: the page draws again by itself
  await flip(ui, facts, "panel over the page", SCREEN, "system");
  await closeCard(ui);
  facts.pageLive = await until(ui, "the open page follows the panel", async () => (await pagePicked(ui)) === "system" ? { picked: "system", hero: await pageHero(ui) } : null, 5000, 100);
  await shot("08-settings-follows-card");

  // 8. dark
  await ui.setTheme("dark");
  await ui.press("Escape");
  await ui.sleep(800);
  if (await ui.exists({ css: ".dispatch-settings-nav", webview: false })) {
    await ui.click({ css: '.dispatch-settings-nav .dsn-back', webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(800);
  }
  await until(ui, "the cup", () => cupShown(ui), 60000, 700);
  await openCard(ui);
  await shot("09-card-dark");
  await flip(ui, facts, "dark: let it sleep", KEEP, "off");
  await shot("10-card-dark-off");
  await flip(ui, facts, "dark: on again", KEEP, "system");
  await closeCard(ui);
  await ui.setTheme("light");

  facts.realCaffeinatesAtEnd = realCaffeinates(ui);
  assert(!facts.realCaffeinatesAtEnd.length, `a real caffeinate for this instance: ${facts.realCaffeinatesAtEnd.join(" | ")}`);
  facts.fakeCallsAtEnd = fakeCalls(ui);
}
