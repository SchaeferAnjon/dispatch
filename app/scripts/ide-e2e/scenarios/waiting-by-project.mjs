// Waiting for you with a lot on it (dispatch-ide patches/425-waiting.patch; since 2026-11-11 direction A of
// design/home-now, task-0v1o9: one row per thing, This week and Older; the project rows of direction B are gone). The prototype's 28 items: 8 approvals, 6 questions and 8 unread replies from sessions,
// and 6 tasks only the person can do, across 3 projects. The sessions are a stand-in written into this instance's
// own CLI copy (no agent stops 22 times on cue); the 6 Only-you tasks are real tasks on the instance's board
// (`dispatch need-you`), so Done and Undo go through the real `dispatch done` and reopen.
// Path: the sidebar's Waiting for you, 28 rows in This week, Allow one from its card, j and a, an Only-you task Done
// (Enter) and Undo, the dark theme.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

export const meta = {
  title: "Waiting for you 事很多时",
  description: "28 件等你的事：一件一行，项目、要你做什么、多久三列对齐；卡片上 Allow、键盘 j 和 a、Only you 回车完成再撤销。",
};

const PROJECTS = ["demo-shop", "field-notes", "demo-api"];
const APPROVE = [["Build the checkout page", "npm run build"], ["Export the notebook", "python3 export.py --sample"], ["Run the API checks", "npm test"],
  ["Update the product list", "git diff --stat"], ["Read the archived notes", "ls archive"], ["Inspect response headers", "curl -I http://localhost:3000"],
  ["Validate product images", "npm run check:images"], ["Compare notebook revisions", "git diff HEAD~1"]];
const DECIDE = [["Choose a checkout layout", "Which layout should the checkout use?"], ["Choose the note navigation", "Which navigation should the notebook use?"],
  ["Choose the activity view", "Which activity view should the API use?"], ["Choose product details", "Which product detail layout should we use?"],
  ["Choose the notes toolbar", "Which toolbar should the notes use?"], ["Choose the API overview", "Which API overview should we use?"]];
const UNREAD = [["Checkout keyboard review", "All fields can be reached with Tab."], ["Notes search is ready", "Search now matches notebook titles."],
  ["API error messages", "Errors include a retry action."], ["Product list tests passed", "The compact list passes the current tests."],
  ["Notebook export is ready", "The sample export opens correctly."], ["Response caching review", "Responses now reuse cached data."],
  ["Image loading review", "Images reserve their space while loading."], ["Notes keyboard shortcuts", "The shortcuts are listed beside each action."]];
const ONLY = ["Review the demo checkout", "Pick a sample notebook", "Confirm the demo endpoint", "Try the keyboard flow", "Read the export example", "Check the sample response"];

// appended to the instance's own waiting.py: the session rows above, answered in place (nothing real behind them)
const STUB = `
# ---- e2e scenario waiting-by-project: sessions that wait, read from waiting-fixture.json next to this file ----
import json as _fx_json, os as _fx_os
_FX = _fx_os.path.join(_fx_os.path.dirname(_fx_os.path.abspath(__file__)), "waiting-fixture.json")
def _fx_load():
    try:
        with open(_FX, encoding="utf-8") as f:
            return _fx_json.load(f)
    except (OSError, ValueError):
        return {"items": [], "gone": []}
def _fx_take(ids, gone=True):
    d = _fx_load()
    known = {it["id"] for it in d["items"]}
    hit = [i for i in ids if i in known]
    if hit:
        g = set(d["gone"])
        (g.update if gone else g.difference_update)(hit)
        d["gone"] = sorted(g)
        with open(_FX, "w", encoding="utf-8") as f:
            _fx_json.dump(d, f)
    return hit
_fx_collect = collect
def collect(*args, **kw):
    data = _fx_collect(*args, **kw)
    d = _fx_load()
    items = data["items"] + [dict(it) for it in d["items"] if it["id"] not in d["gone"]]
    order = {k: i for i, k in enumerate(KINDS)}
    items.sort(key=lambda it: (order.get(it["kind"], 9), (it.get("stopped_at") or it.get("at") or 0) * (1 if it["kind"] in ("approve", "decide") else -1)))
    return dict(data, items=items, counts=counts(items, data.get("seen_at") or 0))
_fx_confirm = ide_confirm
def ide_confirm(item_id, allow, *a, **k):
    return {"ok": True} if _fx_take([item_id]) else _fx_confirm(item_id, allow, *a, **k)
_fx_pick = ide_pick
def ide_pick(item_id, option, *a, **k):
    return {"ok": True} if _fx_take([item_id]) else _fx_pick(item_id, option, *a, **k)
_fx_unread = ide_mark_unread
def ide_mark_unread(item_id, *a, **k):
    return {"ok": True} if _fx_take([item_id], gone=False) else _fx_unread(item_id, *a, **k)
_fx_read = mark_read
def mark_read(item_ids=None, keep=None, failed=None):
    d = _fx_load()
    known = {it["id"] for it in d["items"]}
    mine = [it["id"] for it in d["items"] if it["kind"] == "unread" and it["id"] not in d["gone"]] if item_ids is None else [i for i in item_ids if i in known]
    _fx_take(mine)
    if item_ids is None:
        return mine + _fx_read(None, keep, failed)
    rest = [i for i in item_ids if i not in known]
    return mine + (_fx_read(rest, keep, failed) if rest else [])
`;
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

