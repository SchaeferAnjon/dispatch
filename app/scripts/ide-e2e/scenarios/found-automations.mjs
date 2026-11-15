// The Automations page's "From other apps": scheduled jobs Hermes, OpenClaw, Codex, Claude, login items and cron
// run on this Mac, read-only. Walks the person's path: Automations, the section, a card, its detail, a run's
// output, back, Look again. What the page showed is written to found.json next to the screenshots.
import fs from "node:fs";
import path from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = {
  title: "Automations 页：别的应用的定时任务",
  description: "左侧栏 Automations，往下是 From other apps：这台 Mac 上 Hermes、OpenClaw、Codex、Claude、登录项和 cron 定时跑的 Agent 任务，只读；点一张卡看它做什么、什么时候跑、最近几次的结果和输出。",
};

const READ = `(() => {
  const s = document.querySelector('.dispatch-found');
  if (!s) return null;
  const text = (el) => (el && el.textContent || '').trim();
  return {
    count: text(s.querySelector('.dispatch-found-count')),
    quiet: [...s.querySelectorAll('.dispatch-found-quiet')].map(text),
    machines: [...s.querySelectorAll('.dispatch-found-machine')].map(text),
    cards: [...s.querySelectorAll('.dispatch-found-card')].map(c => ({
      name: text(c.querySelector('.dispatch-found-card-title')),
      folded: !!c.closest('details:not([open])'),
      app: text(c.querySelector('.dispatch-found-app')),
      agentIcon: [...(c.querySelector('.dispatch-found-agent') || { classList: [] }).classList].find(k => k.startsWith('codicon-')) || '',
      meta: text(c.querySelector('.dispatch-found-card-meta')),
      does: text(c.querySelector('.dispatch-found-card-does')),
      last: text(c.querySelector('.dispatch-found-card-last')),
    })),
    detail: s.querySelector('.dispatch-found-detail') ? {
      crumbs: text(s.querySelector('.dispatch-found-crumbs')),
      title: text(s.querySelector('.dispatch-found-detail-title')),
      facts: [...s.querySelectorAll('.dispatch-found-facts dt')].map((dt) => [text(dt), text(dt.nextElementSibling)]),
      manage: text(s.querySelector('.dispatch-found-manage')),
      runs: [...s.querySelectorAll('.dispatch-found-run-row')].map(text),
      // an agent's answer is drawn as Markdown, a log as plain text
      output: text(s.querySelector('.dispatch-found-output .dispatch-found-reply, .dispatch-found-output pre')).slice(0, 400),
    } : null,
  };
})()`;

// waitFor and exists only see what is on screen; these look in the whole page
async function until(ui, expr, ms = 60000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    if (await ui.eval(expr)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`still not true after ${ms} ms: ${expr}`);
}
const LOADED = "!document.querySelector('.dispatch-found-quiet .codicon-loading')";
const reveal = (css) => `(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return false; e.scrollIntoView({ block: 'center' }); return true; })()`;

// a Getting started tip may take the window to a new session meanwhile: come back to Automations
async function backToAutomations(ui) {
  if (await ui.eval("!!document.querySelector('.dispatch-found')")) return;
  if (await ui.exists({ aria: "Close" })) await ui.click({ aria: "Close" });
  await ui.click({ text: "Automations", exact: true });
  await until(ui, "!!document.querySelector('.dispatch-found')", 30000);
  await until(ui, LOADED);
}

// Getting started tips off in this instance's own settings (they pop up and take the window elsewhere)
function tipsOff(ui) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean)) {
    const f = path.join(dir, "User", "settings.json");
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* new file */ }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...cur, "dispatch.tips.enabled": false }, null, 2));
  }
}

