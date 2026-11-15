// Waiting for you: picking several, Done on them, Mark all read (user 2026-11-15, task-ccmyi: put back what 11-11
// took out without asking), and no Timeline entry in the side bar or the Command Palette (the page waits to be redone).
// The Only-you tasks are real tasks on the instance's board (`dispatch need-you`): Done closes them through the real
// `dispatch waiting done a,b`, and the board is read back. The unread replies and the approval are stand-ins written
// into the instance's own CLI copy (as in waiting-by-project: no agent finishes three replies on cue); Mark all read
// goes through the real bridge and `dispatch waiting read --all`, the stand-in answers only for its own rows.
// Path: the side bar (no Timeline), the palette (no Show Timeline), the page: pick one by its first slot, a second by
// ⌘-click, Done; x, ⇧j, Esc; ⇧-click a range, Clear; Mark all read; ⌘-click and Enter.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

export const meta = {
  title: "Waiting for you：多选、批量完成、全部已读；左栏没有 Timeline",
  description: "左栏和命令面板里没有 Timeline 入口；Waiting for you 页点行首或 ⌘ 点勾选两件，页头 Done 批量完成（任务板上真的关掉），x、⇧j、Esc、⇧ 点一段，Mark all read 清掉没读的。",
  timeout: 900,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const MIN = 60;

// the session rows: three unread replies and one approval, answered in place (nothing real behind them)
const STUB = `
# ---- e2e scenario waiting-select: sessions that wait, read from waiting-fixture.json next to this file ----
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
    return dict(data, items=items, counts=counts(items, data.get("seen_at") or 0))
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

const UNREAD = [["Checkout keyboard review", "All fields can be reached with Tab.", 20 * MIN], ["Notes search is ready", "Search now matches notebook titles.", 50 * MIN],
  ["API error messages", "Errors include a retry action.", 90 * MIN]];
const ONLY = ["Sign the vendor contract", "Pay the domain renewal", "Record the demo video"];

function env(ui) {
  return { ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_DIR: ui.rec.dispatch_dir,
    BEADS_DIR: ui.rec.beads_dir, DISPATCH_BIN: ui.rec.cli, DISPATCH_FACTS_FILE: path.join(ui.rec.root, "rules/FACTS.md") };
}
function cli(ui, args) {
  const out = execFileSync("python3", [ui.rec.cli, ...args, "--json"], { env: env(ui), cwd: ui.demoFolder, encoding: "utf8", timeout: 120000 });
  return JSON.parse(out.slice(out.indexOf("{")));
}
/** The task's status on the instance's board. */
function boardStatus(ui, id) {
  return cli(ui, ["task", "show", id]).bd_status;
}

const restore = [];

function seed(ui) {
  const dir = path.dirname(ui.rec.cli);
  const now = Math.floor(Date.now() / 1000);
  const items = UNREAD.map(([title, phrase, ago], i) => ({ id: `ide:fx-sel-unread-${i}`, kind: "unread", source: "ide", title, project: "demo",
    project_dir: ui.demoFolder, phrase, at: now - ago, stopped_at: now - ago, actions: ["read", "open"] }));
  items.push({ id: "ide:fx-sel-approve-0", kind: "approve", source: "ide", title: "Run the release checks", project: "demo", project_dir: ui.demoFolder,
    phrase: "npm test", at: now - 30 * MIN, stopped_at: now - 30 * MIN, actions: ["allow", "deny"], tool: "Bash", arg: "npm test" });
  fs.writeFileSync(path.join(dir, "waiting-fixture.json"), JSON.stringify({ items, gone: [] }));
  const waiting = path.join(dir, "waiting.py");
  const text = fs.readFileSync(waiting, "utf8");
  if (!text.includes("waiting-fixture.json")) {
    fs.appendFileSync(waiting, STUB);
    // a development build's instance runs the build tree's own CLI: the stand-ins come out of it again
    restore.push(() => { fs.writeFileSync(waiting, text); fs.rmSync(path.join(dir, "waiting-fixture.json"), { force: true }); });
  }
  return ONLY.map(title => cli(ui, ["need-you", title, "--project", "demo", "--why", "Seeded by the waiting-select scenario."]));
}

async function until(ui, fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms * SCALE) throw new Error(`timed out waiting for ${what}`);
    await ui.sleep(400);
  }
}

async function theme(ui, value) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const file = path.join(dir, "User/settings.json");
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    Object.assign(settings, { "window.autoDetectColorScheme": false, "workbench.colorTheme": value === "light" ? "Dispatch Light" : "Dispatch Dark" });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  const wanted = value === "light" ? "vs" : "vs-dark";
  await until(ui, () => ui.eval(`document.querySelector('.monaco-workbench').classList.contains('${wanted}')`), `the ${value} theme`, 15000);
  await ui.sleep(400);
}

/** Both themes, the same picture: <name>-light.png and <name>-dark.png. */
async function both(ui, name) {
  for (const t of ["light", "dark"]) {
    await theme(ui, t);
    await ui.screenshot(`${name}-${t}`);
  }
  await theme(ui, "light");
}

function save(ui, name, value) {
  fs.writeFileSync(path.join(ui.out, `${name}.json`), JSON.stringify(value, null, 2));
}

/** A key on the page with its modifiers (the runner's press knows named keys only); the page's own handler takes it. */
async function key(ui, k, { shift = false } = {}) {
  const named = { Escape: [27, "Escape"], Enter: [13, "Enter"] }[k];
  const code = named ? named[0] : k.toUpperCase().charCodeAt(0);
  const text = named ? (k === "Enter" ? "\r" : undefined) : (shift ? k.toUpperCase() : k);
  const base = { key: named ? k : text, code: named ? named[1] : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
  await ui.cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await ui.sleep(400);
}

/** A click with ⌘ (4) or ⇧ (8) held, on the middle of an element (its title, for a row). */
async function modClick(ui, css, modifiers) {
  const box = await ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  assert.ok(box, `nothing to click: ${css}`);
  await ui.mouse("mouseMoved", box.x, box.y);
  await ui.mouse("mousePressed", box.x, box.y, { clickCount: 1, modifiers });
  await ui.mouse("mouseReleased", box.x, box.y, { clickCount: 1, modifiers });
  ui.dirty = true;
  await ui.sleep(500);
}

const ROW = id => `.dispatch-waiting-row[data-id="${id}"]`;

/** The page as the person sees it: the head line, the rows, what is picked and where the keys act. */
function page(ui) {
  return ui.eval(`(() => {
    const p = document.querySelector('.dispatch-waiting-page.dispatch-waiting-a');
    if (!p) return null;
    const head = p.querySelector('.dispatch-waiting-head');
    const btn = t => [...(head?.querySelectorAll('button') || [])].find(b => b.innerText.trim() === t);
    const rows = [...p.querySelectorAll('.dispatch-waiting-row')].filter(r => !r.classList.contains('leaving')).map(r => {
      const check = r.querySelector('.dispatch-waiting-check');
      const shown = e => !!e && getComputedStyle(e).display !== 'none';
      const mark = check && [...check.querySelectorAll('.dispatch-mark')].find(shown);
      return { id: r.dataset.id, kind: r.dataset.kind, title: r.querySelector('.dispatch-waiting-title').innerText, selectable: r.classList.contains('selectable'),
        selected: r.classList.contains('selected'), focus: r.classList.contains('focus'), checked: check?.getAttribute('aria-checked') || null,
        kindShown: shown(r.querySelector('.dispatch-wait-kind')), checkShown: shown(check), mark: mark ? [...mark.classList].filter(c => c.startsWith('codicon-') || c === 'todo' || c === 'seen').join(' ') : null,
        bg: getComputedStyle(r).backgroundColor };
    });
    const r = el => el && el.getBoundingClientRect();
    const readall = btn('Mark all read');
    const age = p.querySelector('.dispatch-waiting-age');
    return {
      head: head && { h: Math.round(r(head).height), text: head.innerText.replace(/\\s+/g, ' ').trim(), sticky: getComputedStyle(head).position,
        intro: head.querySelector('.dispatch-waiting-intro')?.innerText || null, sel: head.querySelector('.dispatch-waiting-selinfo')?.innerText || null,
        buttons: [...head.querySelectorAll('button')].map(b => b.innerText.trim()),
        readallTextRight: readall ? Math.round(r(readall).right - parseFloat(getComputedStyle(readall).paddingRight)) : null, ageRight: age ? Math.round(r(age).right) : null },
      rows, selecting: p.classList.contains('selecting'), toast: document.querySelector('.dispatch-waiting-toast.on')?.innerText.replace(/\\s+/g, ' ').trim() || '',
      keys: p.querySelector('.dispatch-waiting-keys')?.innerText.replace(/\\s+/g, ' ').trim() || '', overflow: p.scrollWidth > p.clientWidth + 1,
      card: [...document.querySelectorAll('.dispatch-hover-card')].some(c => c.getBoundingClientRect().width > 0),
      domFocus: (() => { const a = document.activeElement; const row = a?.closest?.('.dispatch-waiting-row'); return row ? { id: row.dataset.id, outline: getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth } : null; })(),
    };
  })()`);
}

export default async function (ui) {
  const checks = [];
  const check = (cond, what) => { assert.ok(cond, what); checks.push(what); };
  try {
    await run(ui, check);
  } finally {
    save(ui, "checks", checks);
    for (const undo of restore.splice(0)) {
      undo();
    }
  }
}

async function run(ui, check) {
  await ui.openAgents(ui.demoFolder);
  await theme(ui, "light");
  const made = seed(ui);
  const tasks = made.map(t => t.id || t.task);
  check(tasks.length === 3 && tasks.every(t => /^task-/.test(t || "")), `three Only-you tasks on the board (${tasks.join(" ")})`);
  const seeded = ui.rec.seed.tasks.only_you;

  // 1. the side bar: under Waiting for you comes Automations, no Timeline entry
  await until(ui, () => ui.eval(`document.querySelectorAll('.session-section.dispatch-wait-row').length >= 3`), "the side bar's rows", 60000);
  const side = await ui.eval(`(() => {
    const rows = [...document.querySelectorAll('.sessions-list-control .monaco-list-row')];
    const end = rows.find(r => r.classList.contains('dispatch-group-end'));
    const labels = rows.map(r => r.querySelector('.session-section-label')?.innerText.trim() || '');
    return { timelineEntry: !!document.querySelector('.session-section.dispatch-timeline-section'), timelineRow: labels.includes('Timeline'),
      next: end ? rows[rows.indexOf(end) + 1]?.innerText.trim() : null, labels: labels.filter(Boolean).slice(0, 12) };
  })()`);
  save(ui, "sidebar", side);
  check(!side.timelineEntry && !side.timelineRow, `no Timeline entry in the side bar (${side.labels.join(" | ")})`);
  check(/^Automations/.test(side.next || ""), `the row after the Waiting for you group is Automations (${side.next})`);
  ui.dirty = true;
  await ui.mark({ css: ".sessions-list-control .monaco-list-row.dispatch-group-end" }, { what: "Waiting for you 这一组的最后一行：下面直接是 Automations，不再挂 Timeline 入口", where: "左栏上段", how: "打开就在" });
  await both(ui, "sidebar-no-timeline");

  // 2. the Command Palette has no Show Timeline either
  for (let p = 0; p < 5 && !(await ui.exists({ css: ".quick-input-widget input" })); p++) {
    await ui.press("F1");
    await ui.sleep(800);
  }
  await ui.type("Show Timeline", { into: { css: ".quick-input-widget input" } });
  await ui.sleep(1200);
  const palette = await ui.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  save(ui, "palette", palette);
  check(!palette.some(t => /Show Timeline/i.test(t)), `the Command Palette has no Show Timeline (${palette.slice(0, 5).join(" | ") || "nothing"})`);
  await ui.screenshot("palette-no-timeline-light");
  await ui.press("Escape");

  // 3. the page: four Only-you tasks, three unread replies, one approval; the head line with Mark all read
  await ui.click({ css: ".session-section.dispatch-waiting-section" });
  await ui.waitFor({ css: ".dispatch-waiting-page.dispatch-waiting-a" }, { timeoutMs: 20000 });
  let p = await until(ui, async () => { const x = await page(ui); return x && x.rows.length >= 8 ? x : null; }, "the eight rows", 60000);
  save(ui, "page-start", p);
  const byTitle = t => p.rows.find(r => r.title === t);
  const [a, b, c] = ONLY.map(byTitle);
  const approve = p.rows.find(r => r.kind === "approve");
  check(a && b && c && approve, "the Only-you tasks and the approval are on the page");
  check(p.rows.filter(r => r.selectable).length === 7 && !approve.selectable, `the Only-you tasks and the unread replies can be picked, the approval cannot (${p.rows.map(r => `${r.kind}:${r.selectable}`).join(" ")})`);
  check(p.head.h === 28 && p.head.sticky === "sticky" && /^Newest first/.test(p.head.intro || "") && p.head.buttons.join("|") === "Mark all read" && !p.head.sel,
    `head line: 28 high, sticky, the intro and only Mark all read (${JSON.stringify(p.head)})`);
  check(Math.abs(p.head.readallTextRight - p.head.ageRight) <= 1, `Mark all read's words end where the age column ends (${p.head.readallTextRight} / ${p.head.ageRight})`);
  check(p.rows.every(r => r.kindShown && !r.checkShown && !r.selected), "nothing picked: every row shows what it is, no round marks");

  // 4. the first slot: hovered, a selectable row's icon turns into the empty circle; the approval's does not
  await ui.hover({ css: `${ROW(approve.id)} .dispatch-waiting-slot` }, { settleMs: 300 });
  p = await page(ui);
  check(p.rows.find(r => r.id === approve.id).kindShown, "the approval's slot hovered: still its shield, nothing to pick");
  await ui.hover({ css: `${ROW(a.id)} .dispatch-waiting-slot` }, { settleMs: 1800 });
  p = await page(ui);
  check(!p.card, "the slot hovered for 1.8 s: no card over the rows below");
  const hovered = p.rows.find(r => r.id === a.id);
  check(!hovered.kindShown && hovered.checkShown && /codicon-circle-large\b/.test(hovered.mark) && /todo/.test(hovered.mark), `the slot hovered: the empty circle from dispatchMarks (${hovered.mark})`);
  await ui.screenshot("slot-hover-light");

  // 5. pick one by its slot, a second by ⌘-click: "2 selected", Done and Clear; the page stays
  await ui.click({ css: `${ROW(a.id)} .dispatch-waiting-slot` });
  p = await page(ui);
  check(p.head.sel === "1 selected" && p.rows.find(r => r.id === a.id).selected && p.rows.find(r => r.id === a.id).checked === "true", `a click on the slot picks it (${p.head.sel})`);
  await modClick(ui, `${ROW(b.id)} .dispatch-waiting-title`, 4);
  p = await page(ui);
  check(!!(await ui.exists({ css: ".dispatch-waiting-page.dispatch-waiting-a" })), "⌘-click did not open the row: still on the page");
  check(p.head.sel === "2 selected" && p.head.buttons.join("|") === "Done|Clear", `⌘-click picks a second: 2 selected, Done, Clear (${JSON.stringify(p.head)})`);
  const picked = p.rows.filter(r => r.selected);
  check(picked.length === 2 && picked.every(r => /codicon-pass-filled\b/.test(r.mark) && /seen/.test(r.mark)), `the picked rows show the filled check (${picked.map(r => r.mark).join(", ")})`);
  check(p.rows.filter(r => r.selectable && !r.selected).every(r => r.checkShown && /todo/.test(r.mark)) && p.rows.find(r => r.id === approve.id).kindShown,
    "while picking: the others that can be picked show the empty circle, the approval keeps its shield");
  check(picked[0].bg !== p.rows.find(r => r.id === c.id).bg, `a picked row has the selection background (${picked[0].bg})`);
  await modClick(ui, `${ROW(approve.id)} .dispatch-waiting-title`, 4);
  p = await page(ui);
  check(p.head.sel === "2 selected" && !!(await ui.exists({ css: ".dispatch-waiting-page.dispatch-waiting-a" })), "⌘-click on the approval: not picked, the page stays");
  check(p.domFocus && /^none /.test(p.domFocus.outline), `the row clicked has no focus outline (${JSON.stringify(p.domFocus)})`);
  await ui.hover({ css: `${ROW(c.id)} .dispatch-waiting-title` }, { settleMs: 1800 });
  check(!(await page(ui)).card, "while picking, a row hovered for 1.8 s shows no card");
  check(/x select/.test(p.keys) && /done/.test(p.keys) && /esc clear/.test(p.keys), `the keys say x select, ⏎ done, esc clear (${p.keys})`);
  await ui.mouse("mouseMoved", 700, 8);
  await ui.sleep(600);
  ui.dirty = true;
  await ui.mark({ css: ".dispatch-waiting-head" }, { what: "选中两件时的页头一行：2 selected，行尾 Done 和 Clear", where: "页面最上面，吸顶", how: "点行首那一格或 ⌘ 点一行" });
  await ui.mark({ css: `${ROW(a.id)} .dispatch-waiting-slot` }, { what: "点行首那一格选中：变成实心圆勾（符号表的圆）", where: "行首 14 的槽", how: "点它；⇧ 点选一段" });
  await ui.mark({ css: ROW(b.id) }, { what: "⌘ 点一行也选中，选中的行底色加深", where: "This week", how: "⌘ 点；单击照旧打开" });
  await ui.mark({ css: ROW(approve.id) }, { what: "批准要回答，不能选，行首仍是盾牌", where: "This week", how: "悬停出卡片里 Allow / Deny" });
  await both(ui, "page-two-selected");

  // 6. Done: both leave the page and are closed on the board; the head line is back to the intro
  await ui.click({ text: "Done", exact: true, within: ".dispatch-waiting-head" });
  await until(ui, async () => { const x = await page(ui); return x && !x.rows.some(r => r.id === a.id || r.id === b.id); }, "the two rows leaving", 20000);
  p = await page(ui);
  check(/^Done: 2 items/.test(p.toast), `the toast says Done: 2 items with Undo (${p.toast})`);
  check(!p.head.sel && /^Newest first/.test(p.head.intro || "") && !p.selecting, "nothing picked any more: the head line is the intro again");
  const after = await until(ui, async () => { const s = tasks.slice(0, 2).map(t => boardStatus(ui, t)); return s.every(x => x === "closed") ? s : null; }, "both tasks closed on the board", 30000);
  check(after.every(s => s === "closed"), `on the board: ${ONLY[0]} and ${ONLY[1]} closed`);
  check(boardStatus(ui, tasks[2]) !== "closed" && boardStatus(ui, seeded) !== "closed", "the ones not picked are still open on the board");
  const listed = cli(ui, ["waiting"]).items.filter(i => i.kind === "only_you").map(i => i.task);
  check(!listed.includes(tasks[0]) && !listed.includes(tasks[1]) && listed.includes(tasks[2]), `dispatch waiting no longer lists them (${listed.join(" ")})`);
  await ui.screenshot("page-after-done-light");

  // 7. the keys: x picks the row in focus and takes it back, ⇧j picks while moving, Esc clears and stays on the page
  await modClick(ui, `${ROW(c.id)} .dispatch-waiting-title`, 4); // picks it and puts the focus on it
  p = await page(ui);
  check(p.head.sel === "1 selected" && p.rows.find(r => r.id === c.id).focus, "⌘-click picks it and puts the focus on it");
  await key(ui, "x");
  p = await page(ui);
  check(!p.head.sel && !p.rows.some(r => r.selected), "x on a picked row takes it back");
  const order = p.rows.map(r => r.id);
  const at = order.indexOf(c.id);
  const next = p.rows[at + 1];
  await key(ui, "j", { shift: true });
  p = await page(ui);
  const want = [c, next].filter(r => r && r.selectable).length;
  check(p.rows.filter(r => r.selected).length === want && p.rows.find(r => r.focus)?.id === next?.id, `⇧j picks the row left and the one reached (${p.head.sel}; next ${next?.kind})`);
  await key(ui, "Escape");
  p = await page(ui);
  check(!p.head.sel && !p.rows.some(r => r.selected) && !!(await ui.exists({ css: ".dispatch-waiting-page.dispatch-waiting-a" })), "Esc clears the selection and stays on the page");

  // 8. ⇧-click picks a range (only the rows that can be picked), Clear takes it all back
  const sel = p.rows.filter(r => r.selectable);
  const first = sel[0], last = sel[sel.length - 1];
  await ui.click({ css: `${ROW(first.id)} .dispatch-waiting-slot` });
  await modClick(ui, `${ROW(last.id)} .dispatch-waiting-slot`, 8);
  p = await page(ui);
  const span = p.rows.slice(p.rows.findIndex(r => r.id === first.id), p.rows.findIndex(r => r.id === last.id) + 1);
  check(p.rows.filter(r => r.selected).length === span.filter(r => r.selectable).length && !p.rows.find(r => r.kind === "approve").selected,
    `⇧-click picks the range, the approval in it left out (${p.head.sel})`);
  await ui.screenshot("page-range-light");
  await ui.click({ text: "Clear", exact: true, within: ".dispatch-waiting-head" });
  p = await page(ui);
  check(!p.head.sel && !p.rows.some(r => r.selected), "Clear picks nothing");

  // 9. Mark all read: every unread reply leaves, the CLI lists none, the button goes
  check(p.head.buttons.includes("Mark all read"), "Mark all read is there while replies are unread");
  await ui.click({ text: "Mark all read", exact: true, within: ".dispatch-waiting-head" });
  await until(ui, async () => { const x = await page(ui); return x && !x.rows.some(r => r.kind === "unread"); }, "the unread rows leaving", 20000);
  p = await page(ui);
  check(/^Marked read: 3 items/.test(p.toast), `the toast says Marked read: 3 items (${p.toast})`);
  const counts = await until(ui, async () => { const w = cli(ui, ["waiting"]); return w.counts.unread === 0 ? w.counts : null; }, "no unread in dispatch waiting", 30000);
  check(counts.unread === 0, "dispatch waiting lists no unread reply");
  p = await until(ui, async () => { const x = await page(ui); return x && !x.head.buttons.includes("Mark all read") ? x : null; }, "Mark all read to go", 20000);
  check(!p.head.buttons.length && /^Newest first/.test(p.head.intro || ""), `nothing unread: the head line is the intro alone (${JSON.stringify(p.head.buttons)})`);
  ui.dirty = true;
  await ui.mark({ css: ".dispatch-waiting-head" }, { what: "没有没读的回话时，页头只剩一行灰字", where: "页面最上面", how: "点过 Mark all read 之后" });
  await both(ui, "page-after-readall");

  // 10. ⌘-click and Enter: the seeded task done from the keyboard, closed on the board
  await modClick(ui, `${ROW(`task:${seeded}`)} .dispatch-waiting-title`, 4);
  p = await page(ui);
  check(p.head.sel === "1 selected", "⌘-click picks the seeded task");
  await key(ui, "Enter");
  await until(ui, async () => { const x = await page(ui); return x && !x.rows.some(r => r.id === `task:${seeded}`); }, "the seeded task leaving", 20000);
  await until(ui, async () => boardStatus(ui, seeded) === "closed", "the seeded task closed on the board", 30000);
  check(true, "Enter with a selection: Done, the task closed on the board");
  save(ui, "page-end", await page(ui));
}
