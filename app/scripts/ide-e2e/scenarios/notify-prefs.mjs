// Settings › Notifications › On this Mac, walked the way a person does (kanban task-k1js2, app/cli/notify_prefs.py,
// Dispatch IDE patches/470-notifications.patch), with OpenCode on a cheap model:
//   1 the page: three kinds (finished, needs you, stopped; a stop is off by default), the sound, banners for agents
//     outside the window
//   2 the sound: the picker plays each sound as you move through it (afplay), Enter keeps it, the CLI has it
//   3 "An agent finished" off: a real conversation finishes and its banner is dropped; on again: the next one shows,
//     silent with the picked sound played by Dispatch
//   4 "An agent stopped" on: a stop rings too
//   5 a conversation that finishes while the window does not have it loaded (the window reloaded mid-answer): the
//     bell's row still says how it ended, its last line read from the agent's transcript
// The window is in front as far as the page is concerned (the runner says so): the instance's settings ask for banners
// always, so every banner goes through the policy and the test can read what it did.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

const run = promisify(execFile);
export const meta = { needs: ['opencode'],
  title: "通知：分类开关、提示音、后台做完的最后一句",
  description: "设置 › Notifications：做完 / 等你 / 停下各自能关，提示音能选能试听；关掉做完后真会话做完不弹，打开又弹并放选的声音；停下打开后也弹；窗口没加载的会话做完，铃铛那一行有最后一句话。",
  timeout: 1800,
};

const BELL = ".dispatch-inbox-button-label";
const PANEL = ".dispatch-inbox-panel";
const NAV = (page) => `.dispatch-settings-nav .dsn-row[data-page="${page}"]`;

function assert(ok, message) { if (!ok) throw new Error(message); }

async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],E.instance_env(r))";
  const out = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { maxBuffer: 8 * 1024 * 1024 }).catch((e) => ({ stdout: e.stdout || "", stderr: e.stderr || "" }));
  return out.stdout.trim();
}
const cliJson = async (ui, ...args) => JSON.parse(await cli(ui, ...args, "--json"));
const setting = async (ui, key) => (await cliJson(ui, "settings"))[key];

async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs * SCALE) {
    last = await fn();
    if (last) return last;
    await ui.sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** afplay playing right now (the sound Dispatch plays itself): the file names. */
async function playing() {
  try {
    const { stdout } = await run("pgrep", ["-fl", "afplay"]);
    return stdout.split("\n").filter((l) => l.includes("afplay")).map((l) => l.split("afplay").pop().trim());
  } catch {
    return [];
  }
}
async function heard(ui, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = await playing();
    if (p.length) return p;
    await ui.sleep(150);
  }
  return [];
}

const lastBanner = (ui) => ui.eval("document.body.dataset.dispatchLastBanner || ''");
const rows = (ui) => ui.eval(`[...document.querySelectorAll('${PANEL} .dispatch-inbox-row')].map(r => ({ cls: r.className, title: r.querySelector('.dispatch-inbox-row-title')?.textContent, line: r.querySelector('.dispatch-inbox-row-line')?.textContent }))`);
const count = (ui) => ui.eval(`document.querySelector('${BELL} .dispatch-inbox-count')?.textContent || ''`);

/** Banners always, so they go through the policy with the window in front (the runner keeps the page "focused"). */
function bannersAlways(ui) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean)) {
    const f = path.join(dir, "User", "settings.json");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { s = {}; }
    Object.assign(s, { "chat.notifyWindowOnResponseReceived": "always", "chat.notifyWindowOnConfirmation": "always" });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  }
}

async function closeTip(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); i++) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(500);
  }
}

async function openNotifications(ui) {
  if (!(await ui.exists({ css: ".dispatch-settings-nav", webview: false }))) await ui.press("Cmd+,");
  await ui.waitFor({ css: NAV("notifications"), webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: NAV("notifications"), webview: false });
  await ui.waitFor({ css: '[data-notify="notify_mac_finished"]', webview: false }, { timeoutMs: 30000 });
  await ui.sleep(600);
}
async function leaveSettings(ui) {
  // the first Escape can go to a hover the last click left open: press again, then take the Sessions link back
  for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-settings-nav", webview: false })); i++) {
    await ui.press("Escape");
    await ui.sleep(800);
  }
  if (await ui.exists({ css: ".dispatch-settings-nav", webview: false })) {
    await ui.click({ text: "Sessions", exact: true, within: ".dispatch-settings-nav", webview: false }).catch(() => undefined);
  }
  await ui.waitFor({ css: ".dispatch-settings-nav", webview: false }, { gone: true, timeoutMs: 10000 }).catch(() => undefined);
}
const switchOf = (key) => ({ css: `[data-notify="${key}"] [aria-checked]`, webview: false });
const checked = (ui, key) => ui.eval(`document.querySelector('[data-notify="${key}"] [aria-checked]')?.getAttribute('aria-checked')`);

