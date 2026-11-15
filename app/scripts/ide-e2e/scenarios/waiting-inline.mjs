// Waiting for you in the left side bar (design/home-now direction A, picked 2026-11-11, task-0v1o9): the entry
// shows this week's number, the newest three things hang right under it, "Show N more" opens the rest in place,
// "N older" opens the page with Older open; a thing not touched for 7 days is Older and does not count. The page:
// This week and Older, rows in three aligned columns. A thing and its session's row light up together, and a
// session that works or waits stays in sight when its folder is closed. Every row in this group waits, so its first
// slot says what the thing is (DESIGN.md 符号表, 2026-11-12, task-he465): a page to pick from, a question, an approval,
// something only the person can do. The icon says what the thing is and the third column what is asked, apart: only a
// design direction from the board (a proposal page) is the proposal glyph, an engine's question with options is a
// question that still says Pick; the hover cards draw the same icon for the same thing.
// The things that wait are stand-ins written into this instance's own CLI copy (waiting-fixture.json, as in
// waiting-by-project), next to the seeded Only-you task (real, on the instance's board) and one real OpenCode
// session that stops on a question (the cheap model, ui.cheapModel), so the linked rows are a real session's.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

export const meta = {
  title: "Waiting for you：左栏露最近 3 件，7 天规则",
  description: "左栏 Waiting for you 下面直接挂最近 3 件，Show N more 就地展开，N older 打开页面；超过 7 天没动的进 Older、不计数；页面分 This week 和 Older；等你的行和它的会话行联动悬停；文件夹收起时在做和等你的会话还露着。",
  needs: ["opencode"],
  timeout: 900,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const MIN = 60, HOUR = 3600, DAY = 86400;

// appended to the instance's own waiting.py: stand-in sessions that wait, read from waiting-fixture.json next to it
const STUB = `
# ---- e2e scenario waiting-inline: things that wait, read from waiting-fixture.json next to this file ----
import json as _fx_json, os as _fx_os
_FX = _fx_os.path.join(_fx_os.path.dirname(_fx_os.path.abspath(__file__)), "waiting-fixture.json")
def _fx_load():
    try:
        with open(_FX, encoding="utf-8") as f:
            return _fx_json.load(f)
    except (OSError, ValueError):
        return {"items": []}
_fx_collect = collect
def collect(*args, **kw):
    data = _fx_collect(*args, **kw)
    items = data["items"] + [dict(it) for it in _fx_load()["items"]]
    return dict(data, items=items, counts=counts(items, data.get("seen_at") or 0))
`;

function env(ui) {
  return { ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_DIR: ui.rec.dispatch_dir,
    BEADS_DIR: ui.rec.beads_dir, DISPATCH_BIN: ui.rec.cli, DISPATCH_FACTS_FILE: path.join(ui.rec.root, "rules/FACTS.md") };
}
function cli(ui, args) {
  return execFileSync("python3", [ui.rec.cli, ...args], { env: env(ui), cwd: ui.demoFolder, encoding: "utf8", timeout: 120000 });
}

/** Stand-ins: [kind, title, project, how long ago, board?]. A board one is a design direction: a proposal page to pick from. */
function fixture(ui, rows) {
  const dir = path.dirname(ui.rec.cli);
  const now = Math.floor(Date.now() / 1000);
  const items = rows.map(([kind, title, project, ago, board], i) => {
    const at = now - ago;
    if (board) {
      return { id: `task:fx-inline-${i}`, kind, source: "board", task: `task-fxinline${i}`, title, project, project_dir: path.join(ui.rec.root, "projects", project),
        phrase: title, at, created_at: at, actions: ["pick"], question: `${title}?`, options: [{ key: "A", title: "Thin lines" }, { key: "B", title: "Filled" }] };
    }
    const base = { id: `ide:fx-inline-${i}`, kind, source: "ide", title, project, project_dir: path.join(ui.rec.root, "projects", project), phrase: title, at, stopped_at: at };
    return kind === "approve" ? { ...base, actions: ["allow", "deny"], tool: "Bash", arg: "npm test" }
      : kind === "decide" ? { ...base, actions: ["pick"], question: `${title}?`, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
        : { ...base, actions: ["read", "open"] };
  });
  fs.writeFileSync(path.join(dir, "waiting-fixture.json"), JSON.stringify({ items }));
  const waiting = path.join(dir, "waiting.py");
  const text = fs.readFileSync(waiting, "utf8");
  if (!text.includes("waiting-fixture.json")) {
    restore.push(() => { fs.writeFileSync(waiting, text); fs.rmSync(path.join(dir, "waiting-fixture.json"), { force: true }); });
    fs.appendFileSync(waiting, STUB);
  }
}

/** A development build's instance runs the build tree's own CLI: the stand-ins come out of it again at the end. */
const restore = [];

// six this week (with the seeded Only-you task, seven), three older than a week
const WEEK = [
  ["decide", "Pick the icon set: A, B or C", "dispatch", 12 * MIN, true],
  ["approve", "Run the release checks in a fresh VM", "dispatch", 2 * HOUR],
  ["unread", "Privacy page: how to count readers", "askfree", 5 * HOUR],
  ["decide", "Reading app home: A or B", "discus", 1 * DAY + HOUR],
  ["approve", "Members checkout goes live", "meetcaption", 3 * DAY],
  ["unread", "Pricing by language: your call", "meetcaption", 6 * DAY],
];
const OLDER = [
  ["decide", "Redesign every page with the designer", "shufang-reader", 9 * DAY],
  ["unread", "Bring back the old Docs filter?", "dispatch", 15 * DAY],
  ["decide", "Find every version of the start animation", "kanban", 31 * DAY],
];

async function until(ui, fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms * SCALE) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await ui.sleep(500);
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

/** A row's first slot: which thing it says (data-thing), its icon's class, its name, size and colour. */
const KIND_OF = `const kindOf = k => {
      if (!k) return null;
      const r = k.getBoundingClientRect(), cs = getComputedStyle(k), before = getComputedStyle(k, '::before');
      return { thing: k.dataset.thing, icon: [...k.classList].find(c => c.startsWith('codicon-')), role: k.getAttribute('role'), label: k.getAttribute('aria-label'),
        w: Math.round(r.width), font: cs.fontSize, color: cs.color, glyph: before.content, family: before.fontFamily };
    };`;

/** What the side bar shows under Waiting for you, measured. */
function sidebar(ui) {
  return ui.eval(`(() => {
    ${KIND_OF}
    const list = document.querySelector('.sessions-list-control .monaco-list');
    const row = el => el.closest('.monaco-list-row');
    const entry = document.querySelector('.session-section.dispatch-waiting-section');
    const items = [...document.querySelectorAll('.session-section.dispatch-wait-row')].map(e => ({
      id: e.dataset.waitingId, title: e.querySelector('.session-section-label').innerText, age: e.querySelector('.session-section-count').innerText,
      h: Math.round(e.getBoundingClientRect().height), kind: kindOf(e.querySelector('.dispatch-wait-kind')), dot: !!e.querySelector('.dispatch-wait-dot'),
      slot: Math.round(e.querySelector('.session-section-icon').getBoundingClientRect().width), linked: row(e).classList.contains('dispatch-linked'),
      clipped: e.querySelector('.session-section-label').scrollWidth > e.querySelector('.session-section-label').clientWidth + 1 }));
    const fold = c => { const e = document.querySelector('.session-section.dispatch-wait-fold.' + c); return e ? { text: e.innerText.trim(), h: Math.round(e.getBoundingClientRect().height) } : null; };
    const end = document.querySelector('.sessions-list-control .monaco-list-row.dispatch-group-end');
    const count = entry?.querySelector('.session-section-count');
    return {
      gap: end ? Math.round(end.getBoundingClientRect().height - end.querySelector('.session-section').getBoundingClientRect().height) : null,
      entry: entry && { h: Math.round(entry.getBoundingClientRect().height), count: count && count.style.display !== 'none' ? count.innerText.trim() : '',
        bell: entry.querySelector('.session-section-icon').classList.contains('codicon-bell'), icon: Math.round(entry.querySelector('.session-section-icon').getBoundingClientRect().width) },
      items, more: fold('more'), older: fold('older'),
      overflow: list ? list.scrollWidth > list.clientWidth + 1 : null,
    };
  })()`);
}

/** The page's rows and columns, measured. */
function page(ui) {
  return ui.eval(`(() => {
    ${KIND_OF}
    const p = document.querySelector('.dispatch-waiting-page.dispatch-waiting-a');
    if (!p) return null;
    const rows = g => [...p.querySelectorAll('.dispatch-waiting-rows[data-group="' + g + '"] .dispatch-waiting-row')].map(r => {
      const w = s => Math.round(r.querySelector(s).getBoundingClientRect().width);
      return { id: r.dataset.id, title: r.querySelector('.dispatch-waiting-title').innerText, ask: r.querySelector('.dispatch-waiting-ask').innerText, age: r.querySelector('.dispatch-waiting-age').innerText,
        h: Math.round(r.getBoundingClientRect().height), project: w('.dispatch-waiting-project'), askW: w('.dispatch-waiting-ask'), ageW: w('.dispatch-waiting-age'),
        kind: kindOf(r.querySelector('.dispatch-wait-kind')), ring: !!r.querySelector('.dispatch-waiting-ring'), dot: !!r.querySelector('.dispatch-waiting-dot'), right: Math.round(r.querySelector('.dispatch-waiting-age').getBoundingClientRect().right), rowRight: Math.round(r.getBoundingClientRect().right),
        titleColor: getComputedStyle(r.querySelector('.dispatch-waiting-title')).color, text2: getComputedStyle(r.querySelector('.dispatch-waiting-project')).color };
    });
    const fold = p.querySelector('.dispatch-waiting-fold[data-group="older"]');
    return { intro: p.querySelector('.dispatch-waiting-intro')?.innerText, week: rows('week'), older: rows('older'),
      fold: fold && { open: fold.getAttribute('aria-expanded') === 'true', text: fold.innerText.replace(/\\s+/g, ' ').trim() },
      overflow: p.scrollWidth > p.clientWidth + 1 };
  })()`);
}

function save(ui, name, value) {
  fs.writeFileSync(path.join(ui.out, `${name}.json`), JSON.stringify(value, null, 2));
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
  const only = "Approve the demo release"; // the instance's seeded Only-you task, filed when it started

  // 1. three things this week: all three show, no Show more, no older
  fixture(ui, WEEK.slice(0, 2));
  await until(ui, async () => (await sidebar(ui)).entry?.count === "3", "the entry to count 3", 60000);
  let s = await sidebar(ui);
  save(ui, "sidebar-3", s);
  check(s.items.length === 3 && !s.more && !s.older, "three things: three rows, no Show more, no older");
  check(s.entry.h === 36 && s.entry.bell && s.entry.icon === 16, "entry: 36 high, a 16px bell");
  check(s.items.every(i => i.h === 32 && !i.dot && i.kind && i.kind.font === "14px" && i.kind.w === 14 && i.slot === 14), `rows 32 high, no amber dot, a 14px icon in a 14 slot (${JSON.stringify(s.items.map(i => i.kind))})`);
  check(s.gap === 8, `8 between the group and Automations under it (${s.gap})`);
  await both(ui, "sidebar-3");

  // 2. seven this week, three older
  fixture(ui, [...WEEK, ...OLDER]);
  await until(ui, async () => (await sidebar(ui)).entry?.count === "7", "the entry to count 7", 60000);
  s = await sidebar(ui);
  save(ui, "sidebar-7", s);
  check(s.entry.count === "7", "entry counts the 7 this week, not the 3 older");
  check(s.items.length === 3, "only the newest three show");
  check(s.items.map(i => i.title).join("|") === `${only}|${WEEK[0][1]}|${WEEK[1][1]}`, `the newest three, newest first (${s.items.map(i => i.title).join("|")})`);
  check(s.more?.text === "Show 4 more" && s.more.h === 28, "Show 4 more, 28 high");
  check(s.older?.text === "3 older" && s.older.h === 28, "3 older, 28 high");
  check(s.overflow === false, "the side bar does not scroll sideways");
  check(s.items.map(i => i.kind?.thing).join("|") === "only-you|proposal|approval" && s.items.map(i => i.kind?.label).join("|") === "Only you|Proposal|Approval",
    `the side bar's three: Only you, a proposal, an approval, each named so (${s.items.map(i => `${i.kind?.thing}/${i.kind?.label}`).join(" ")})`);
  // the stand-ins changed the screen without a click: the marks below get a picture of this screen, not step 1's
  ui.dirty = true;
  await ui.mark({ css: ".session-section.dispatch-waiting-section" }, { what: "Waiting for you 入口：只数 7 天内的", where: "左栏最上面", how: "点它打开整页" });
  const SAYS = { proposal: "方案字形：一页方案等你挑", question: "问号：一个问题", approval: "盾牌：一次批准", "only-you": "人像：只有你能做的事" };
  for (const [i, it] of s.items.entries()) {
    await ui.mark({ css: ".session-section.dispatch-wait-row", index: i }, { what: `行首图标说这是什么，${SAYS[it.kind.thing]}`, where: "左栏 Waiting for you 下面", how: "点它做页面里同样的事；悬停出卡片" });
  }
  await ui.mark({ css: ".session-section.dispatch-wait-fold.more" }, { what: "Show N more：就地展开", where: "最近 3 件下面", how: "点它" });
  await ui.mark({ css: ".session-section.dispatch-wait-fold.older" }, { what: "N older：超过 7 天没动的", where: "最下面", how: "点它在中间打开页面" });
  await both(ui, "sidebar-7");

  // 3. Show 4 more opens the rest in place
  await ui.click({ css: ".session-section.dispatch-wait-fold.more" });
  await until(ui, async () => (await sidebar(ui)).items.length === 7, "seven rows after Show 4 more");
  s = await sidebar(ui);
  check(s.more?.text === "Show less" && s.items.length === 7 && s.overflow === false, `Show 4 more opens all seven in place, the row now says Show less (${s.more?.text})`);
  await both(ui, "sidebar-show-more");
  // the same row folds them again, and opens them once more for the steps below
  await ui.click({ css: ".session-section.dispatch-wait-fold.more" });
  await until(ui, async () => (await sidebar(ui)).items.length === 3, "three rows after Show less");
  s = await sidebar(ui);
  check(s.more?.text === "Show 4 more", `Show less folds back to three rows and Show 4 more (${s.more?.text})`);
  await ui.click({ css: ".session-section.dispatch-wait-fold.more" });
  await until(ui, async () => (await sidebar(ui)).items.length === 7, "seven rows again");

  // 4. a row's card on hover: what it asks and its buttons
  await ui.hover({ css: `.session-section.dispatch-wait-row[data-waiting-id="ide:fx-inline-1"]` }, { settleMs: 1500 });
  await until(ui, () => ui.eval(`!!document.querySelector('.dispatch-hover-card[data-waiting-id="ide:fx-inline-1"]')`), "the row's card", 10000);
  check(await ui.eval(`[...document.querySelector('.dispatch-hover-card[data-waiting-id="ide:fx-inline-1"]').querySelectorAll('button')].map(b => b.innerText.trim()).join('|').includes('Allow')`), "the row's card has Allow and Deny");
  await ui.screenshot("row-card-light");
  await ui.mouse("mouseMoved", 700, 8);
  await ui.sleep(900);

  // 5. click a row: what the page does with it (the Only-you task opens its task page)
  await ui.click({ css: ".session-section.dispatch-wait-row", index: 0 });
  await until(ui, () => ui.eval(`[...document.querySelectorAll('.custom-view-node, .custom-view-content')].some(e => e.getBoundingClientRect().width > 0 && e.innerText.includes(${JSON.stringify(only)}))`), "the task page", 20000);
  check(true, "a row click opens what the page opens (an Only-you task: its task page)");
  await both(ui, "row-click");

  // 6. N older opens the page with Older open; This week newest first; three aligned columns
  await ui.click({ css: ".session-section.dispatch-wait-fold.older" });
  await ui.waitFor({ css: ".dispatch-waiting-page.dispatch-waiting-a .dispatch-waiting-rows.older" }, { timeoutMs: 20000 });
  let p = await page(ui);
  save(ui, "page-older", p);
  check(p.week.length === 7 && p.older.length === 3, "page: This week 7, Older 3");
  check(p.week[0].title === only && p.week.slice(1).map(r => r.age).join(" ") === "12m 2h 5h 1d 3d 6d", `This week newest first (${p.week.map(r => r.age).join(" ")})`);
  check([...p.week, ...p.older].every(r => r.h === 32 && r.project === 112 && r.askW === 64 && r.ageW === 38), "rows 32 high; project 112, ask 64, age 38");
  check(new Set([...p.week, ...p.older].map(r => r.right)).size === 1, "the age column ends at one edge on every row");
  check(p.week.map(r => r.ask).join("|") === "Only you|Pick|Approve|Reply|Pick|Approve|Reply", `the ask words (${p.week.map(r => r.ask).join("|")})`);
  const all = [...p.week, ...p.older];
  s = await sidebar(ui);
  save(ui, "sidebar-with-page", s);
  check(all.every(r => !r.dot && !r.ring && r.kind && r.kind.w === 14 && r.kind.font === "14px" && r.kind.role === "img"), "every row: no dot or ring, a 14px icon named for screen readers");
  const NAME = { proposal: "Proposal", question: "Question", approval: "Approval", "only-you": "Only you" };
  check(all.every(r => r.kind.label === NAME[r.kind.thing]), "each icon is named with what the thing is (Proposal, Question, Approval, Only you)");
  // what the thing is, apart from what is asked: the board's direction is a proposal, an engine's question with options
  // a question that still says Pick, a reply a question too
  const THING = { "Pick the icon set: A, B or C": ["proposal", "Pick"], "Reading app home: A or B": ["question", "Pick"], "Privacy page: how to count readers": ["question", "Reply"],
    "Run the release checks in a fresh VM": ["approval", "Approve"], [only]: ["only-you", "Only you"] };
  const got = Object.keys(THING).map(t => { const r = all.find(x => x.title === t); return r && [r.kind.thing, r.ask]; });
  check(Object.values(THING).every((w, i) => got[i] && got[i][0] === w[0] && got[i][1] === w[1]), `the thing and the ask apart (${JSON.stringify(got)})`);
  // one screen, the four things: each its own icon, the same icon for the same thing (side bar and page alike)
  const icons = new Map();
  for (const r of [...all, ...s.items]) {
    icons.set(r.kind.thing, (icons.get(r.kind.thing) || new Set()).add(`${r.kind.icon} ${r.kind.glyph}`));
  }
  save(ui, "page-kinds", Object.fromEntries([...icons].map(([k, v]) => [k, [...v]])));
  const ICON = { proposal: "codicon-dispatch-proposal", question: "codicon-question", approval: "codicon-shield", "only-you": "codicon-person" };
  check(icons.size === 4 && [...icons].every(([k, v]) => v.size === 1 && [...v][0].startsWith(ICON[k] + " ")), `four things, each one icon of its own: ${[...icons].map(([k, v]) => `${k}=${[...v].join("/")}`).join(", ")}`);
  check(new Set([...icons.values()].map(v => [...v][0].split(" ").slice(1).join(" "))).size === 4, "the four icons draw four different glyphs");
  check(all.find(r => r.kind.thing === "proposal").kind.family.includes("dispatch-blocks"), "the proposal is Dispatch's own glyph (the blocks font)");
  // rgba(r, g, b, a) or, out of color-mix, color(srgb r g b / a)
  const alpha = c => { const m = /\/\s*([\d.]+)\s*\)$/.exec(c) || /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(c); return m ? Number(m[1]) : 1; };
  check(p.week.every(r => r.kind.color === r.text2) && p.older.every(r => Math.abs(alpha(r.kind.color) - 0.45 * alpha(p.week[0].kind.color)) < 0.02),
    `This week's icons in --text-2, Older's at 45 % (${p.week[0].kind.color} / ${p.older[0].kind.color})`);
  check(p.older[0].titleColor !== p.week[0].titleColor, "Older's titles are in the second text colour");
  check(p.fold.open && p.overflow === false, "Older open, no sideways scroll");
  await ui.mark({ css: ".dispatch-waiting-group-head" }, { what: "This week：新的在前", where: "页面上段", how: "7 天内动过的" });
  await ui.mark({ css: ".dispatch-waiting-rows[data-group=\"week\"]" }, { what: "This week 的行：行首细线图标说这是什么（方案页、问题、批准、只有你能做）", where: "页面上段", how: "「要你做什么」那一列另算：引擎问的带选项的问题是问号，列里仍写 Pick" });
  await ui.mark({ css: ".dispatch-waiting-rows[data-group=\"older\"]" }, { what: "Older 的行：同一枚图标，淡到 45%", where: "页面下段", how: "点 Older 展开" });
  await ui.mark({ css: ".dispatch-waiting-fold" }, { what: "Older：默认收着", where: "页面下段", how: "点它展开收起" });
  await both(ui, "page-older-open");

  // 7. Older closes and opens again
  await ui.click({ css: ".dispatch-waiting-fold" });
  p = await page(ui);
  check(!p.fold.open && p.older.length === 0, "Older closes");
  await both(ui, "page-older-closed");
  await ui.click({ css: ".dispatch-waiting-fold" });
  check((await page(ui)).older.length === 3, "Older opens again");

  // 8. the 7-day rule: a thing that turns 8 days old leaves the count and moves to Older
  fixture(ui, [...WEEK.slice(0, 5), [WEEK[5][0], WEEK[5][1], WEEK[5][2], 8 * DAY], ...OLDER]);
  await until(ui, async () => (await sidebar(ui)).entry?.count === "6", "the count to drop to 6", 30000);
  p = await page(ui);
  check(p.week.length === 6 && p.older.length === 4 && p.older[0].title === WEEK[5][1], "turned 8 days old: out of the count, first in Older");

  // 9. nothing waits: no number, no rows
  fixture(ui, []);
  cli(ui, ["done", ui.rec.seed.tasks.only_you, "--reason", "e2e waiting-inline"]);
  await until(ui, async () => { const x = await sidebar(ui); return x.items.length === 0 && !x.older; }, "nothing under Waiting for you", 30000);
  s = await sidebar(ui);
  save(ui, "sidebar-none", s);
  check(s.entry.count === "" && !s.more && !s.older, "nothing waits: no number, no rows");
  check(s.gap === 8, `nothing under the entry: the 8 is under the entry itself (${s.gap})`);
  await ui.press("Escape");
  await both(ui, "sidebar-none");
  // back to three or fewer, then five again: they fold again (Show more does not stay open)
  fixture(ui, WEEK.slice(0, 5));
  await until(ui, async () => (await sidebar(ui)).entry?.count === "5", "five again", 30000);
  s = await sidebar(ui);
  check(s.items.length === 3 && s.more?.text === "Show 2 more", `five again: three rows and Show 2 more (${s.items.length}, ${s.more?.text})`);
  fixture(ui, []);
  await until(ui, async () => (await sidebar(ui)).items.length === 0, "nothing again", 30000);

  // 10. a real session that stops on a question: its row under Waiting for you and its session row light up together;
  // its folder closed, it stays in sight
  await ui.newSession();
  await ui.pickEngine("OpenCode");
  await ui.sleep(6000);
  await ui.click({ css: ".sessions-chat-editor .monaco-editor .view-lines" });
  await ui.type("Use the question tool once to ask me: 'Which layout, A or B?' with header 'Layout' and two options A and B. Then wait for my answer.");
  await ui.press("Enter", { send: true });
  const real = await until(ui, () => ui.eval(`[...document.querySelectorAll('.session-section.dispatch-wait-row')].map(e => e.dataset.waitingId).find(id => id && id.startsWith('ide:')) || ''`),
    "the OpenCode session's question under Waiting for you", 300000);
  const sessionRow = `.sessions-list-control .monaco-list-row:has(.session-item.needs-input)`;
  await ui.waitFor({ css: sessionRow }, { timeoutMs: 30000 });
  await ui.hover({ css: `.session-section.dispatch-wait-row[data-waiting-id="${real}"]` });
  check(await ui.eval(`!!document.querySelector('${sessionRow}.dispatch-linked')`), "hover the waiting row: its session row lights up");
  const align = await ui.eval(`(() => {
    const x = s => Math.round(document.querySelector(s).getBoundingClientRect().x);
    return { icon: x('.session-section.dispatch-wait-row .session-section-icon'), title: x('.session-section.dispatch-wait-row .session-section-label'),
      sessionMark: x('${sessionRow} .session-icon'), sessionTitle: x('${sessionRow} .session-title') };
  })()`);
  save(ui, "align", align);
  check(Math.abs(align.icon - align.sessionMark) <= 1 && Math.abs(align.title - align.sessionTitle) <= 1, `the waiting rows' icon and title line up with a project's session row (${JSON.stringify(align)})`);
  await both(ui, "linked-from-waiting");
  await ui.hover({ css: sessionRow });
  check(await ui.eval(`document.querySelector('.session-section.dispatch-wait-row[data-waiting-id="${real}"]').closest('.monaco-list-row').classList.contains('dispatch-linked')`), "hover the session row: its waiting row lights up");
  await both(ui, "linked-from-session");
  await ui.mouse("mouseMoved", 700, 8);
  await ui.sleep(600);
  // the engine's question with options: a question in the side bar, the same icon in its project's hover card, and on
  // the page a question that still says Pick
  const realIcon = await ui.eval(`(() => { ${KIND_OF} return kindOf(document.querySelector('.session-section.dispatch-wait-row[data-waiting-id="${real}"] .dispatch-wait-kind')); })()`);
  let cardIcon = null;
  for (let i = 0; i < 3 && !cardIcon; i++) {
    // the side bar moves a row down a second or two after it opens: hover again until the card is there
    await ui.hover({ text: "demo", exact: true, within: ".sessions-list-control" }, { settleMs: 1500 });
    cardIcon = await until(ui, () => ui.eval(`(() => { const r = document.querySelector('.dispatch-hover-row[data-id="${real}"]'); if (!r) return null; const c = r.querySelector('.dispatch-hover-lead .codicon'); return c ? [...c.classList].find(x => x.startsWith('codicon-') && x !== 'codicon') : 'none'; })()`), "the project card's row", 10000).catch(() => null);
  }
  save(ui, "real-question", { realIcon, cardIcon });
  check(realIcon?.thing === "question" && realIcon.icon === "codicon-question" && realIcon.label === "Question", `the engine's question is a question in the side bar (${JSON.stringify(realIcon)})`);
  check(cardIcon === realIcon.icon, `its project's hover card draws the same icon (${cardIcon})`);
  await ui.screenshot("project-card-light");
  await ui.mouse("mouseMoved", 700, 8);
  await ui.sleep(900);
  await ui.click({ css: ".session-section.dispatch-waiting-section" });
  await ui.waitFor({ css: `.dispatch-waiting-row[data-id="${real}"]` }, { timeoutMs: 20000 });
  const realRow = (await page(ui)).week.find(r => r.id === real);
  save(ui, "real-question-page", realRow);
  check(realRow?.kind.thing === "question" && realRow.ask === "Pick", `on the page: a question icon, and the column still says Pick (${realRow?.kind.thing}, ${realRow?.ask})`);
  await both(ui, "page-real-question");
  const demoRow = `[...document.querySelectorAll('.sessions-list-control .monaco-list-row')].find(r => r.querySelector('.session-section-label')?.innerText.trim() === 'demo')`;
  if ((await ui.eval(`${demoRow}?.getAttribute('aria-expanded')`)) !== "false") {
    await ui.click({ text: "demo", exact: true, within: ".sessions-list-control" });
    await ui.sleep(1000);
  }
  const folded = await ui.eval(`(() => {
    const rows = [...document.querySelectorAll('.sessions-list-control .monaco-list-row')];
    const demo = ${demoRow};
    const live = rows.find(r => r.querySelector('.session-item.needs-input, .session-item.in-progress'));
    return { demoExpanded: demo?.getAttribute('aria-expanded'), live: !!live, liveAfterDemo: !!demo && !!live && rows.indexOf(live) === rows.indexOf(demo) + 1 };
  })()`);
  save(ui, "folded", folded);
  check(folded.demoExpanded === "false" && folded.live && folded.liveAfterDemo, "demo closed: the session that waits stays right under it");
  await both(ui, "folder-closed-live");

  // 11. no Timeline entry under the group any more (user 2026-11-15, task-ccmyi: the page waits to be redone): the row
  // after the group is Automations, no row says Timeline
  const tl = await ui.eval(`(() => { const rows = [...document.querySelectorAll('.sessions-list-control .monaco-list-row')]; const end = rows.find(r => r.classList.contains('dispatch-group-end')); return { entry: !!document.querySelector('.session-section.dispatch-timeline-section'), named: rows.some(r => r.querySelector('.session-section-label')?.innerText.trim() === 'Timeline'), next: end ? rows[rows.indexOf(end) + 1]?.innerText.trim() : null }; })()`);
  save(ui, "timeline-entry", tl);
  check(!tl.entry && !tl.named && /^Automations/.test(tl.next || ''), `no Timeline entry: Automations right under the group (${JSON.stringify(tl)})`);
  await both(ui, "no-timeline-entry");
}