function env(ui) {
  return { ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_DIR: ui.rec.dispatch_dir,
    BEADS_DIR: ui.rec.beads_dir, DISPATCH_BIN: ui.rec.cli, DISPATCH_FACTS_FILE: path.join(ui.rec.root, "rules/FACTS.md") };
}
function cli(ui, args) {
  return JSON.parse(execFileSync("python3", [ui.rec.cli, ...args, "--json"], { env: env(ui), cwd: ui.demoFolder, encoding: "utf8", timeout: 120000 }));
}

function seed(ui) {
  const dir = path.dirname(ui.rec.cli);
  const now = Math.floor(Date.now() / 1000);
  const items = [];
  const add = (kind, list, extra) => list.forEach(([title, text], i) => {
    const project = PROJECTS[i % 3];
    const at = now - 180 - i * 180;
    items.push({ id: `ide:fx-${kind}-${i}`, kind, source: "ide", title, project, project_dir: path.join(ui.rec.root, "projects", project),
      phrase: text, at, stopped_at: at, recent: true, ...extra(title, text) });
  });
  add("approve", APPROVE, (_t, cmd) => ({ actions: ["allow", "deny"], tool: "Bash", arg: cmd }));
  add("decide", DECIDE, (_t, q) => ({ actions: ["pick"], question: q,
    options: [{ id: "a", label: "Compact rows", description: "Keep the current view compact." }, { id: "b", label: "Detailed cards", description: "Show the next action on each card." }] }));
  add("unread", UNREAD, () => ({ actions: ["read", "open"] }));
  fs.writeFileSync(path.join(dir, "waiting-fixture.json"), JSON.stringify({ items, gone: [] }));
  const waiting = path.join(dir, "waiting.py");
  const text = fs.readFileSync(waiting, "utf8");
  if (!text.includes("waiting-fixture.json")) {
    fs.appendFileSync(waiting, STUB);
    // a development build's instance runs the build tree's own CLI: the stand-ins come out of it again
    process.on("exit", () => { fs.writeFileSync(waiting, text); fs.rmSync(path.join(dir, "waiting-fixture.json"), { force: true }); });
  }
  // the Only-you tasks: real ones, two per project
  return ONLY.map((title, i) => cli(ui, ["need-you", title, "--project", PROJECTS[i % 3], "--why", "Use the sample project to review this step."]));
}


async function until(ui, fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms * SCALE) throw new Error(`timed out waiting for ${what}`);
    await ui.sleep(500);
  }
}

/** First-run tips (the Getting started tour) can sit over the page: close them before a picture, like a person would. */
function closeTipsBeforePictures(ui) {
  const shoot = ui.screenshot.bind(ui);
  ui.screenshot = async (...args) => {
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    return shoot(...args);
  };
}

/** A letter key on the page (the runner's press knows named keys only); the page's own key handler takes it. */
async function letter(ui, ch) {
  const base = { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, ...base });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await ui.sleep(400);
}

