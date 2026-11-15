// History of another Mac (kanban task-b1ppr, app/cli/session_history.py `--machine`, Dispatch IDE
// patches/450-history.patch). Run on this Mac with another Mac reachable over ssh (the mini): the
// instance's list of Macs gets that one (hosts.json, as Settings › Macs › Add writes it), the History tab shows the
// Mac switch, picking the other Mac lists its sessions (asked over ssh with this build's CLI there), a row opens
// with its folder on that Mac, and Continue opens a window connected to that Mac on the folder.
//   HISTORY_REMOTE_SSH=mini            the ssh name of the other Mac
//   HISTORY_REMOTE_CLI=<command>       the dispatch CLI to run there (default: the one inside this build's app there)
import fs from "node:fs";
import path from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { instance: { fixture: 'other-mac' },
  title: "History：另一台 Mac 的会话",
  description: "设置里加上另一台 Mac 后，History 页签多一个切换 Mac 的按钮；切到那台 Mac 列出它上面的会话，点开看文件夹，Continue 开一个连到那台 Mac 的窗口。",
  timeout: 900,
};

// the other Mac: the instance's own second Mac (fixtures/other_mac.py: this Mac again over ssh, as a person of its own
// with two conversations), or HISTORY_REMOTE_SSH
const SSH = process.env.HISTORY_REMOTE_SSH || process.env.DISPATCH_E2E_OTHER_MAC || "mini";
function assert(ok, message) { if (!ok) throw new Error(message); }
async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) {
    const v = await fn();
    if (v) return v;
    await ui.sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const rowTitles = (ui) => ui.eval("JSON.stringify([...document.querySelectorAll('.dispatch-history-row .dispatch-history-title')].map(e => e.textContent))").then(JSON.parse);
const windows = (ui) => fetch(`http://127.0.0.1:${ui.rec.port}/json/list`).then((r) => r.json()).catch(() => []);

async function closeTips(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); i++) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(500);
  }
}

export default async function (ui) {
  const results = {};
  const build = ui.rec.build?.name || "";
  // the CLI inside this build's app on that Mac: for the instance's own second Mac, this very app
  const cli = process.env.HISTORY_REMOTE_CLI
    || (process.env.DISPATCH_E2E_OTHER_MAC ? `python3 '${ui.rec.cli}'`
      : build ? `python3 '/Users/apple/dispatch-builds/${build}/Dispatch IDE.app/Contents/Resources/app/dispatch-cli/dispatch/cli/dispatch.py'` : "dispatch");
  const hostsFile = path.join(ui.rec.dispatch_dir, "hosts.json");
  let hosts = [];
  try { hosts = JSON.parse(fs.readFileSync(hostsFile, "utf8")); } catch { hosts = []; }
  hosts = hosts.filter((h) => h.id !== "mini");
  hosts.push({ id: "mini", name: "mini", ssh: SSH, dispatch: cli, aliases: ["mac-mini"] });
  fs.writeFileSync(hostsFile, JSON.stringify(hosts, null, 2));
  results.cli = cli;

  await ui.attach("agents", 30000).catch(() => ui.openAgents());
  await ui.closeOverlays();
  await ui.sleep(4000);
  await closeTips(ui);
  await ui.newSession();
  await ui.sleep(1000);
  for (let i = 0; i < 3; i++) {
    try { await ui.openTab("History"); break; } catch (e) { if (i === 2) throw e; await ui.press("Escape"); await closeTips(ui); await ui.sleep(1500); }
  }
  await until(ui, async () => (await rowTitles(ui)).length > 0 || (await ui.exists({ css: ".dispatch-history-machine" })), 240000, "the History list");
  await ui.waitFor({ css: ".dispatch-history-machine" }, { timeoutMs: 60000 });
  // no words left in the search box from before
  if (await ui.eval("!!document.querySelector('input.dispatch-history-search-input')?.value")) {
    await ui.click({ css: "input.dispatch-history-search-input" });
    await ui.eval("(() => { const i = document.querySelector('input.dispatch-history-search-input'); i.select(); })()");
    await ui.press("Backspace");
    await ui.sleep(2000);
  }
  results.thisMac = (await rowTitles(ui)).slice(0, 5);
  await ui.screenshot("01-this-mac");
  await ui.mark({ css: ".dispatch-history-machine" }, { what: "切换 Mac", where: "History 页签顶上右边", how: "有别的 Mac 时出现，点它选那台" });

  // the other Mac
  await ui.click({ css: ".dispatch-history-machine" });
  await ui.waitFor({ text: "mini", exact: true, within: ".context-view, .monaco-menu-container" }, { timeoutMs: 10000 });
  await ui.click({ text: "mini", exact: true, within: ".context-view, .monaco-menu-container" });
  const remoteRows = await until(ui, async () => {
    const t = await rowTitles(ui);
    const label = await ui.eval("document.querySelector('.dispatch-history-machine')?.innerText || ''");
    return /mini/.test(label) && t.length && JSON.stringify(t) !== JSON.stringify(results.thisMac) ? t : null;
  }, 120000, "mini's sessions", 2000);
  results.mini = remoteRows.slice(0, 8);
  results.count = await ui.eval("document.querySelector('.dispatch-history-count, .dispatch-history-countline')?.innerText || ''");
  results.error = await ui.eval("document.querySelector('.dispatch-history-list .dispatch-tasks-empty-lines')?.innerText || ''");
  assert(!/did not answer/.test(results.error), `mini did not answer: ${results.error}`);
  await ui.screenshot("02-mini");
  await ui.mark({ css: ".dispatch-history-row", index: 0 }, { what: "mini 上的会话", where: "History 列表", how: "切到 mini 后列出它的会话" });

  // a row: its folder on that Mac, and Continue opens a window connected to it
  const title = remoteRows.find((t) => t && t.length > 3) || remoteRows[0];
  await ui.click({ text: title, within: ".dispatch-history-list" });
  await ui.waitFor({ css: ".dispatch-history-row.open .dispatch-history-button" }, { timeoutMs: 20000 });
  results.facts = await ui.eval("document.querySelector('.dispatch-history-row.open .dispatch-history-facts, .dispatch-history-row.open')?.innerText.slice(0, 600)");
  results.continueEnabled = await ui.eval("!document.querySelector('.dispatch-history-row.open .dispatch-history-button')?.disabled");
  await ui.screenshot("03-mini-row");
  if (results.continueEnabled) {
    const before = (await windows(ui)).filter((t) => t.type === "page").map((t) => t.id);
    await ui.click({ text: "Continue", exact: true, within: ".dispatch-history-row.open" });
    const opened = await until(ui, async () => {
      const list = (await windows(ui)).filter((t) => t.type === "page" && !before.includes(t.id));
      return list.length ? list : null;
    }, 120000, "a window connected to mini", 2000).catch((e) => { results.windowError = String(e.message || e); return []; });
    results.newWindows = opened.map((t) => t.title);
  }
  fs.writeFileSync(path.join(ui.out, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(hostsFile, JSON.stringify(hosts.filter((h) => h.id !== "mini"), null, 2));
  return results;
}
