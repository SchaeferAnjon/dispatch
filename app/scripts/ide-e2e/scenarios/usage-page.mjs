// The Usage page, direction A "All on one page" (kanban task-it54z, design/usage-v2/proto-a.html), on made-up data
// (fixtures/usage_data.py): three Claude accounts, Codex, GLM and DeepSeek; sixty days of sessions in four engines.
// Walks it the way a person does: opens it from Settings, reads every section, hovers a chart, switches API value and
// the 7-day window, goes through the tool tabs and the Unused filter, clicks a session, reopens the page (it must open
// on the last reading at once), and looks at it in the dark theme. Writes facts.json next to the screenshots.
// Nothing here starts an agent or asks a server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = {
  title: "Usage 页：一页全摆开（额度、花费、工具、全年）",
  description: "三个 Claude 号、Codex、GLM、DeepSeek 各一张卡；14 天图分账号、没读数的时段画虚线；花费按引擎、项目、模型、会话；工具六个页签和没用过的；全年按引擎上色。",
  instance: { fixture: "usage-data" },
  timeout: 900,
};

const facts = {};
const save = (ui) => fs.writeFileSync(path.join(ui.out, "facts.json"), JSON.stringify(facts, null, 1));
const PAGE = ".dispatch-settings-page .dispatch-usage-page";

async function until(ui, fn, what, ms = 20000) {
  const end = Date.now() + ms * SCALE;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await ui.sleep(400);
  }
}

async function closeTip(ui) {
  if (await ui.exists({ css: ".dispatch-tour", webview: false })) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => undefined);
    await ui.sleep(500);
  }
}

const READ = `(() => {
  const page = document.querySelector('${PAGE}');
  if (!page) return null;
  const q = (s, r = page) => [...r.querySelectorAll(s)];
  const txt = (e) => (e?.textContent || '').trim();
  const part = (p) => page.querySelector('[data-part="' + p + '"]');
  return {
    counting: !!page.querySelector('.dispatch-usage-empty.counting'),
    read: txt(page.querySelector('.dispatch-usage-read')),
    window: page.querySelector('.dispatch-usage-seg button.on')?.dataset.window || '',
    cards: q('.dispatch-usage-acct').map(c => ({
      title: txt(c.querySelector('.nm')), plan: txt(c.querySelector('.pl')), tag: txt(c.querySelector('.tag')),
      meters: q('.dispatch-usage-meter', c).map(m => ({ level: m.classList.contains('hit') ? 'hit' : m.classList.contains('warn') ? 'warn' : '', value: m.getAttribute('aria-valuenow') })),
      text: txt(c),
    })),
    charts: q('.dispatch-usage-chart').map(c => ({
      title: txt(c.querySelector('.nm')), sub: txt(c.querySelector('.sub')), note: txt(c.querySelector('.note')),
      dashed: (c.querySelector('path.dashed')?.getAttribute('d') || '').length, solid: (c.querySelector('path.solid')?.getAttribute('d') || '').length,
      windows: q('rect.win', c).length, hits: q('rect.win.hit', c).length,
    })),
    kpis: q('.dispatch-usage-kpi').map(k => ({ l: txt(k.querySelector('.l')), v: txt(k.querySelector('.v')), s: txt(k.querySelector('.s')) })),
    bars: q('.dispatch-usage-bars g[data-day]').length,
    barLegend: txt(page.querySelector('.dispatch-usage-bars .dispatch-usage-legend')),
    metric: page.querySelector('.dispatch-usage-metric button.on')?.dataset.m || '',
    where: q('.dispatch-usage-col').map(c => ({ title: txt(c.querySelector('.dispatch-usage-col-title')), rows: q('.rk', c).map(r => txt(r.querySelector('.rk-l')) + ' ' + txt(r.querySelector('.rk-v'))) })),
    sessions: q('[data-part="sessions"] tbody tr').map(r => q('td', r).map(txt)),
    sessionsMeta: txt(part('sessions')?.querySelector('.dispatch-usage-head-meta')),
    toolsMeta: txt(part('tools')?.querySelector('.dispatch-usage-head-meta')),
    tabs: q('.dispatch-usage-tabs button').map(b => ({ k: b.dataset.k, text: txt(b), on: b.classList.contains('on') })),
    filter: txt(page.querySelector('.dispatch-usage-toolbar .dispatch-usage-btn')),
    table: { head: q('[data-part="tools"] thead th').map(txt), rows: q('[data-part="tools"] tbody tr').map(r => q('td', r).map(td => ({ t: txt(td), c: td.className }))) },
    unused: txt(part('unused')),
    heatEngines: [...new Set(q('.dispatch-usage-cell[data-engine]').map(c => c.dataset.engine))],
    heatCells: q('.dispatch-usage-cell[data-engine]').length,
    activityMeta: txt(part('activity')?.querySelector('.dispatch-usage-head-meta')),
    heatLegend: txt(part('activity')?.querySelector('.dispatch-usage-legend')),
    colors: { claude: getComputedStyle(page).getPropertyValue('--dispatch-usage-claude-code').trim(), amber: getComputedStyle(page).getPropertyValue('--u-amber').trim() },
    width: Math.round(page.getBoundingClientRect().width),
    overflow: page.scrollWidth > page.clientWidth + 1,
    wide: q('*').filter(e => e.getBoundingClientRect().right > page.getBoundingClientRect().right + 1 && !e.closest('.dispatch-usage-tablewrap')).slice(0, 6).map(e => e.tagName + '.' + e.className),
  };
})()`;

