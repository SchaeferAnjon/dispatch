// The bell and sleeping agents (kanban task-gfhy, task-xq6g; dispatch-ide patches/470-notifications.patch,
// 275-agent-sleep.patch), walked the way a person would:
//   1. the bell sits right of the phone button, next to it (design/bars, task-in8g: your Macs, then the phone, then
//      the bell), and a count on it moves neither
//   2. three things happened in conversations Dispatch runs outside the window (chatd): finished, needs you,
//      stopped. The bell says 3, the Dock icon says 3; the panel shows them with their status blocks
//   3. a row's small button marks it read (2), right-click marks it unread again (3), Mark all read (0)
//   4. the panel's switch turns sleeping off and on (the CLI's setting follows)
// A real conversation finishing and going to sleep is notify-sleep.mjs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const run = promisify(execFile);
export const meta = {
  title: "铃铛和休眠",
  description: "标题栏铃铛：做完 / 等你 / 停下分开，Dock 角标同数，标已读和标回未读；闲着的会话休眠，打开就接上。",
};

const BELL = ".dispatch-inbox-button-label";
const PHONE = ".dispatch-mobile-button-label";
const PANEL = ".dispatch-inbox-panel";

function assert(ok, message) { if (!ok) throw new Error(message); }

async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],E.instance_env(r))";
  const out = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { maxBuffer: 8 * 1024 * 1024 }).catch((e) => ({ stdout: e.stdout || "", stderr: e.stderr || "" }));
  return out.stdout.trim();
}
const cliJson = async (ui, ...args) => JSON.parse(await cli(ui, ...args, "--json"));

async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await ui.sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const count = (ui) => ui.eval(`document.querySelector('${BELL} .dispatch-inbox-count')?.textContent || ''`);
const rows = (ui) => ui.eval(`[...document.querySelectorAll('${PANEL} .dispatch-inbox-row')].map(r => ({ cls: r.className, title: r.querySelector('.dispatch-inbox-row-title')?.textContent, line: r.querySelector('.dispatch-inbox-row-line')?.textContent, blocks: r.querySelector('.dispatch-status-blocks')?.className || (r.querySelector('.dispatch-status-dot.error, .dispatch-inbox-stop') ? 'stop' : '') }))`);

/** The Dock badge of this instance (macOS keeps it per app process: lsappinfo's StatusLabel). */
async function dock(ui) {
  try {
    const asn = (await run("lsappinfo", ["find", `pid=${ui.rec.pid}`])).stdout.trim();
    const info = (await run("lsappinfo", ["info", "-only", "StatusLabel", asn])).stdout;
    return /"label"="([^"]*)"/.exec(info)?.[1] ?? "";
  } catch {
    return "?";
  }
}

async function titlebar(ui) {
  return ui.eval(`(() => {
    const W = window.innerWidth;
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), fromRight: Math.round(W - r.right) }; };
    return { W, bell: box('${BELL}'), phone: box('${PHONE}'), machines: box('.dispatch-machines-button-label'), accounts: box('.dispatch-accounts-button-label') };
  })()`);
}

async function openPanel(ui) {
  if (!(await ui.exists({ css: PANEL }))) await ui.click({ css: BELL });
  await ui.waitFor({ css: PANEL });
  await ui.sleep(600);
}
async function closePanel(ui) {
  if (await ui.exists({ css: PANEL })) await ui.press("Escape");
  await ui.waitFor({ css: PANEL }, { gone: true });
}