// ---- the cheap model (as notify-sleep.mjs picks it) -------------------------------------------------
const menu = ".dispatch-slash-menu";
const newInput = ".sessions-chat-editor";
const chatInput = ".interactive-input-part .monaco-editor";
const inputText = (ui, input) => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
const readMenu = (ui) => ui.eval(`(() => {
  const m = document.querySelector('${menu}');
  if (!m) return null;
  const heads = [...m.querySelectorAll('.dsm-head')].map(h => ({ name: h.querySelector('.dsm-head-name')?.textContent }));
  const rows = [...m.querySelectorAll('.dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent, desc: r.querySelector('.dsm-desc')?.textContent || '', selected: r.classList.contains('selected') }));
  return { heads, rows };
})()`);
async function waitMenu(ui, check, what, timeoutMs = 15000) {
  return until(ui, async () => { const m = await readMenu(ui); return m && !(await ui.exists({ css: `${menu} .dsm-loading` })) && check(m) ? m : null; }, timeoutMs, `menu: ${what}`, 300);
}
async function clearInput(ui, input) {
  await ui.click({ css: input });
  await ui.press("End");
  for (let i = 0; i < 200 && (await inputText(ui, input)).length; i++) await ui.press("Backspace");
}
async function chooseCheapModel(ui, input) {
  await clearInput(ui, input);
  await typeIn(ui, input, "/model");
  const models = await waitMenu(ui, (m) => m.heads.length === 1 && m.heads[0].name === "Model", "Model group", 30000);
  const row = ui.cheapModel(models.rows);
  if (!row) throw new Error(`no cheap test model (listed: ${models.rows.map((r) => r.name + " / " + r.desc).slice(0, 30).join("; ")})`);
  await clearInput(ui, input);
  await typeIn(ui, input, `/${row.name.replace(/\s+/g, "")}`);
  let choices = await waitMenu(ui, (m) => m.rows.some((r) => r.name === row.name && r.desc === row.desc), row.name);
  for (let n = 0; n < choices.rows.length + 2 && !choices.rows.some((r) => r.selected && r.name === row.name && r.desc === row.desc); n++) {
    await ui.press("ArrowDown");
    choices = await readMenu(ui);
  }
  await ui.press("Enter", { send: true });
  await ui.sleep(1500);
  await clearInput(ui, input);
  await ui.press("Escape");
  return row;
}
const lastResponse = (ui) => ui.eval(`(() => {
  const rows = [...document.querySelectorAll('.interactive-response')];
  const row = rows.find(r => r.classList.contains('chat-most-recent-response')) || rows.at(-1);
  return row ? { text: row.innerText, loading: row.classList.contains('chat-response-loading') } : { text: '', loading: true };
})()`);

async function startConversation(ui, prompt) {
  await ui.newSession();
  await ui.waitFor({ css: ".sessions-chat-session-type-picker" }, { timeoutMs: 90000 });
  await ui.pickEngine("OpenCode");
  await ui.sleep(1500);
  if (await ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox .monaco-checkbox')?.getAttribute('aria-checked') === 'true'`)) {
    await ui.click({ css: ".sessions-chat-isolation-checkbox .monaco-checkbox" });
  }
  const model = await chooseCheapModel(ui, newInput);
  await ui.click({ css: newInput });
  await typeIn(ui, newInput, prompt);
  await ui.press("Enter", { send: true });
  await until(ui, async () => !!(await ui.exists({ css: chatInput })), 60000, "the session to open");
  return model;
}
async function say(ui, prompt) {
  await ui.click({ css: chatInput });
  await typeIn(ui, chatInput, prompt);
  await ui.press("Enter", { send: true });
}

/** Types into a box, putting the keyboard back in it first when a tip that came up took it away. */
async function typeIn(ui, css, text) {
  for (let i = 0; ; i++) {
    try {
      if (i) {
        for (let k = 0; k < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); k++) {
          await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
          await ui.sleep(500);
        }
        await ui.click({ css, webview: false });
      }
      await ui.type(text);
      return;
    } catch (e) {
      if (i >= 3) throw e;
      await ui.sleep(1500);
    }
  }
}

