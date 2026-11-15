// The bottom bar's Builds block tells the person only about their own builds (task-7ve7v). With the world of
// fixtures/builds_block.py: three agents' test builds failed and one is compiling, and one full package of yours
// stopped while compiling. The bar turns hot for yours alone ("Build failed", not "4 builds failed"); the agents'
// running build is one quiet block; the Builds panel says where yours stopped, where its log is and offers Try again,
// and keeps the agents' builds in a folded group without warnings. Then yours goes away and the bar stays calm; then
// the agents' build ends too and the block leaves. Everything is checked from the DOM; the pictures are only kept.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const meta = { instance: { fixture: "builds-block" }, title: "底栏构建块", description: "只有你的构建失败才提醒；Agent 的测试构建安静地折叠在 Builds 面板里。" };

const BAR = ".dispatch-status-bar";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const report = {};
const save = (ui) => fs.writeFileSync(path.join(ui.out, "builds-block.json"), JSON.stringify(report, null, 1));
const state = (ui) => ui.eval(`(() => {
  const vis = e => e && !e.hidden && !!e.offsetParent;
  const f = document.querySelector('${BAR} [data-part="build-failed"]');
  const b = document.querySelector('${BAR} [data-part="builds"]');
  return {
    failed: vis(f) ? { text: f.innerText.trim(), hot: f.classList.contains('hot') } : null,
    builds: vis(b) ? { hot: b.classList.contains('hot'), agents: b.querySelectorAll('.dispatch-status-qb.agents').length, run: b.querySelectorAll('.dispatch-status-qb.run').length, blocks: b.querySelectorAll('.dispatch-status-qb').length, text: b.innerText.trim() } : null,
  };
})()`);
const panelText = (ui) => ui.eval(`(document.querySelector('.dispatch-status-panel.builds') || {}).innerText || ''`);

async function until(ui, what, test, ms = 30000) {
  const end = Date.now() + ms * SCALE;
  let s;
  while (Date.now() < end) {
    s = await state(ui);
    if (test(s)) return s;
    // the bar asks again when the window gets focus (else every 20 s)
    await ui.eval("window.dispatchEvent(new Event('focus'))");
    await ui.sleep(1000);
  }
  assert.fail(`${what}: ${JSON.stringify(s)}`);
}