// ---- the cheap model (as slash-menu.mjs picks it) -------------------------------------------------
const menu = ".dispatch-slash-menu";
const newInput = ".sessions-chat-editor";
const chatInput = ".interactive-input-part .monaco-editor";
const inputText = (ui, input) => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
const readMenu = (ui) => ui.eval(`(() => {
  const m = document.querySelector('${menu}');
  if (!m) return null;
  const heads = [...m.querySelectorAll('.dsm-head')].map(h => ({ name: h.querySelector('.dsm-head-name')?.textContent }));
  const rows = [...m.querySelectorAll('.dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent, desc: r.querySelector('.dsm-desc')?.textContent || '', selected: r.classList.contains('selected'), current: !!r.querySelector('.dsm-current') }));
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
  await ui.type("/model");
  const models = await waitMenu(ui, m => m.heads.length === 1 && m.heads[0].name === "Model", "Model group", 30000);
  const pick = (name, provider) => models.rows.find(r => r.name === name && (r.desc || "").toLowerCase().includes(provider.toLowerCase()));
  // the project's cheap test models, else a free one (OpenCode Zen lists some "… Free")
  const row = pick("GLM-5.3 Flash", "Z.AI Coding Plan") ?? pick("DeepSeek V4.1 Flash", "DeepSeek")
    ?? models.rows.find(r => /Flash Free$/.test(r.name || "") && /OpenCode Zen/i.test(r.desc || ""))
    ?? models.rows.find(r => / Free$/.test(r.name || "") && /OpenCode Zen/i.test(r.desc || ""));
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
const lastResponse = (ui) => ui.eval(`(() => {
  const rows = [...document.querySelectorAll('.interactive-response')];
  const row = rows.find(r => r.classList.contains('chat-most-recent-response')) || rows.at(-1);
  return row ? { text: row.innerText, loading: row.classList.contains('chat-response-loading') } : { text: '', loading: true };
})()`);

export default async function (ui) {
  // a build check's instance starts with the editor window: open the Agents window from it, as bars.mjs does
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  await ui.closeOverlays();
  const facts = {};

  // 1. where the bell is
  await ui.waitFor({ css: BELL }, { timeoutMs: 30000 });
  await ui.waitFor({ css: PHONE }, { timeoutMs: 30000 });
  await ui.sleep(1500);
  facts.titlebar = await titlebar(ui);
  console.log("TITLEBAR " + JSON.stringify(facts.titlebar));
  const { bell, phone } = facts.titlebar;
  assert(phone.x + phone.w <= bell.x, `the bell is not right of the phone button: ${JSON.stringify(facts.titlebar)}`);
  assert(bell.x - (phone.x + phone.w) <= 8, `the bell is not next to the phone button: ${JSON.stringify(facts.titlebar)}`);
  const { machines } = facts.titlebar;
  if (machines) assert(machines.x + machines.w <= phone.x, `your Macs are not left of the phone button: ${JSON.stringify(facts.titlebar)}`);
  await ui.screenshot("01-titlebar");
  await ui.mark({ css: BELL }, { what: "铃铛：有新消息的会话数", where: "标题栏右侧，手机按钮右边", how: "点开看列表" });
  await ui.mark({ css: PHONE }, { what: "手机配对按钮", where: "你的 Mac 和铃铛之间", how: "点开配对" });

  // 2. three things from conversations Dispatch runs outside the window
  await cli(ui, "inbox", "read", "--all");
  await cli(ui, "inbox", "add", "--kind", "finished", "--session", "claude-code:aaaaaaaa-1111-4111-8111-000000000001", "--source", "chat", "--agent", "claude-code", "--title", "Write the release notes", "--project", "demo", "--text", "Done: the notes are in CHANGELOG.md");
  await cli(ui, "inbox", "add", "--kind", "needs_you", "--session", "codex:bbbbbbbb-2222-4222-8222-000000000002", "--source", "chat", "--agent", "codex", "--title", "Deploy the preview", "--project", "demo", "--text", "Run npm run deploy?");
  await cli(ui, "inbox", "add", "--status", "rate_limited", "--session", "claude-code:cccccccc-3333-4333-8333-000000000003", "--source", "chat", "--agent", "claude-code", "--title", "Translate the docs", "--project", "demo");
  await until(ui, async () => (await count(ui)) === "3", 20000, "the bell to say 3");
  facts.bellWithCount = await titlebar(ui);
  assert(facts.bellWithCount.bell.w === bell.w && facts.bellWithCount.phone.x === phone.x, `the count moved the buttons: ${JSON.stringify(facts.bellWithCount)}`);
  await ui.screenshot("01b-titlebar-count");
  facts.dock3 = await dock(ui);
  assert(facts.dock3 === "3", `the Dock says ${facts.dock3}, not 3`);
  await openPanel(ui);
  const three = await rows(ui);
  facts.three = three;
  assert(three.length >= 3, `rows: ${JSON.stringify(three)}`);
  const byTitle = (t) => three.find(r => r.title === t);
  assert(/still/.test(byTitle("Write the release notes")?.blocks || ""), "a finished row is not the whole icon in colour");
  assert(/waiting/.test(byTitle("Deploy the preview")?.blocks || ""), "a needs-you row is not the amber grid");
  assert(byTitle("Translate the docs")?.blocks === "stop", "a stopped row is not the coral dot");
  assert(/usage limit/i.test(byTitle("Translate the docs")?.line || ""), `the stop does not say why: ${byTitle("Translate the docs")?.line}`);
  assert(/CHANGELOG/.test(byTitle("Write the release notes")?.line || ""), "a finished row does not show its last words");
  await ui.screenshot("02-panel-three");
  await ui.mark({ css: `${PANEL} .dispatch-inbox-row.finished` }, { what: "做完了：完整的彩色方块图标，最后一句话", where: "铃铛弹层 New 下面", how: "点一下打开会话" });
  await ui.mark({ css: `${PANEL} .dispatch-inbox-row.needs_you` }, { what: "等你：琥珀色方块，问的是什么", where: "铃铛弹层", how: "点一下去回答" });
  await ui.mark({ css: `${PANEL} .dispatch-inbox-row.stopped` }, { what: "停下了：珊瑚色点，写为什么停（不弹系统通知）", where: "铃铛弹层", how: "点一下看看" });

  // 3. read, unread again, all read
  await ui.hover({ css: `${PANEL} .dispatch-inbox-row.finished` });
  await ui.click({ css: `${PANEL} .dispatch-inbox-row.finished .dispatch-inbox-row-toggle` });
  await until(ui, async () => (await count(ui)) === "2", 15000, "the bell to say 2 after Mark as Read");
  await until(ui, async () => (await dock(ui)) === "2", 15000, "the Dock to say 2");
  await ui.screenshot("03-one-read");
  const readRow = `${PANEL} .dispatch-inbox-row.finished.read`;
  await ui.waitFor({ css: readRow });
  if (process.env.NOTIFY_SKIP_MENU === "1") {
    await ui.hover({ css: readRow });
    await ui.click({ css: `${readRow} .dispatch-inbox-row-toggle` });
  } else {
    const box = await ui.eval(`(() => { const r = document.querySelector('${readRow}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await ui.mouse("mousePressed", box.x, box.y, { button: "right", clickCount: 1 });
    await ui.mouse("mouseReleased", box.x, box.y, { button: "right", clickCount: 1 });
    await ui.sleep(700);
    await ui.screenshot("04-right-click");
    await ui.mark({ text: "Mark as Unread", within: ".monaco-menu-container" }, { what: "右键：标回未读", where: "铃铛弹层里一行上右键", how: "点 Mark as Unread" });
    await ui.click({ text: "Mark as Unread", within: ".monaco-menu-container" });
  }
  await until(ui, async () => (await count(ui)) === "3", 15000, "the bell to say 3 after Mark as Unread");
  await openPanel(ui);
  await ui.click({ css: `${PANEL} .dispatch-inbox-text-button` });
  await until(ui, async () => (await count(ui)) === "", 15000, "the bell to be empty after Mark all read");
  await until(ui, async () => ["", "0"].includes(await dock(ui)), 15000, "the Dock badge to go");
  facts.unreadAfterAll = (await cliJson(ui, "inbox", "list")).unread;
  assert(facts.unreadAfterAll === 0, `the CLI still has ${facts.unreadAfterAll} unread`);
  await ui.screenshot("05-all-read");

  // 4. the sleep switch
  await openPanel(ui);
  await ui.waitFor({ css: `${PANEL} .dispatch-inbox-switch` });
  facts.footOn = await ui.eval(`document.querySelector('${PANEL} .dispatch-inbox-foot')?.innerText || ''`);
  await ui.mark({ css: `${PANEL} .dispatch-inbox-foot` }, { what: "闲着的 Agent 休眠：说明和开关", where: "铃铛弹层最下面", how: "点开关" });
  await ui.click({ css: `${PANEL} .dispatch-inbox-switch` });
  await until(ui, async () => (await cliJson(ui, "sleep")).on === false, 20000, "sleep to be off");
  await until(ui, async () => /stay awake/.test(await ui.eval(`document.querySelector('${PANEL} .dispatch-inbox-foot')?.innerText || ''`)), 15000, "the foot to say they stay awake");
  await ui.screenshot("06-sleep-off");
  await ui.click({ css: `${PANEL} .dispatch-inbox-switch` });
  await until(ui, async () => (await cliJson(ui, "sleep")).on === true, 20000, "sleep to be on again");
  await closePanel(ui);

  await writeFile(`${ui.out}/facts.json`, JSON.stringify(facts, null, 2));
}
