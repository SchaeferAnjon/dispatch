// The delivery page end to end: an Agent runs `dispatch deliver <task> --kind proposal --show`, the
// page opens in the Agents window's right panel (served by dispatch-bridge on 127.0.0.1), the person
// clicks Choose A, and the pick is really recorded: the task leaves "deciding", the preference goes
// into the instance's preferences.jsonl (its DISPATCH_HOME; never the user's, and never a FACTS.md),
// an implementation task is made.
//
// The CLI is the instance's own (its build's kanban commit); DELIVERY_CLI=<dispatch.py> tries a newer one.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export const meta = {
  title: "交付页在右栏里选方向",
  description: "dispatch deliver --show 把方案稿推到右栏；点 Choose A，选择真的记进任务和偏好。",
};

export default async function (ui) {
  const rec = ui.rec;
  const cli = process.env.DELIVERY_CLI || rec.cli;
  const facts = path.join(rec.root, "rules", "FACTS.md");
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_FACTS_FILE: facts };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE") || k.startsWith("CODEX_")) delete env[k];
  const dispatch = (...args) => {
    const out = execFileSync("python3", [cli, ...args], { env, cwd: ui.demoFolder || rec.folder, encoding: "utf8", timeout: 120000 });
    const last = out.trim().split("\n").filter((l) => l.trim()).join("\n");
    try {
      return JSON.parse(last);
    } catch {
      return last;
    }
  };

  // what the person looks at before: the Agents window on the demo project
  await ui.openAgents(rec.folder);
  await ui.screenshot("01-window-before");

  // what an Agent leaves behind: a proposal folder with the real screenshot and notes.md
  const dir = path.join(rec.folder, "design", "delivery-demo", "redesign");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ui.out, "01-window-before.png"), path.join(dir, "01-now.png"));
  // the boxes in the screenshot's pixels: the left column's first rows, the right panel's tab strip
  const { w, h, dpr } = ui.viewport;
  const px = (v) => Math.round(v * dpr);
  fs.writeFileSync(path.join(dir, "01-now.boxes.json"), JSON.stringify({ size: [px(w), px(h)], items: [
    { n: 1, box: [px(8), px(40), px(260), px(200)] },
    { n: 2, box: [px(w * 0.72), px(30), px(w * 0.27), px(40)] },
  ] }));
  fs.writeFileSync(path.join(dir, "notes.md"), [
    "# 左栏的会话怎么排",
    "",
    "- 推荐 A：按时间找最近会话。",
    "",
    "## 诊断",
    "",
    "![现在](01-now.png)",
    "",
    "1. **会话挤在一起。** 几个项目的会话混在一列里。",
    "2. **右栏页签看不出在哪。** 打开的东西一多就挤成一个字。",
    "",
    "## 方向 A: 按时间一列",
    "",
    "![Interactive prototype](proto-a.html#size=640x320)",
    "",
    "## 方向 B: 按项目分组",
    "",
    "- 平时: ![B 平时](01-now.png) 每个项目一组，组能收起",
    "",
    "## 推荐",
    "",
    "推荐 A：按时间找最近会话。",
    "",
    "| | A | B |",
    "|---|---|---|",
    "| 改动 | 小 | 中 |",
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(dir, "proto-a.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light} :root[data-theme=dark]{color-scheme:dark}
    body{font:14px system-ui;padding:24px} button{font:inherit;padding:8px 16px}
    </style></head><body><h1>Recent sessions</h1><button onclick="this.textContent='Opened'">Open session</button>
    <script>addEventListener('message',e=>{if(e.data?.type==='dispatch-theme')document.documentElement.dataset.theme=e.data.theme})</script></body></html>`);

  const task = dispatch("begin", "左栏会话排法：交付页 e2e 用的方案稿", "-P", "demo", "-d", "e2e：dispatch deliver --show 之后在右栏点 Choose A，选择要真的记下来", "--force", "--json");
  const tid = task.id || task.task || (typeof task === "string" ? (task.match(/task-[a-z0-9]+/) || [])[0] : "");
  if (!tid) throw new Error("no task: " + JSON.stringify(task));
  const r = dispatch("deliver", tid, "--from", dir, "--kind", "proposal", "--model", "GPT 6 astra · max", "--show", "--json");
  if (!r.ok || !r.shown || !r.shown.shown) throw new Error("not shown in the right panel: " + JSON.stringify(r.shown || r));

  // the page, from the bridge's server, in the right panel
  const page = await ui.browserPage("127.0.0.1:");
  const mode = async () => page.eval("document.querySelector('.pick') && document.querySelector('.pick').dataset.mode");
  for (let i = 0; i < 40 && (await mode()) !== "live"; i++) await ui.sleep(250);
  if ((await mode()) !== "live") throw new Error("the page did not find the bridge (mode " + (await mode()) + ")");
  await ui.screenshot("02-window-page-open");
  await page.screenshot("03-page-top");
  await page.click('.proto .enl-p');
  if (!(await page.eval("document.querySelector('.proto').classList.contains('full')"))) throw new Error("prototype did not enlarge");
  await page.screenshot("03-prototype-enlarged");
  await page.click('.proto .cls-p');
  await page.type(".why", "按时间找最近会话");
  await page.click('.choose[data-key="A"]');
  // recording takes a few seconds (bd writes the pick and the implementation task): the page says so
  if (await page.eval("document.querySelector('.pick .hint').classList.contains('busy')")) await page.screenshot("04-page-recording");
  for (let i = 0; i < 90 && !(await page.eval("!document.querySelector('.remembered').hidden")); i++) await ui.sleep(500);
  if (!(await page.eval("!document.querySelector('.remembered').hidden"))) throw new Error("no Remembered card after Choose A");
  await page.screenshot("05-page-remembered");
  await ui.screenshot("06-window-remembered");

  // recorded for real: the task, the preference, the implementation task
  const flow = dispatch("flow", "show", tid, "--json");
  if (flow.state !== "picked" || flow.picked !== "A") throw new Error("the task was not picked: " + JSON.stringify(flow));
  const store = path.join(rec.dispatch_home, "preferences.jsonl");
  const prefs = fs.readFileSync(store, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const liked = prefs.find((p) => p.polarity === "like" && p.text.includes("方向 A「按时间一列」") && p.quote.includes("按时间找最近会话"));
  if (!liked) throw new Error("no preference in " + store);
  if (fs.existsSync(facts) && fs.readFileSync(facts, "utf8").includes("按时间一列")) throw new Error("the pick went into FACTS.md too: " + facts);
  await page.eval("document.querySelector('.remembered .rm').textContent");
  fs.writeFileSync(path.join(ui.out, "recorded.json"), JSON.stringify({ task: tid, flow: { state: flow.state, picked: flow.picked, reason: flow.reason, impl: flow.impl }, preference: { id: liked.id, name: liked.name, text: liked.text, quote: liked.quote, part: liked.part } }, null, 1));
}