export default async function (ui) {
  const found = {};
  tipsOff(ui);
  const save = () => fs.writeFileSync(path.join(ui.out, "found.json"), JSON.stringify(found, null, 2));

  // the page is not about a folder: no demo project needed
  await ui.openAgents();
  // the Agents window opened from the editor window lands on that window's folder once its setup check is
  // done (12 to 16 s on the mini) and closes any page shown meanwhile (VS Code's own handoff): let it land
  await until(ui, `(() => { const p = document.querySelector('.new-session-workspace-picker-container'); const t = p ? p.textContent.trim() : ''; return !!t && !t.startsWith('Workspace'); })()`, 30000).catch(() => undefined);
  // a landing later still closes the page once more: open it again, as a person would
  for (let i = 0; ; i++) {
    await ui.click({ text: "Automations", exact: true });
    try {
      await ui.waitFor({ text: "From other apps", exact: true }, { timeoutMs: 30000 });
      break;
    } catch (e) {
      if (i >= 2) throw e;
    }
  }
  // this Mac first, then the other Macs (an ssh each): wait until both are in
  await until(ui, LOADED);
  await ui.eval(reveal(".dispatch-found-head"));
  found.list = await ui.eval(READ);
  // the page scrolls (the host's scrollable) once other apps' jobs make it taller than the window
  found.scroll = await ui.eval(`(() => { const b = document.querySelector('.custom-view-body .custom-view-scroll-content');
    return b ? { scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, scrollbar: !!document.querySelector('.custom-view-body .scrollbar.vertical .slider') } : null; })()`);
  save();
  await ui.screenshot("01-list");
  await ui.eval(reveal(".dispatch-found-head"));
  await ui.mark({ css: ".dispatch-found-title" }, { what: "From other apps：别的应用定时跑的 Agent 任务", where: "Automations 页，自己的自动化下面", how: "左侧栏点 Automations，往下看" });

  const cards = (found.list && found.list.cards) || [];
  if (!cards.length) {
    await ui.mark({ css: ".dispatch-found-quiet" }, { what: "这台 Mac 上没有别的应用的定时任务时的一句话", where: "From other apps 下面", how: "打开 Automations 就能看到" });
    return;
  }
  await ui.mark({ css: ".dispatch-found-card" }, { what: `第一张卡：${cards[0].name}（${cards[0].app}）`, where: "From other apps 的卡片", how: "点卡片看详情" });
  // a card with runs shows the most: pick the first one that has run
  const pick = Math.max(0, cards.findIndex((c) => !c.folded && !/No runs yet/.test(c.last)));
  await ui.click({ css: ".dispatch-found-card", index: pick });
  await until(ui, "!!document.querySelector('.dispatch-found-detail')", 10000);
  await ui.eval(`(() => { document.querySelector('.dispatch-found').scrollIntoView({ block: 'start' }); return true; })()`);
  await new Promise((r) => setTimeout(r, 300));
  found.detail = (await ui.eval(READ)).detail;
  save();
  await ui.screenshot("02-detail");
  await ui.mark({ css: ".dispatch-found-back" }, { what: "返回列表", where: "详情左上角的面包屑", how: "点它回到 From other apps" });
  await ui.mark({ css: ".dispatch-found-manage" }, { what: "Dispatch 只读这条任务，去哪个应用改", where: "详情中间", how: "点卡片进详情" });

  if (await ui.eval(reveal(".dispatch-found-run-row:not([disabled])"))) {
    await ui.click({ css: ".dispatch-found-run-row:not([disabled])" });
    await ui.waitFor({ css: ".dispatch-found-output" }, { timeoutMs: 5000 });
    await ui.scrollTo("Copy output");
    found.output = (await ui.eval(READ)).detail.output;
    save();
    await ui.screenshot("03-output");
    await ui.mark({ css: ".dispatch-found-output" }, { what: "这次运行的输出", where: "Last runs 里点开的那一行", how: "点一行运行记录" });
  }

  await ui.eval(reveal(".dispatch-found-crumbs"));
  await ui.click({ css: ".dispatch-found-back" });
  await ui.waitFor({ css: ".dispatch-found-card" }, { timeoutMs: 5000 });
  await backToAutomations(ui);
  await ui.eval(reveal(".dispatch-found-head"));
  await ui.click({ aria: "Look again" });
  await new Promise((r) => setTimeout(r, 300));
  await until(ui, LOADED);
  await backToAutomations(ui);
  found.again = await ui.eval(READ);
  found.sameAfterLookAgain = JSON.stringify(found.again.cards.map((c) => c.name)) === JSON.stringify(cards.map((c) => c.name));
  save();
  await ui.screenshot("04-after-look-again");

  // another Mac Dispatch knows that is off: its group says so instead of hiding it (only this
  // instance's own hosts.json; 192.0.2.1 is a documentation address nothing answers on)
  const hosts = path.join(ui.rec.dispatch_dir, "hosts.json");
  fs.writeFileSync(hosts, JSON.stringify([{ id: "lab", name: "Lab Mac", ssh: "me@192.0.2.1", address: "192.0.2.1", user: "me" }]));
  try {
    await backToAutomations(ui);
    await ui.eval(reveal(".dispatch-found-head"));
    await ui.click({ aria: "Look again" });
    await new Promise((r) => setTimeout(r, 300));
    await until(ui, LOADED);
    await backToAutomations(ui);
    await until(ui, "!!document.querySelector('.dispatch-found-machine')", 30000);
    found.withOtherMac = await ui.eval(READ);
    save();
    await ui.eval(`(() => { const m = [...document.querySelectorAll('.dispatch-found-machine')].pop(); m.scrollIntoView({ block: 'center' }); return true; })()`);
    await ui.screenshot("05-other-mac-off");
    await ui.mark({ text: "Lab Mac", exact: true }, { what: "另一台 Mac 的分组；关机或连不上时写一句，不藏起来", where: "From other apps 里，这台 Mac 的任务下面", how: "hosts.json 里有别的 Mac 就会出现" });
  } finally {
    fs.rmSync(hosts, { force: true });
  }
}
