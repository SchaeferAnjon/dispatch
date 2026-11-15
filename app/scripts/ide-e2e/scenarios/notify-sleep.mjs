// A real conversation and the bell, then sleep (kanban task-gfhy, task-xq6g), with OpenCode on a cheap or free model:
//   1. a conversation finishes while the person looks elsewhere: a new "Finished" row with its title, the Dock
//      says 1; clicking the row opens the session and the number goes away
//   2. with sleep after 1 minute, the finished conversation goes to sleep (`dispatch sleep` lists it, the bell
//      panel's foot says so); opening it wakes it, and the next message gets an answer in the same conversation
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

const run = promisify(execFile);
export const meta = { needs: ['opencode'],
  title: "做完提醒和休眠（真实会话）",
  description: "真实会话在别处做完：铃铛加一条 Finished，Dock 同数，点开就是那个会话；放着 1 分钟睡了，打开就醒，接着回话。",
  timeout: 1200,
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
  while (Date.now() - t0 < timeoutMs * SCALE) {
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
    return { W, bell: box('${BELL}'), phone: box('${PHONE}'), accounts: box('.dispatch-accounts-button-label') };
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
const lastResponse = (ui) => ui.eval(`(() => {
  const rows = [...document.querySelectorAll('.interactive-response')];
  const row = rows.find(r => r.classList.contains('chat-most-recent-response')) || rows.at(-1);
  return row ? { text: row.innerText, loading: row.classList.contains('chat-response-loading') } : { text: '', loading: true };
})()`);

export default async function (ui) {
  await ui.attach("agents", 60000, "Dispatch Agent");
  await ui.closeOverlays();
  const facts = {};
  await cli(ui, "inbox", "read", "--all");
  // 5. a real conversation finishes while the person looks elsewhere
  // already in the Agents window; the instance opened it on the demo project
  await ui.waitFor({ css: BELL }, { timeoutMs: 60000 });
  await ui.newSession();
  await ui.waitFor({ css: ".sessions-chat-session-type-picker" }, { timeoutMs: 90000 });
  facts.newPage = await ui.eval(`document.querySelector('.sessions-chat-widget, .sessions-new-session, body')?.innerText.slice(0, 400)`);
  await ui.pickEngine("OpenCode");
  await ui.sleep(1500);
  if (await ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox .monaco-checkbox')?.getAttribute('aria-checked') === 'true'`)) {
    await ui.click({ css: ".sessions-chat-isolation-checkbox .monaco-checkbox" });
  }
  facts.model = await chooseCheapModel(ui, newInput);
  await ui.click({ css: newInput });
  await ui.type("Count slowly from 1 to 40, one number per line, then write DONE. Do not use tools.");
  await ui.press("Enter", { send: true });
  await until(ui, async () => !!(await ui.exists({ css: chatInput })), 60000, "the session to open");
  const title = await until(ui, async () => (await ui.eval(`document.querySelector('.monaco-list-row.selected')?.innerText.split('\\n')[0].trim() || ''`)) || null, 30000, "the session's row");
  facts.session = title;
  await until(ui, async () => (await lastResponse(ui)).text.trim().length > 0, 120000, "the answer to start", 2000);
  await ui.screenshot("05-working");
  // look elsewhere while it works
  await ui.newSession();
  await ui.sleep(3000);
  await ui.screenshot("06-elsewhere");
  await until(ui, async () => (await count(ui)) === "1", 240000, "the bell to say 1 when the conversation finishes", 2000);
  facts.dock1 = await dock(ui);
  await openPanel(ui);
  const fin = (await rows(ui)).find(r => /dispatch-inbox-row finished/.test(r.cls) && !/read/.test(r.cls));
  facts.finishedRow = fin;
  // the last words come from the conversation when this window has it loaded; one that finished in the background may only have its title
  assert(fin && fin.title && /still/.test(fin.blocks), `no unread Finished row: ${JSON.stringify(await rows(ui))}`);
  await ui.screenshot("07-real-finished");
  await ui.mark({ css: `${PANEL} .dispatch-inbox-row.finished` }, { what: "真实会话做完：标题和最后一句", where: "铃铛弹层", how: "点一下打开" });
  await ui.click({ css: `${PANEL} .dispatch-inbox-row.finished` });
  await until(ui, async () => (await count(ui)) === "", 15000, "the bell to clear after opening the session");
  await until(ui, async () => /DONE/.test((await lastResponse(ui)).text), 30000, "the opened session to show its answer");
  await ui.screenshot("08-opened-from-bell");

  // 6. asleep after a minute untouched, awake when opened
  await cli(ui, "sleep", "after", "1");
  await ui.newSession();
  const asleep = await until(ui, async () => { const s = await cliJson(ui, "sleep"); return s.count > 0 ? s : null; }, 300000, "the finished conversation to go to sleep", 5000);
  facts.asleep = asleep;
  await openPanel(ui);
  await until(ui, async () => /asleep/.test(await ui.eval(`document.querySelector('${PANEL} .dispatch-inbox-foot')?.innerText || ''`)), 90000, "the foot to say an agent is asleep", 3000);
  await ui.screenshot("09-asleep");
  await ui.mark({ css: `${PANEL} .dispatch-inbox-foot` }, { what: "做完 1 分钟（默认 30 分钟）没人碰的会话睡了，省内存", where: "铃铛弹层最下面", how: "打开会话就醒" });
  // open it again the way a person finds it here: its row in the bell (under Earlier now)
  await ui.click({ css: `${PANEL} .dispatch-inbox-row.finished` });
  await until(ui, async () => (await cliJson(ui, "sleep")).count === 0, 60000, "opening the session to wake it", 2000);
  await ui.click({ css: chatInput });
  await ui.type("Now reply with exactly: AWAKE AGAIN. Do not use tools.");
  await ui.press("Enter", { send: true });
  await until(ui, async () => { const r = await lastResponse(ui); return !r.loading && /AWAKE AGAIN/.test(r.text); }, 240000, "the woken conversation to answer", 2000);
  await ui.screenshot("10-woke-and-answered");
  await cli(ui, "sleep", "after", "30");
  await writeFile(`${ui.out}/facts.json`, JSON.stringify(facts, null, 2));
}