async function closePanel(ui) {
  await ui.press("Escape");
  await ui.sleep(300);
  await ui.hover({ css: ".agent-sessions-workbench" }).catch(() => {});
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  await ui.waitFor({ css: BAR }, { timeoutMs: 30000 });

  // 1. one failure of yours: hot, singular; the agents' three failures are not counted; their running build is one quiet block
  const s1 = await until(ui, "the bar shows yours failed and the agents' build as one quiet block", (s) => s.failed && s.builds);
  report.bar = s1;
  assert.equal(s1.failed.text, "Build failed", "one failure: yours, not the agents' three (no \"4 builds failed\")");
  assert.ok(s1.failed.hot, "a failure of yours needs you");
  assert.equal(s1.builds.hot, false, "the queue block itself is never hot");
  assert.deepEqual([s1.builds.agents, s1.builds.run], [1, 0], "the agents' running build: one quiet block, no progress block of yours");
  await ui.screenshot("01-bar-yours-failed");
  // other blocks may still come and go (Mac busy): hover again until the tip is this block's
  const tip = () => ui.eval(`[...document.querySelectorAll('.monaco-hover, .workbench-hover')].filter(h => h.offsetParent).map(h => h.innerText.trim()).join('\\n')`);
  for (let i = 0; i < 5 && !/did not build/.test(report.failedTip || ""); i++) {
    await ui.hover({ css: ".agent-sessions-workbench" }).catch(() => {});
    await ui.sleep(400);
    await ui.hover({ css: `${BAR} [data-part="build-failed"]` });
    await ui.sleep(1400);
    report.failedTip = await tip();
    for (let j = 0; j < 20 * SCALE && !report.failedTip; j++) { await ui.sleep(300); report.failedTip = await tip(); } // a busy Mac shows the tip later
  }
  save(ui);
  assert.match(report.failedTip, /Your build did not build/, "the tip says it is your build");
  assert.match(report.failedTip, /compiling and packaging/, "the tip says where it stopped");
  save(ui);

  // 2. its panel: where yours stopped, the last line of its log, where the log is, Log and Try again; the agents folded
  await ui.mark({ css: `${BAR} [data-part="build-failed"]` }, { what: "Build failed", where: "bottom bar, right", how: "only a build of yours; click for why" });
  await ui.click({ css: `${BAR} [data-part="build-failed"]` });
  await ui.waitFor({ css: ".dispatch-status-panel.builds" }, { timeoutMs: 5000 });
  const p = await ui.eval(`(() => {
    const panel = document.querySelector('.dispatch-status-panel.builds');
    const row = panel.querySelector('.dispatch-status-prow.failed');
    const group = panel.querySelector('.dispatch-status-pgroup');
    return {
      text: panel.innerText,
      failedRows: panel.querySelectorAll('.dispatch-status-prow.failed').length,
      buttons: row ? [...row.querySelectorAll('button')].map(b => b.innerText.trim()) : [],
      retryTitle: row ? ([...row.querySelectorAll('button')].find(b => /Try again/.test(b.innerText)) || {}).title || '' : '',
      why: (row && row.querySelector('.dispatch-status-prow-why') || {}).innerText || '',
      log: (row && row.querySelector('.dispatch-status-prow-log') || {}).innerText || '',
      group: group ? { head: group.querySelector('.dispatch-status-pgroup-head').innerText.trim(), open: !group.querySelector('.dispatch-status-pgroup-body').hidden, expanded: group.querySelector('.dispatch-status-pgroup-head').getAttribute('aria-expanded') } : null,
    };
  })()`);
  report.panel = p;
  save(ui);
  assert.equal(p.failedRows, 1, "one failure row: yours");
  assert.match(p.text, /Stopped while compiling and packaging/, "says which step failed");
  assert.match(p.why, /error TS2322/, "shows the last line its log said");
  assert.match(p.log, /^Log: ~?\/.*9999eeeeffff\/build\.log on the Mac mini$/, "says where the log is");
  assert.deepEqual(p.buttons, ["Log", "Try again"], "Log and Try again");
  assert.match(p.retryTitle, /dispatch build start 9999eeeeffff --rebuild/, "Try again says what it runs when hovered");
  assert.deepEqual(p.group, { head: "Agents' test builds · 4", open: false, expanded: "false" }, "the agents' builds: one folded group");
  await ui.screenshot("02-panel-yours");

  // 3. unfold the group: the agents' builds, no warning icons, nothing hot
  await ui.click({ css: ".dispatch-status-pgroup-head" });
  await ui.sleep(400);
  const g = await ui.eval(`(() => {
    const body = document.querySelector('.dispatch-status-pgroup-body');
    const row = document.querySelector('.dispatch-status-prow.failed').getBoundingClientRect();
    const head = document.querySelector('.dispatch-status-pgroup-head').getBoundingClientRect();
    return { overlap: Math.max(0, row.bottom - head.top), open: !body.hidden, text: body.innerText, warnings: body.querySelectorAll('.codicon-warning').length, failedRows: body.querySelectorAll('.dispatch-status-prow.failed').length, rows: body.querySelectorAll('.dispatch-status-prow').length, retry: [...body.querySelectorAll('button')].filter(b => /Try again/.test(b.innerText)).length };
  })()`);
  report.group = g;
  save(ui);
  assert.ok(g.open, "the group unfolds");
  assert.equal(g.overlap, 0, "your failure row keeps its height: it never runs into the group's head");
  assert.equal(g.rows, 4, "the four agents' builds");
  assert.deepEqual([g.warnings, g.failedRows, g.retry], [0, 0, 0], "no warnings, no failure styling, no Try again in the agents' group");
  assert.match(g.text, /Didn't pass its checks/);
  assert.match(g.text, /Nothing here needs you/);
  await ui.screenshot("03-panel-agents-open");
  await closePanel(ui);

  // looking at the panel is enough: the hot block goes away
  const s2 = await until(ui, "the failure block goes once seen", (s) => !s.failed);
  report.afterSeen = s2;

  // 4. Try again: a terminal in the bottom panel runs `dispatch build start <commit> --rebuild`. The fixture has no
  // repository, so the CLI stops at once with exit 1 and VS Code names the command it ran: that is the evidence.
  const terms = () => ui.eval(`[...document.querySelectorAll('.part.panel .terminal-outer-container .xterm')].filter(e => e.offsetParent).length`);
  report.terminalsBefore = await terms();
  await ui.click({ css: `${BAR} [data-part="builds"]` });
  await ui.waitFor({ css: ".dispatch-status-panel.builds" }, { timeoutMs: 5000 });
  await ui.click({ text: "Try again", within: ".dispatch-status-panel.builds" });
  const ran = () => ui.eval(`[...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).find(v => /'build', 'start', '9999eeeeffff', '--rebuild'/.test(v)) || ''`);
  for (let i = 0; i < 30 * SCALE && !(report.terminalCommand = await ran()); i++) await ui.sleep(500);
  report.terminalsAfter = await terms();
  save(ui);
  await ui.screenshot("04-try-again-terminal");
  assert.equal(report.terminalsBefore, 0);
  assert.ok(report.terminalsAfter >= 1, "Try again opens a terminal in the bottom panel");
  assert.match(report.terminalCommand, /'build', 'start', '9999eeeeffff', '--rebuild'/, "the terminal runs build start <commit> --rebuild");

  // 5. yours gone (built again elsewhere): only the agents' build runs. No hot block, no failure count; one quiet block
  const bdir = ui.rec.builds_dir;
  fs.rmSync(path.join(bdir, "9999eeeeffff"), { recursive: true, force: true });
  const s3 = await until(ui, "only the agents' running build: calm", (s) => !s.failed && s.builds && s.builds.agents === 1);
  report.agentsOnly = s3;
  assert.equal(s3.builds.hot, false);
  assert.equal(s3.builds.blocks, 1, "one block for the agents, nothing else");
  await ui.screenshot("05-bar-agents-only");

  // 6. the agents' build ends with a failure too: the block leaves, nothing turns hot
  fs.writeFileSync(path.join(bdir, "7777dddd8888-dev", "status"), "failed 2 30\n");
  fs.rmSync(path.join(bdir, ".dev.lock.name"), { force: true });
  const s4 = await until(ui, "the agents' builds all failed: the bar says nothing", (s) => !s.failed && !s.builds);
  report.quiet = s4;
  await ui.screenshot("06-bar-quiet");
  save(ui);
}