export default async function (ui) {
  const facts = {};
  bannersAlways(ui);
  await ui.attach("agents", 30000).catch(() => ui.openAgents());
  await ui.closeOverlays();
  await ui.waitFor({ css: BELL }, { timeoutMs: 60000 });
  await ui.sleep(4000);
  await closeTip(ui);
  await cli(ui, "inbox", "read", "--all");

  // 1 the page
  await openNotifications(ui);
  facts.page = await ui.eval("document.querySelector('.dispatch-settings-page, .dset-page')?.innerText.slice(0, 1200) || document.body.innerText.slice(0, 1200)");
  facts.defaults = { finished: await checked(ui, "notify_mac_finished"), needsYou: await checked(ui, "notify_mac_needs_you"), stopped: await checked(ui, "notify_mac_stopped") };
  assert(facts.defaults.finished === "true" && facts.defaults.needsYou === "true" && facts.defaults.stopped === "false", `defaults: ${JSON.stringify(facts.defaults)}`);
  assert(await ui.exists({ css: '[data-notify="notify_desktop"]', webview: false }), "the background banners row is gone");
  await ui.screenshot("01-on-this-mac");
  await ui.mark({ css: '[data-notify="notify_mac_finished"]', webview: false }, { what: "做完了：弹不弹横幅", where: "设置 › Notifications › On this Mac", how: "点右边的开关" });
  await ui.mark({ css: '[data-notify="notify_mac_needs_you"]', webview: false }, { what: "等你：弹不弹横幅", where: "做完那一行下面", how: "点开关" });
  await ui.mark({ css: '[data-notify="notify_mac_stopped"]', webview: false }, { what: "停下了：默认不弹，铃铛照样列", where: "等你那一行下面", how: "点开关打开" });
  await ui.mark({ css: '[data-notify="notify_sound"]', webview: false }, { what: "提示音：系统提示音、不响，或选一个", where: "三行分类下面", how: "点名字挑，▷ 试听" });

  // 2 the sound: moving through the list plays each one, Enter keeps it
  await ui.click({ css: ".dset-sound-pick", webview: false });
  await ui.waitFor({ css: ".quick-input-widget .quick-input-list .monaco-list-row", webview: false }, { timeoutMs: 15000 });
  facts.soundItems = await ui.eval("[...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].map(r => r.innerText.split('\\n')[0])");
  assert(facts.soundItems[0].startsWith("Mac alert sound") && facts.soundItems[1] === "None" && facts.soundItems.includes("Glass"), `sounds: ${facts.soundItems.join(", ")}`);
  for (let i = 0; i < 2; i++) await ui.press("ArrowDown"); // None, then the first of the Mac's sounds
  facts.preview = await heard(ui);
  assert(facts.preview.length, "moving to a sound did not play it");
  // on to Glass
  for (let i = 0; i < 20 && !/^Glass/.test(await ui.eval("document.querySelector('.quick-input-widget .monaco-list-row.focused')?.innerText || ''")); i++) {
    await ui.press("ArrowDown");
    await ui.sleep(150);
  }
  await ui.screenshot("02-sound-picker");
  await ui.mark({ css: ".quick-input-widget", webview: false }, { what: "选提示音：移到哪个就放哪个", where: "点 Sound 那一行的名字", how: "上下键试听，回车选定" });
  await ui.press("Enter");
  await until(ui, async () => (await setting(ui, "notify_sound")) === "Glass", 20000, "the sound to be saved");
  facts.soundButton = await ui.eval("document.querySelector('.dset-sound-pick')?.innerText.trim()");
  assert(/^Glass/.test(facts.soundButton), `the sound button says ${facts.soundButton}`);
  await ui.click({ css: ".dset-sound-play", webview: false });
  // the sound the picker previewed last may still be playing: wait for Glass itself
  for (const end = Date.now() + 8000; !(facts.played = await heard(ui)).some((f) => /Glass/.test(f)) && Date.now() < end; ) await ui.sleep(200);
  assert(facts.played.some((f) => /Glass/.test(f)), `▷ played ${facts.played}`);

  // 3 finished off: a real conversation finishes, no banner
  await ui.click(switchOf("notify_mac_finished"));
  await until(ui, async () => (await setting(ui, "notify_mac_finished")) === 0, 20000, "finished turned off");
  await ui.screenshot("03-finished-off");
  await leaveSettings(ui);
  facts.model = await startConversation(ui, "Reply with exactly: QUIET ONE. Do not use tools.");
  await until(ui, async () => { const r = await lastResponse(ui); return !r.loading && /QUIET ONE/.test(r.text); }, 240000, "the first answer", 2000);
  facts.bannerOff = await until(ui, async () => { const b = await lastBanner(ui); return /^finished/.test(b) ? b : null; }, 30000, "the finished banner to be decided");
  assert(/^finished off/.test(facts.bannerOff), `a finished banner showed while turned off: ${facts.bannerOff}`);

  // on again: the next answer rings, silent with Dispatch playing Glass
  await openNotifications(ui);
  await ui.click(switchOf("notify_mac_finished"));
  await until(ui, async () => (await setting(ui, "notify_mac_finished")) === 1, 20000, "finished turned on");
  await leaveSettings(ui);
  await ui.eval("delete document.body.dataset.dispatchLastBanner");
  await say(ui, "Now reply with exactly: LOUD TWO. Do not use tools.");
  let sound = [];
  await until(ui, async () => {
    if (!sound.length) sound = await playing();
    const r = await lastResponse(ui);
    return !r.loading && /LOUD TWO/.test(r.text);
  }, 240000, "the second answer", 500);
  facts.bannerOn = await until(ui, async () => { if (!sound.length) sound = await playing(); const b = await lastBanner(ui); return /^finished/.test(b) ? b : null; }, 30000, "the finished banner", 300);
  // the sound comes from the CLI the bridge starts: seconds later on a busy Mac
  if (!sound.length) sound = await heard(ui, 10000);
  facts.bannerSound = sound;
  assert(facts.bannerOn === "finished shown Glass", `the finished banner: ${facts.bannerOn}`);
  assert(sound.some((f) => /Glass/.test(f)), `the banner's sound: ${sound}`);

  // 4 stopped on: a stop rings too
  await openNotifications(ui);
  await ui.click(switchOf("notify_mac_stopped"));
  await until(ui, async () => (await setting(ui, "notify_mac_stopped")) === 1, 20000, "stopped turned on");
  await leaveSettings(ui);
  await cli(ui, "inbox", "add", "--kind", "stopped", "--session", "opencode:e2e-nightly-report", "--source", "chat", "--agent", "opencode", "--title", "Nightly report", "--why", "Hit a usage limit");
  facts.bannerStopped = await until(ui, async () => { const b = await lastBanner(ui); return /^stopped/.test(b) ? b : null; }, 40000, "the stopped banner");
  assert(facts.bannerStopped === "stopped shown Glass", `the stopped banner: ${facts.bannerStopped}`);
  await cli(ui, "inbox", "read", "--all");

  // 5 a conversation that finishes while the window does not have it loaded: the bell's row has its last line
  // a turn that is still going when the window comes back: a fixed 45 s wait (counting to 250 took a fast model ~10 s,
  // and a turn that ends while the window reloads is never seen working, 10-08)
  await startConversation(ui, "Run this exact shell command with your bash tool and nothing else: sleep 45. Then reply with two lines: Counted. and then ALL DONE HERE");
  await until(ui, async () => /sleep 45/.test((await lastResponse(ui)).text) || (await lastResponse(ui)).text.trim().length > 0, 120000, "the answer to start", 1000);
  // look elsewhere, then the window reloads: it comes back on the new session page, the conversation not loaded
  await ui.newSession();
  await ui.sleep(1500);
  await ui.reloadWindow(); // a real reload (location.reload() is refused by the workbench)
  await ui.sleep(4000);
  await ui.attach("agents", 60000, "Dispatch Agent");
  await ui.waitFor({ css: BELL }, { timeoutMs: 90000 });
  await until(ui, async () => (await count(ui)) !== "", 300000, "the bell to count the finished conversation", 2000).catch(async (e) => {
    // why not: what the inbox has, and how the conversation's row looks in the list
    const inbox = (await cli(ui, "inbox", "list", "--json").catch(() => "")).slice(0, 600);
    const row = await ui.eval(`[...document.querySelectorAll('.agent-session-item, .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ')).filter(t => /Count|250/.test(t)).slice(0, 2)`).catch(() => null);
    throw new Error(`${e.message}; inbox: ${inbox}; row: ${JSON.stringify(row)}`);
  });
  await ui.click({ css: BELL });
  await ui.waitFor({ css: PANEL });
  const fin = await until(ui, async () => (await rows(ui)).find((r) => /finished/.test(r.cls) && /ALL DONE HERE/.test(r.line || "")), 60000, "the row's last line", 2000);
  facts.backgroundRow = fin;
  await ui.screenshot("04-bell-last-words");
  await ui.mark({ css: `${PANEL} .dispatch-inbox-row.finished` }, { what: "后台做完的会话：标题下面是最后一句话", where: "铃铛弹层", how: "窗口没加载那段对话也有" });
  await ui.press("Escape");

  // back to how it was
  await cli(ui, "settings", "notify_mac_stopped", "0");
  await cli(ui, "settings", "notify_sound", "default");
  fs.writeFileSync(path.join(ui.out, "facts.json"), JSON.stringify(facts, null, 2));
  return facts;
}