const read = (ui) => ui.eval(READ);
const ready = (ui) => until(ui, async () => { const r = await read(ui); return r && !r.counting && r.cards.length ? r : null; }, "the Usage page with its numbers", 240000);

async function openUsage(ui) {
  if (!(await ui.exists({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }))) await ui.press("Cmd+,");
  await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="account"]', webview: false });
  await ui.sleep(600);
  await ui.scrollTo("Open Usage").catch(() => undefined);
  await ui.click({ text: "Open Usage" });
}

async function section(ui, part, name) {
  await ui.eval(`document.querySelector('${PAGE} [data-part="${part}"]')?.scrollIntoView({ block: 'start' })`);
  await ui.sleep(500);
  await ui.screenshot(name);
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.sleep(6000);
  await closeTip(ui);
  await ui.setTheme("light");

  // ---- the first opening: the CLI reads everything once, the page says so and fills in by itself ---------------------
  await openUsage(ui);
  await ui.sleep(1200);
  facts.first = await read(ui);
  if (facts.first?.counting) await ui.screenshot("00-first-reading");
  const r = await ready(ui);
  facts.page = r;
  save(ui);
  await section(ui, "allowance-now", "01-allowance-now");
  await ui.mark({ css: `${PAGE} [data-part="allowance-now"]`, webview: false }, { what: "每个账号一张卡：三个 Claude 号、Codex、GLM、DeepSeek", where: "设置 › Account and usage › Usage 最上面", how: "Open Usage" });
  await section(ui, "allowance-history", "02-allowance-history");
  await ui.mark({ css: `${PAGE} [data-part="allowance-history"]`, webview: false }, { what: "每个号一张 14 天图，没读数的时段是虚线，上面一排是 5 小时窗口", where: "Allowance over 14 days", how: "往下翻" });

  // hover a chart where nothing was read, and a 5-hour window
  const chart = { css: `${PAGE} .dispatch-usage-chart svg`, webview: false };
  await ui.hover(chart);
  await ui.sleep(900);
  facts.chartHover = await ui.eval("(() => { const h = [...document.querySelectorAll('.workbench-hover, .monaco-hover, .workbench-hover-container')].map(e => e.innerText).filter(Boolean); return { text: h.join(' | '), n: h.length, cross: !!document.querySelector('.dispatch-usage-svg .cross.on') }; })()");
  await ui.screenshot("03-chart-hover");
  if (await ui.exists({ css: `${PAGE} rect.win.hit`, webview: false })) {
    await ui.hover({ css: `${PAGE} rect.win.hit`, webview: false });
    await ui.sleep(900);
    facts.windowHover = await ui.eval("(() => { const h = [...document.querySelectorAll('.workbench-hover, .monaco-hover, .workbench-hover-container')].map(e => e.innerText).filter(Boolean); return { text: h.join(' | '), n: h.length, cross: !!document.querySelector('.dispatch-usage-svg .cross.on') }; })()");
  }

  // money
  await section(ui, "money", "04-money-tokens");
  await ui.click({ css: `${PAGE} .dispatch-usage-metric button[data-m="usd"]`, webview: false });
  await ui.sleep(500);
  facts.apiValue = await read(ui);
  await ui.screenshot("05-money-api-value");
  await ui.mark({ css: `${PAGE} [data-part="money"]`, webview: false }, { what: "三个数：token、订阅按 API 标价折算、按次付的钱；柱子可切 Tokens / API value", where: "Tokens and money", how: "点 API value" });
  await ui.hover({ css: `${PAGE} .dispatch-usage-bars g[data-day]:last-of-type`, webview: false }).catch(() => undefined);
  await ui.sleep(700);
  facts.barHover = await ui.eval("(() => { const h = [...document.querySelectorAll('.workbench-hover, .monaco-hover, .workbench-hover-container')].map(e => e.innerText).filter(Boolean); return { text: h.join(' | '), n: h.length, cross: !!document.querySelector('.dispatch-usage-svg .cross.on') }; })()");

  await section(ui, "where", "06-where-and-sessions");
  await ui.mark({ css: `${PAGE} [data-part="where"]`, webview: false }, { what: "按项目、按模型、按引擎", where: "Where it went", how: "往下翻" });
  // the costliest session opens in the middle of the window (Claude Code's own history lists it)
  const firstTitle = facts.page.sessions[0][0];
  await ui.click({ css: `${PAGE} [data-part="sessions"] tbody tr`, webview: false });
  await ui.sleep(2500);
  facts.sessionClick = await ui.eval(`({ settings: !!document.querySelector('${PAGE}'), title: [...document.querySelectorAll('.part.titlebar, .sessions-chat-editor, .agent-session-title, .monaco-workbench')].map(e => e.innerText).join(' ').includes(${JSON.stringify(firstTitle)}), toast: document.querySelector('.notifications-toasts')?.innerText || '' })`);
  await ui.screenshot("07-session-opened");
  await openUsage(ui);
  await ready(ui);

  // tools
  await section(ui, "tools", "08-tools-mcp");
  await ui.mark({ css: `${PAGE} [data-part="tools"]`, webview: false }, { what: "工具六个页签：调用次数、会话、项目、最近一次、失败率", where: "Tools, skills and MCP", how: "往下翻" });
  facts.mcp = (await read(ui)).table;
  await ui.click({ css: `${PAGE} .dispatch-usage-toolbar .dispatch-usage-btn`, webview: false });
  await ui.sleep(400);
  facts.mcpUnused = (await read(ui)).table;
  await ui.screenshot("09-tools-unused");
  for (const k of ["skills", "agents", "hooks", "commands", "builtin"]) {
    await ui.click({ css: `${PAGE} .dispatch-usage-tabs button[data-k="${k}"]`, webview: false });
    await ui.sleep(300);
    facts["tab_" + k] = (await read(ui)).table;
  }
  await ui.click({ css: `${PAGE} .dispatch-usage-tabs button[data-k="hooks"]`, webview: false });
  await ui.sleep(300);
  await ui.screenshot("10-tools-hooks");
  await ui.click({ css: `${PAGE} .dispatch-usage-toolbar .dispatch-usage-btn`, webview: false });
  await ui.sleep(300);
  facts.hooksFailing = (await read(ui)).table;

  await section(ui, "activity", "11-activity");
  await ui.mark({ css: `${PAGE} [data-part="activity"]`, webview: false }, { what: "全年每天按引擎上色", where: "Activity，页面最下面", how: "往下翻" });

  // the 7-day window
  const top = () => ui.eval(`document.querySelector('${PAGE} .dispatch-usage-bar')?.scrollIntoView({ block: 'center' })`);
  await top();
  await ui.sleep(300);
  await ui.click({ css: `${PAGE} .dispatch-usage-seg button[data-window="7"]`, webview: false });
  await ui.sleep(700);
  facts.week = await read(ui);
  await section(ui, "money", "12-seven-days");
  await top();
  await ui.sleep(300);
  await ui.click({ css: `${PAGE} .dispatch-usage-seg button[data-window="30"]`, webview: false });
  save(ui);

  // reopening: the last reading at once
  await ui.press("Escape");
  await ui.sleep(800);
  const t0 = Date.now();
  await openUsage(ui);
  await until(ui, async () => { const x = await read(ui); return x && x.cards.length; }, "the page again", 30000);
  facts.reopenMs = Date.now() - t0;

  // dark
  await ui.setTheme("dark");
  await openUsage(ui);
  await ready(ui);
  await section(ui, "allowance-now", "13-dark-allowance");
  await section(ui, "money", "14-dark-money");
  await section(ui, "activity", "15-dark-activity");
  facts.dark = (await read(ui)).colors;
  await ui.setTheme("system");
  save(ui);

  // ---- the checks ---------------------------------------------------------------------------------------------------
  const P = facts.page;
  const card = (t) => P.cards.find((c) => c.title.startsWith(t));
  const one = card("Claude · sam.rivera"), two = card("Claude · sam.work"), unnamed = card("Claude · 2nd");
  assert.ok(one && /In use/.test(one.tag) && one.plan === "Max 20x", `the account in use: ${JSON.stringify(one)}`);
  assert.ok(two && two.plan === "Max 5x" && two.meters.some((m) => m.level === "hit"), `the account at its limit: ${JSON.stringify(two)}`);
  assert.ok(unnamed && /unnamed/.test(unnamed.tag), `the readings no account has: ${JSON.stringify(P.cards.map((c) => c.title))}`);
  const codex = card("Codex");
  assert.ok(codex && codex.plan === "Plus" && /reported no limits/.test(codex.text), `Codex: ${JSON.stringify(codex)}`);
  const glm = card("GLM Coding Plan");
  assert.ok(glm && glm.meters.some((m) => m.level === "warn"), `GLM at 84%: ${JSON.stringify(glm)}`);
  assert.ok(/¥26\.59/.test(card("DeepSeek")?.text || ""), "DeepSeek's balance");
  assert.equal(P.charts.length, 4, `one chart per account and Codex: ${JSON.stringify(P.charts.map((c) => c.title))}`);
  const oneChart = P.charts.find((c) => /sam\.rivera/.test(c.title));
  assert.ok(oneChart.dashed > 0 && oneChart.solid > 0, "the gap of four days is drawn dashed, the readings solid");
  assert.ok(P.charts.some((c) => c.hits > 0), "a 5-hour window at the limit is coral");
  assert.ok(/Peak/.test(facts.windowHover?.text || ""), `a 5-hour window's hover: ${JSON.stringify(facts.windowHover)}`);
  assert.ok(facts.barHover?.n > 0, `a day's bar has a hover: ${JSON.stringify(facts.barHover)}`);
  assert.ok(facts.chartHover?.cross, `the chart follows the pointer: ${JSON.stringify(facts.chartHover)}`);
  assert.ok(/Not read|Week|No reading/.test(facts.chartHover?.text || ""), `the chart's hover: ${JSON.stringify(facts.chartHover)}`);
  assert.equal(P.kpis.length, 3);
  assert.match(P.kpis[1].v, /^\$\d/);
  assert.match(P.kpis[2].s, /^DeepSeek \$0\.\d\d/);
  assert.equal(P.bars, 30, "a bar a day for thirty days");
  assert.equal(facts.apiValue.metric, "usd");
  assert.deepEqual(P.where.map((c) => c.title), ["By project", "By model", "By engine"]);
  assert.match(P.where[0].rows[0], /^kanban /);
  assert.ok(P.sessions.length >= 5, "the costliest sessions");
  assert.ok(!facts.sessionClick.settings && (facts.sessionClick.title || /not in the Agents window/.test(facts.sessionClick.toast)), `clicking a session: ${JSON.stringify(facts.sessionClick)}`);
  assert.match(P.toolsMeta, /calls · [\d.]+% failed · last 30 days/);
  assert.deepEqual(P.tabs.map((t) => t.k), ["mcp", "skills", "agents", "hooks", "commands", "builtin"]);
  const chrome = facts.mcp.rows.find((r) => r[0].t === "Claude in Chrome");
  assert.ok(chrome && /err|warn/.test(chrome[6].c), `Claude in Chrome fails often: ${JSON.stringify(chrome)}`);
  assert.ok(facts.mcpUnused.rows.some((r) => r[0].t === "harbor") && facts.mcpUnused.rows.every((r) => r[1].t === "0"), "Unused lists harbor, all at 0 calls");
  assert.match(P.unused, /sign-in connector/);
  assert.match(P.unused, /teaching-master|getnote/);
  assert.match(P.unused, /sonnet-max/);
  assert.ok(facts.tab_skills.rows.some((r) => r[0].t === "designer"), "skills");
  assert.ok(facts.tab_agents.rows.some((r) => r[0].t.startsWith("opus-high")), "sub-agents");
  assert.ok(facts.hooksFailing.rows.some((r) => r[0].t === "cc-status-hook"), "the failing hook");
  assert.ok(facts.tab_builtin.rows.some((r) => r[0].t === "exec_command" && r[6].t === "not recorded"), "Codex tools: failures not recorded");
  assert.equal(facts.week.window, "7");
  assert.notEqual(facts.week.kpis[0].v, P.kpis[0].v, "7 days count fewer tokens than 30");
  assert.equal(facts.week.bars, 7);
  assert.ok(P.heatEngines.length >= 3, `the year in the engines' colours: ${P.heatEngines}`);
  assert.ok(P.heatCells >= 30);
  assert.ok(!P.overflow && !P.wide.length, `nothing sticks out sideways: ${JSON.stringify(P.wide)}`);
  assert.ok(facts.reopenMs < 6000 * SCALE, `reopening took ${facts.reopenMs} ms`);
  assert.ok(facts.dark.claude && facts.dark.claude !== P.colors.claude, "the engine colours follow the theme");
}
