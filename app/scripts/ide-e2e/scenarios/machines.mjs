// The unreachable peer and its counts are fixtures. All clicks, windows, preparation,
// landing consumption and cancellation use the built application.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const meta = {
  // the unreachable Mac is told within seconds by the check before the server is copied over (machines.ts ensureServer),
  // which only the packaged app does; a development build leaves it to Remote - SSH's own long timeouts
  needs: ["app-bundle"],
  title: "多机器连接和 Waiting 落点",
  description: "测试桩提供 mini 计数，真实窗口验证机器名、一次性 Waiting 落点、远程 Agents 连接画面和取消。",
};

export default async function (ui) {
  const fixture = path.join(ui.rec.root, "machines-fixture");
  fs.mkdirSync(fixture, { recursive: true });
  const rows = [
    { id: "local", name: "小蓝", local: true, online: true, sessions: 0, running: 0, attention: { approve: 0, decide: 0, unread: 0, only_you: 1, total: 1, as_of: Date.now() / 1000 }, recent: [{ name: "demo", label: "demo", dir: ui.demoFolder }] },
    { id: "mini", name: "mini", local: false, online: true, ssh: "tester@192.0.2.1", home: "/tmp/dispatch-machines-demo", sessions: 0, running: 0, attention: { approve: 1, decide: 0, unread: 1, only_you: 0, total: 2, as_of: Date.now() / 1000 }, recent: [] },
  ];
  const data = path.join(fixture, "rows.json");
  fs.writeFileSync(data, JSON.stringify(rows));
  const cli = path.join(fixture, "cli.py");
  const calls = path.join(fixture, "calls.log");
  fs.writeFileSync(cli, `import json, os, sys
args = sys.argv[1:]
open(${JSON.stringify(calls)}, "a").write(" ".join(args) + "\\n")
if args and args[0] == "machines" and (len(args) < 2 or args[1] in ("--json", "list")):
    print(open(${JSON.stringify(data)}).read())
else:
    os.execv(sys.executable, [sys.executable, ${JSON.stringify(ui.rec.cli)}, *args])
`);
  const settings = [];
  const profiles = path.join(ui.rec.user_data_dir, "User", "profiles");
  const files = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].map(dir => path.join(dir, "User", "settings.json"));
  const visitProfiles = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subdir = path.join(dir, entry.name);
      const file = path.join(subdir, "settings.json");
      if (fs.existsSync(file)) files.push(file);
      visitProfiles(subdir);
    }
  };
  if (fs.existsSync(profiles)) visitProfiles(profiles);
  // The built-in Agents profile is nested and may not have a settings file yet.
  const agentsSettings = path.join(profiles, "builtin", "agents", "settings.json");
  if (!files.includes(agentsSettings)) {
    fs.mkdirSync(path.dirname(agentsSettings), { recursive: true });
    fs.writeFileSync(agentsSettings, "{}");
    files.push(agentsSettings);
  }
  for (const file of files) {
    const old = fs.readFileSync(file, "utf8");
    settings.push([file, old]);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(old), "dispatch.commandLocation": cli }));
  }
  try {
    await ui.sleep(1500);
    await ui.attach("agents", 60000, "Dispatch Agent");
    // Apply the test CLI before the first machine query; a cold bridge can still be running
    // its pre-fixture query when settings change. Reload only this isolated window.
    await ui.reloadWindow(); // a real reload (location.reload() is refused by the workbench)
    await ui.sleep(1500);
    await ui.attach("agents", 60000, "Dispatch Agent");
    await ui.closeOverlays();
    await ui.click({ css: ".dispatch-machines-button-label" });
    await ui.waitFor({ css: ".dispatch-waiting-peer" }, { timeoutMs: 60000 }).catch((e) => {
      // which dispatch the window ran: the stub notes each call; the settings say where it should be
      const called = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).slice(-5) : [];
      const set = files.map(f => { try { return JSON.parse(fs.readFileSync(f, "utf8"))["dispatch.commandLocation"] || ""; } catch { return "?"; } });
      throw new Error(`${e.message}; the stub was called ${called.length ? JSON.stringify(called) : "never"}; settings: ${JSON.stringify(set)} in ${files.length} files`);
    });
    if (!(await ui.exists({ css: ".dispatch-machines-section" }))) await ui.click({ css: ".dispatch-machines-button-label" });
    await ui.waitFor({ text: "mini", exact: true, within: ".dispatch-machines-section" });
    await ui.screenshot("01-machine-panel");
    await ui.mark({ css: ".dispatch-machines-button-label" }, { what: "机器名", where: "标题栏右侧", how: "点开 Machines 面板" });
    await ui.press("Escape");
    // The destination bridge claims a real land.json exactly once.
    execFileSync("python3", [ui.rec.cli, "machines", "open", "local", "--land", "waiting", "--json"], {
      env: { ...process.env, DISPATCH_DIR: ui.rec.dispatch_dir, BEADS_DIR: ui.rec.beads_dir }, timeout: 20000,
    });
    await ui.waitFor({ css: ".dispatch-waiting-page" }, { timeoutMs: 20000 });
    if (fs.existsSync(path.join(ui.rec.dispatch_dir, "land.json"))) throw new Error("Waiting landing was not consumed");
    await ui.screenshot("02-waiting-landing");
    fs.writeFileSync(path.join(fixture, "layout.json"), JSON.stringify(await ui.eval(`Array.from(document.querySelectorAll('[id^="workbench.parts."]')).map(e => ({id:e.id,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,display:getComputedStyle(e).display}))`), null, 2));
    await ui.mark({ css: ".dispatch-waiting-page" }, { what: "Waiting 落点", where: "主区", how: "收到一次性请求后自动打开" });
    await ui.waitFor({ css: ".dispatch-waiting-peer" });
    await ui.click({ css: ".dispatch-waiting-peer" });
    await ui.sleep(1200);
    await ui.attach("agents", 30000, "Dispatch Agent · mini");
    await ui.waitFor({ css: ".dispatch-machine-connecting" }, { timeoutMs: 30000 });
    const title = await ui.eval("document.title");
    if (title !== "Dispatch Agent · mini") throw new Error(`Wrong remote title: ${title}`);
    await ui.screenshot("03-remote-connecting");
    await ui.mark({ css: ".dispatch-machine-step" }, { what: "连接步骤", where: "远程窗口主区", how: "当前步骤从发起窗口共享过来" });
    await ui.waitFor({ text: "mini is not reachable", exact: true }, { timeoutMs: 30000 });
    await ui.screenshot("04-remote-unreachable");
    await ui.click({ text: "Cancel", exact: true, within: ".dispatch-machine-connecting" });
    await ui.sleep(800);
    await ui.attach("agents", 20000, "Dispatch Agent");
    if (await ui.eval("document.title") !== "Dispatch Agent") throw new Error("Cancellation did not return to the local window");
    await ui.openEditor();
    await ui.click({ css: ".dispatch-machines-button-label" });
    await ui.waitFor({ text: "小蓝", within: '[id="status.host"]' }, { timeoutMs: 20000 });
    await ui.press("Escape");
    await ui.screenshot("05-editor-machine");
    await ui.mark({ css: '[id="status.host"]' }, { what: "编辑器机器标识", where: "左下角", how: "点开同一机器面板" });
  } finally {
    for (const [file, old] of settings) fs.writeFileSync(file, old);
  }
}