export default async function (ui) {
  closeTipsBeforePictures(ui);
  await ui.openAgents(ui.demoFolder);
  const tasks = seed(ui);
  assert.equal(tasks.length, 6);
  // the pictures are light first, dark at the end (step 7)
  await ui.setTheme("light");
  // Settings left open (by a scenario before this one) holds the side bar: close it, as a person would
  const settingsNav = { css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false };
  if (await ui.exists(settingsNav)) {
    await ui.click({ css: ".dispatch-settings-nav .dsn-back", webview: false }); // ‹ Sessions
    await ui.waitFor(settingsNav, { gone: true, timeoutMs: 10000 });
  }
  await ui.click({ css: ".dispatch-waiting-section" });
  await ui.waitFor({ css: ".dispatch-waiting-page" }, { timeoutMs: 30000 });
  // 2026-11-11 direction A (task-0v1o9): no project rows any more; one row per thing in This week, the newest first,
  // three aligned columns (project, what is asked, how long), each handled on its own (its card, or the keys)
  const rows = () => ui.eval(`[...document.querySelectorAll('.dispatch-waiting-rows[data-group="week"] .dispatch-waiting-row')].map(r => ({ id: r.dataset.id, kind: r.dataset.kind, project: r.querySelector('.dispatch-waiting-project').innerText, ask: r.querySelector('.dispatch-waiting-ask').innerText }))`);
  await until(ui, async () => (await rows()).length >= 28, "the 28 rows", 60000);

  // 1 every thing a row of its own, in This week (all of them moved in the last hour)
  const first = await rows();
  assert.equal(await ui.eval(`document.querySelectorAll('.dispatch-waiting-proj-head').length`), 0, "no project rows");
  assert.ok(PROJECTS.every(p => first.filter(r => r.project === p).length >= 8), "every project's things are on the page: " + JSON.stringify(first.map(r => r.project)));
  assert.deepEqual([...new Set(first.map(r => r.ask))].sort(), ["Approve", "Only you", "Pick", "Reply"]);
  assert.match(await ui.eval(`document.querySelector('.session-section.dispatch-waiting-section .session-section-count')?.innerText || ''`), /^(28|29)$/, "the side bar counts all of this week's");
  await ui.screenshot("01-this-week");
  await ui.mark({ css: '.dispatch-waiting-rows[data-group="week"] .dispatch-waiting-row' }, { what: "一件事一行", where: "This week，新的在前", how: "项目、要你做什么、多久三列对齐；悬停出卡片，点开去处理" });

  // 2 Allow one from its card: the row goes, the count drops by one
  const approve0 = `.dispatch-waiting-row[data-id="ide:fx-approve-0"]`;
  await ui.scrollTo("Build the checkout page");
  await ui.hover({ css: approve0 }, { settleMs: 1500 });
  await until(ui, () => ui.eval(`!!document.querySelector('.dispatch-hover-card[data-waiting-id="ide:fx-approve-0"]')`), "the row's card", 10000);
  await ui.screenshot("02-card");
  await ui.click({ text: "Allow", exact: true, within: '.dispatch-hover-card[data-waiting-id="ide:fx-approve-0"]' });
  await until(ui, async () => !(await rows()).some(r => r.id === "ide:fx-approve-0"), "the allowed row leaving");
  await ui.mouse("mouseMoved", 700, 8);
  await ui.sleep(800);
  await ui.screenshot("03-handled");

  // 3 keys: ↓ (as j) moves the focus down the rows, a allows the approval in focus
  const focused = () => ui.eval(`document.querySelector('.dispatch-waiting-item.focus')?.dataset.id || ''`);
  await ui.eval(`document.querySelector('.dispatch-waiting-page.dispatch-waiting-a').focus()`);
  for (let i = 0; i < 40 && !/^ide:fx-approve-/.test(await focused()); i++) await ui.press("ArrowDown");
  const target = await focused();
  assert.match(target, /^ide:fx-approve-/, "↓ reaches an approval");
  await letter(ui, "a");
  await until(ui, async () => !(await rows()).some(r => r.id === target), "a allows it");
  assert.match(await ui.eval(`document.querySelector('.dispatch-waiting-toast')?.innerText || ''`), /^Allowed: /);

  // 4 Only you: a real task Done (Enter), then Undo brings it back (and reopens it on the board)
  for (let i = 0; i < 60 && !/^task:/.test(await focused()); i++) await ui.press("ArrowUp"); // the Only-you tasks were filed last: the newest, at the top
  const task = await focused();
  assert.match(task, /^task:/, "↓ reaches an Only-you task");
  await ui.press("Enter");
  await until(ui, async () => !(await rows()).some(r => r.id === task), "the task done");
  await ui.screenshot("04-only-you-done");
  await ui.click({ css: ".dispatch-waiting-toast-undo" });
  await until(ui, async () => (await rows()).some(r => r.id === task), "Undo brings the task back", 30000);
  await until(ui, async () => cli(ui, ["task", "show", task.replace(/^task:/, "")]).bd_status !== "closed", "the task open again on the board", 30000);

  // 5 dark: the person's theme switch (Settings › Appearance), then back to the page
  await ui.setTheme("dark");
  await ui.sleep(800);
  await ui.click({ css: ".dispatch-waiting-section" });
  await until(ui, async () => (await rows()).length >= 26, "the page again");
  await ui.sleep(500);
  await ui.screenshot("05-dark");
}
