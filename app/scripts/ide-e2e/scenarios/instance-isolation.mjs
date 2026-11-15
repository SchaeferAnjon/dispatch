// A test instance keeps to itself (task-ug3f, task-t8s1): its windows are not on the person's screen, and an
// OpenCode session started in it lands in the instance's own OpenCode store (XDG_DATA_HOME under the instance),
// not in the person's ~/.local/share/opencode, where their own OpenCode list and Dispatch's History read it, and
// none of the person's third-party OpenCode plugins run in it (oh-my-openagent copies every session into
// ~/.claude/transcripts).
// Needs OpenCode with a cheap model (DeepSeek Flash, GLM Flash, or OpenCode's free Flash). Read-only on the
// person's store: it only counts the sessions there that work in this instance.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { needs: ['opencode'], title: "Test instance keeps to itself", description: "Its windows stay hidden; an OpenCode session goes to the instance's own store.", timeout: 900 };

const fresh = ".sessions-chat-editor";
const PROMPT = "Reply with just the word hi.";

async function until(ui, fn, what, ms = 120000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await ui.sleep(1000);
  }
  throw new Error(`Timed out: ${what}`);
}

/** Sessions in an OpenCode store working under `root` (sqlite3 reads it; a missing store has none). */
function sessionsUnder(db, root) {
  if (!existsSync(db)) return [];
  const q = `select id, directory from session where directory like '${root.replace(/'/g, "''")}%' or directory like '/private${root.replace(/'/g, "''")}%'`;
  const out = execFileSync("sqlite3", ["-readonly", "-separator", "|", db, q], { encoding: "utf8", timeout: 30000 });
  return out.split("\n").filter(Boolean).map((l) => l.split("|"));
}

function assistantSaid(db, sid) {
  const q = `select data from part where session_id = '${sid}'`;
  try {
    return execFileSync("sqlite3", ["-readonly", db, q], { encoding: "utf8", timeout: 30000 });
  } catch {
    return "";
  }
}

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: "button.dispatch-tour-close" })); i++) {
    await ui.click({ css: "button.dispatch-tour-close" });
    await ui.sleep(600);
  }
}

/** A new session in the demo project the way a person starts one: Projects, the project, New Session. */
async function newSessionInProject(ui, folder) {
  const name = folder.split("/").filter(Boolean).at(-1);
  await closeTips(ui);
  for (let attempt = 0; ; attempt++) {
    await ui.click("Projects");
    try { await ui.waitFor({ css: ".dispatch-projects-toolbar" }, { timeoutMs: 20000 }); await ui.click({ text: "All", exact: true, within: ".dispatch-projects-toolbar" }); } catch { /* no filter bar */ }
    try { await ui.waitFor({ text: name, exact: true, within: ".dispatch-projects-page" }, { timeoutMs: 45000 }); break; } catch (e) { if (attempt >= 3) throw e; }
  }
  const pageButton = (label) => ui.eval(`(() => {
    const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')]
      .filter(e => ((e.getAttribute('aria-label') || '').split(' (')[0].trim() === ${JSON.stringify(label)} || (e.innerText || '').trim() === ${JSON.stringify(label)}))
      .map(e => ({ r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.left > 400)
      .sort((a, b) => b.r.left - a.r.left);
    return els[0] ? { x: els[0].r.left + els[0].r.width / 2, y: els[0].r.top + els[0].r.height / 2 } : null;
  })()`);
  const press = async (b) => {
    await ui.mouse("mouseMoved", b.x, b.y);
    await ui.mouse("mousePressed", b.x, b.y, { clickCount: 1 });
    await ui.mouse("mouseReleased", b.x, b.y, { clickCount: 1 });
  };
  let first = null;
  for (let attempt = 0; attempt < 4 && !first; attempt++) {
    await closeTips(ui);
    try { await ui.click({ text: name, exact: true, within: ".dispatch-projects-page" }); } catch { /* already open */ }
    first = await until(ui, async () => (await pageButton("New Session")) || (await pageButton("Add as Project")) ? true : null, "the project page buttons", 15000).catch(() => null);
  }
  if (!first) throw new Error("The project page did not open");
  if (!(await pageButton("New Session"))) await press(await pageButton("Add as Project"));
  await press(await until(ui, async () => pageButton("New Session"), "the project page's New Session", 60000));
  await until(ui, async () => ui.eval(`(document.querySelector('.part.titlebar')?.innerText || '').includes(${JSON.stringify(name)}) && !!document.querySelector('.sessions-chat-session-type-picker')`), `a new session in ${name}`, 60000);
}

async function focusInput(ui) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${fresh} .view-lines` : fresh });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${fresh}')`)) return;
    await ui.sleep(800);
  }
  throw new Error("The message box does not take the focus");
}

export default async function (ui) {
  const rec = ui.rec;
  const real = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const mine = join(rec.root, "xdg-data", "opencode", "opencode.db");
  const result = { root: rec.root, realStore: real, instanceStore: mine };

  await ui.openAgents(ui.demoFolder);
  // 1. the windows are hidden: none of the app's windows is on the screen
  const shown = ui.windowsOnScreen();
  result.windowsOnScreen = shown;
  if (shown && shown.length) throw new Error(`the test instance has ${shown.length} window(s) on the screen: ${JSON.stringify(shown)}`);
  result.realBefore = sessionsUnder(real, rec.root).length;
  const transcripts = join(homedir(), ".claude", "transcripts");
  const countTranscripts = () => (existsSync(transcripts) ? readdirSync(transcripts).length : 0);
  result.transcriptsBefore = countTranscripts();

  // 2. an OpenCode session, as a person starts one
  await newSessionInProject(ui, ui.demoFolder);
  await ui.pickEngine("OpenCode", 360000);
  await focusInput(ui);
  await ui.type("/model");
  await ui.waitFor({ css: ".dispatch-slash-menu .dsm-row" }, { timeoutMs: 30000 });
  let seen = "";
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map((r) => r.name).join(", ");
    return ui.cheapModel(rows);
  }, "a cheap test model", 45000).catch((e) => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press("Backspace");
  await ui.type(`/${row.name.replace(/\s+/g, "")}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: ".dispatch-slash-menu" });
  await ui.press("Escape");
  await focusInput(ui);
  await ui.type(PROMPT);
  await ui.press("Enter", { send: true });
  result.model = row.name;

  // 3. the session and its answer are in the instance's store
  const sid = await until(ui, async () => {
    const s = sessionsUnder(mine, rec.root);
    return s.length && /\bhi\b/i.test(assistantSaid(mine, s[s.length - 1][0])) ? s[s.length - 1][0] : null;
  }, "the reply in the instance's OpenCode store", 300000);
  result.instanceSession = sid;
  await ui.screenshot("opencode-reply");

  // 4. and not in the person's
  result.realAfter = sessionsUnder(real, rec.root).length;
  await ui.sleep(3000);  // a plugin writes its copy as the turn ends
  result.transcriptsAfter = countTranscripts();
  result.transcriptOfThisSession = existsSync(join(transcripts, `${sid}.jsonl`));
  writeFileSync(`${ui.out}/isolation.json`, JSON.stringify(result, null, 2));
  if (result.realAfter !== result.realBefore) throw new Error(`the person's OpenCode store got ${result.realAfter - result.realBefore} session(s) of this instance`);
  if (result.transcriptOfThisSession) throw new Error(`a plugin of the person's wrote this session into ${transcripts}`);
  const still = ui.windowsOnScreen();
  if (still && still.length) throw new Error(`a window of the instance came onto the screen during the run: ${JSON.stringify(still)}`);
}
