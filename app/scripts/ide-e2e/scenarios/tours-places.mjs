// Tips at the places that are easy to miss: the side pane's tabs, Tasks, Changes, Docs, a delivery and
// Waiting for you. Each comes the first time the place is reached by a real click, once, and the tab
// tip moves on by itself when the real tab is clicked. Getting started ticks the places off.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const meta = { instance: { tips: true },
  title: "各个地方的提示：右栏页签、Tasks、Changes、Docs、交付页、Waiting for you",
  description: "演示项目里真点进每个地方：第一次到那里出现提示，一次，点页签本身提示自动往下走；清单里对应的项自己打勾。",
};


/** The instance's own dispatch CLI, on the instance's board and data (never the caller's). */
function cli(ui, args) {
  const rec = ui.rec;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(k) && k !== "CLAUDECODE") env[k] = v;
  }
  Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli, DISPATCH_E2E_INSTANCE: rec.name,
    PATH: `${path.join(rec.app, "Contents", "Resources", "app", "tools")}:${process.env.PATH || "/usr/bin:/bin"}` });
  const r = spawnSync("python3", [rec.cli, ...args], { env, encoding: "utf8", timeout: 90000 });
  if (r.status !== 0) throw new Error(`dispatch ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
  return r.stdout;
}

const bubble = (ui) => ui.eval(`(() => {
  const t = document.querySelector('.dispatch-tour'); if (!t) return null;
  const r = t.getBoundingClientRect();
  return { step: t.dataset.step, side: t.dataset.side, title: t.querySelector('.dispatch-tour-title')?.textContent, count: t.querySelector('.dispatch-tour-count')?.textContent,
    buttons: [...t.querySelectorAll('.dispatch-tour-btn')].map(b => b.textContent), hidden: getComputedStyle(t).visibility === 'hidden',
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
})()`);

async function waitStep(ui, step, timeoutMs = 25000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await ui.sleep(300)) {
    const b = await bubble(ui);
    if (b && b.step === step && !b.hidden) return b;
  }
  throw new Error(`the tip "${step}" never showed; on screen: ${JSON.stringify(await bubble(ui))}`);
}

/** Walk a tour with Next to its end and say Got it; returns the step ids seen. */
async function walk(ui, first, expectedSteps) {
  const seen = [];
  let b = await waitStep(ui, first);
  await ui.sleep(900); // a page that is still drawing itself may add steps
  b = await bubble(ui);
  for (;;) {
    assert.ok(b.inside, `inside the window: ${JSON.stringify(b)}`);
    seen.push(b.step);
    await ui.screenshot(`tip-${b.step}`);
    if (b.buttons.includes("Got it")) {
      await ui.click({ text: "Got it", exact: true, within: ".dispatch-tour" });
      break;
    }
    await ui.click({ text: "Next", exact: true, within: ".dispatch-tour" });
    const before = b.step;
    for (const until = Date.now() + 8000; Date.now() < until; await ui.sleep(200)) {
      b = await bubble(ui);
      if (b && b.step !== before) break;
    }
    assert.notEqual(b?.step, before, "Next moves on");
  }
  if (expectedSteps) assert.deepEqual(seen, expectedSteps);
  return seen;
}

async function quiet(ui, ms, why) {
  for (const until = Date.now() + ms; Date.now() < until; await ui.sleep(500)) assert.equal(await bubble(ui), null, why);
}

async function checklist(ui) {
  const label = await ui.eval("document.querySelector('.dispatch-checklist-entry')?.getAttribute('aria-label') ?? null");
  const m = /(\d+) of (\d+)/.exec(label || "");
  return m ? Number(m[1]) : -1;
}

export default async function (ui) {
  await ui.attach("agents", 60000);
  await ui.sleep(7500);
  // a seeded design page, so Docs has something to open
  const designDir = path.join(ui.demoFolder, "design", "tips");
  fs.mkdirSync(designDir, { recursive: true });
  const page = path.join(designDir, "README.md");
  fs.writeFileSync(page, "# Tips demo\n\nA design page for the tips scenario.\n");
  const project = (ui.rec.seed && ui.rec.seed.project) || "demo";
  cli(ui, ["docs", "add", project, page, "--kind", "设计"]);

  // the first-run tips are not the point here: close them as they come
  // a tip that is still settling next to its place can move under the click: close it again until it is gone
  const closeFirst = async (step) => {
    await waitStep(ui, step, 150000);
    for (let i = 0; i < 4 && (await bubble(ui))?.step === step; i++) {
      await ui.click({ css: ".dispatch-tour-close" });
      for (const until = Date.now() + 3000; Date.now() < until && (await bubble(ui))?.step === step; ) await ui.sleep(300);
    }
  };
  await closeFirst("waiting-row");
  await closeFirst("new-workspace");
  // a plain launch opens only the Agents window: the Editor button brings up the editor window, which can take the Agents window to a folder
  await ui.click({ aria: "Editor", webview: false });
  await ui.attach("editor", 30000);
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.showSidePane();
  await ui.waitFor({ css: ".tabs-container .tab" }, { timeoutMs: 15000 });
  const startCount = await checklist(ui);
  // a first-run tip of another place still up (the Assistant's Start here): out of the way, as a person closes it
  for (let i = 0; i < 4; i++) {
    const b = await bubble(ui);
    if (!b || b.step === "changes-tab") break;
    await ui.click({ css: ".dispatch-tour-close" });
    await ui.sleep(800);
  }

  // 1. the side pane's tabs: the tip moves on by itself when the real tab is clicked
  const tabs = await waitStep(ui, "changes-tab", 30000);
  assert.equal(tabs.side, "bottom");
  assert.match(tabs.count, /^1 of [34]$/);
  await ui.screenshot("01-side-pane-tabs");
  await ui.mark({ css: ".dispatch-tour" }, { what: "右栏页签的提示", where: "贴在 Changes 页签下面", how: "点页签本身，提示自己跳到下一个" });
  await ui.click({ text: "Next", exact: true, within: ".dispatch-tour" });
  await waitStep(ui, "tasks-tab");
  await ui.click({ css: ".tabs-container .tab[aria-label^='Tasks']" });
  await waitStep(ui, "docs-tab");
  await ui.click({ text: "Next", exact: true, within: ".dispatch-tour" });
  const add = await waitStep(ui, "add-tab");
  assert.equal(add.buttons.at(-1), "Got it");
  await ui.click({ text: "Got it", exact: true, within: ".dispatch-tour" });

  // 2. Tasks was opened by that click: its own tip
  await ui.waitFor({ css: ".dispatch-tasks-scope" }, { timeoutMs: 20000 });
  await walk(ui, "tasks-scope", ["tasks-scope", "tasks-graph"]);
  await ui.mark({ css: ".dispatch-tasks-scope" }, { what: "Tasks 页的提示", where: "第一次打开 Tasks 页签时", how: "This session 和项目的任务，Graph 画成图" });

  // 3. Changes
  await ui.click({ css: ".tabs-container .tab[aria-label^='Changes']" });
  await walk(ui, "changes-list", ["changes-list"]);

  // 4. Docs, then a delivery
  await ui.click({ css: ".tabs-container .tab[aria-label^='Docs']" });
  await walk(ui, "docs-list", ["docs-list", "docs-search"]);
  // a delivery arrives for a task: the pane opens it by itself, and the delivery tip comes with it
  const out = cli(ui, ["begin", "Tips demo: deliver a page", "-P", project, "-d", "e2e tips scenario: a task on the instance board to deliver a page for", "--force"]);
  const task = (out.match(/\b(task-[a-z0-9]+)\b/) || [])[1];
  assert.ok(task, "no task id in: " + out);
  await ui.cdp.send("Page.bringToFront");
  const shown = JSON.parse(cli(ui, ["task", "deliver", task, "--file", page, "--show", "--json"]));
  assert.ok(shown.shown && shown.shown.shown, "deliver --show did not open it: " + JSON.stringify(shown.shown));
  await ui.waitFor({ css: ".dispatch-docs-reader-head" }, { timeoutMs: 45000 });
  const delivery = await walk(ui, (await bubbleStep(ui, ["delivery-task", "delivery-draw"])), null);
  assert.ok(delivery.includes("delivery-draw") && delivery.includes("delivery-back"), JSON.stringify(delivery));

  // 5. Waiting for you
  await ui.click({ text: "Waiting for you", exact: true, within: ".agent-sessions-control-container" });
  await ui.waitFor({ css: ".dispatch-waiting-keys" }, { timeoutMs: 20000 });
  await walk(ui, "waiting-summary", ["waiting-summary", "waiting-keys"]);

  // 6. once: back at each place, nothing shows
  await ui.click({ css: ".tabs-container .tab[aria-label^='Tasks']" }).catch(() => undefined);
  await quiet(ui, 8000, "a tip that was shown does not come again");

  // 7. the places are ticked off
  const done = await checklist(ui);
  assert.ok(done >= startCount + 3, `Getting started ticked the places: ${startCount} to ${done}`);
  await ui.click({ css: ".dispatch-checklist-entry" });
  await ui.waitFor({ css: ".dispatch-checklist-card" });
  await ui.screenshot("07-checklist");
  const rows = await ui.eval("[...document.querySelectorAll('.dispatch-checklist-card .row')].map(r => [r.querySelector('.a').textContent, r.classList.contains('done')])");
  const doneTitles = rows.filter(([, d]) => d).map(([t]) => t);
  for (const title of ["Open Waiting for you", "Look at the task board", "Check what the agent changed", "Open a delivery"]) assert.ok(doneTitles.includes(title), `${title} is ticked: ${JSON.stringify(rows)}`);
  await ui.mark({ css: ".dispatch-checklist-card" }, { what: "Getting started 清单", where: "点标题栏的 Getting started", how: "做过的自己打勾；点一行去那里；Hide this list 收起来，Help 里能找回" });
}

/** The first step that shows out of these. */
async function bubbleStep(ui, steps, timeoutMs = 25000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await ui.sleep(300)) {
    const b = await bubble(ui);
    if (b && steps.includes(b.step) && !b.hidden) return b.step;
  }
  throw new Error(`none of ${steps} showed; on screen: ${JSON.stringify(await bubble(ui))}`);
}
