// Requires an explicitly provisioned demo REH, its isolated board and dispatch-demo wrapper.
// Provision it with ../machines-remote.py, then start this instance with its SSH shim on PATH.
// MACHINES_SSH_TARGET and MACHINES_REMOTE_DEMO name that test installation.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

export const meta = { needs: ['env:MACHINES_SSH_TARGET', 'env:MACHINES_REMOTE_DEMO'], setup: "a remote demo installation (board, project, the build's server) provisioned with app/scripts/ide-e2e/machines-remote.py on a second Mac, which needs the person's Zhipu key; then MACHINES_SSH_TARGET and MACHINES_REMOTE_DEMO name it", timeout: 900, title: "双机 Waiting 与远程窗口", description: "真实 SSH 推送、远程 Agents 落点、编辑器切换、连接中断和恢复，只操作演示项目。" };

async function connected(ui, kind) {
  const title = kind === "editor" ? "Dispatch IDE · mini" : "Dispatch Agent · mini";
  await ui.attach(kind, 60000, title);
  const until = Date.now() + 90000;
  let retriedAt = 0;
  while (Date.now() < until) {
    if (await ui.exists({ css: ".dispatch-remote-lost" })) {
      if (Date.now() - retriedAt > 5000) {
        await ui.click({ text: "Try again", exact: true, within: ".dispatch-remote-lost" });
        retriedAt = Date.now();
        await ui.sleep(1500);
        await ui.attach(kind, 60000, title);
      }
    } else if (!(await ui.exists({ css: ".dispatch-machine-connecting" }))
      && !(await ui.exists({ css: ".dispatch-machines-button-icon.codicon-loading" }))
      && (kind !== "editor" || await ui.exists({ text: "mini", exact: true, within: '[id="status.host"]' }))) {
      return;
    }
    await ui.sleep(500);
  }
  throw new Error(`${title} did not finish connecting`);
}

export default async function (ui) {
  const target = process.env.MACHINES_SSH_TARGET;
  const remote = process.env.MACHINES_REMOTE_DEMO;
  if (!target || !remote?.startsWith("/")) throw new Error("Provide the isolated remote demo installation explicitly");
  const fixture = path.join(ui.rec.root, "machines-live");
  fs.mkdirSync(fixture, { recursive: true });
  const host = { id: "mini", name: "mini", ssh: target, beads_dir: `${remote}/board/.beads`, dispatch: `${remote}/dispatch-demo` };
  fs.writeFileSync(path.join(ui.rec.dispatch_dir, "hosts.json"), JSON.stringify([host]));
  fs.writeFileSync(path.join(ui.rec.dispatch_dir, "self-name.json"), JSON.stringify({ name: "小蓝" }));
  // Counts and reachability are real. Only the folder is pinned to the demo, since real
  // recent-project filtering intentionally excludes temporary test directories.
  const cli = path.join(fixture, "cli.py");
  fs.writeFileSync(cli, `import json, subprocess, sys
r = subprocess.run([sys.executable, ${JSON.stringify(ui.rec.cli)}, *sys.argv[1:]], capture_output=True, text=True)
if sys.argv[1:] in (["machines", "--json"], ["machines", "list", "--json"]) and r.returncode == 0:
    rows=json.loads(r.stdout)
    for row in rows:
        if row["id"] == "mini":
            row["home"]=${JSON.stringify(`${remote}/projects/demo`)}
            row["recent"]=[{"name":"demo","label":"Demo on mini","dir":row["home"],"last_at":1,"last_title":"Machine acceptance"}]
    print(json.dumps(rows))
else:
    sys.stdout.write(r.stdout); sys.stderr.write(r.stderr)
sys.exit(r.returncode)
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
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(old), "dispatch.commandLocation": cli,
      "remote.SSH.serverInstallPath": { [target.split("@").pop()]: `${remote}/isolated-home/.dispatch-ide-server` },
    }));
  }
  const env = { ...process.env, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, BEADS_DIR: ui.rec.beads_dir, DISPATCH_IDE_USER_DATA_DIRS: ui.rec.user_data_dir, DISPATCH_SESSION_ROOT: ui.rec.root };
  const daemon = spawn("python3", ["-u", "-c", `import sys; sys.path.insert(0,${JSON.stringify(path.dirname(ui.rec.cli))}); import chatd; chatd.serve()`], { env, stdio: ["pipe", "ignore", "pipe"] });
  daemon.stderr.pipe(fs.createWriteStream(path.join(fixture, "chatd.log")));
  const remotePython = (code) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, "/opt/homebrew/bin/python3", "-"], { input: code, encoding: "utf8", timeout: 45000 }).trim();
  const remoteEnv = `dict(os.environ, BEADS_DIR=${JSON.stringify(`${remote}/board/.beads`)}, PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")`;
  let task;
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
    await ui.waitFor({ text: "Demo on mini", exact: true }, { timeoutMs: 90000 });
    await ui.screenshot("01-live-machines");
    await ui.mark({ css: ".dispatch-machines-button-label" }, { what: "Machines 面板", where: "标题栏右侧", how: "点机器名，查看 mini 的状态和最近项目" });
    await ui.press("Escape");
    task = remotePython(`import os,json,subprocess
r=subprocess.run(["bd","create","Choose the demo machine color","-t","task","-l","project:demo,dispatch:decide","--metadata",json.dumps({"flow":{"state":"deciding","options":[{"key":"A","title":"Light"},{"key":"B","title":"Dark"}]}}),"--json"],env=${remoteEnv},capture_output=True,text=True,timeout=30)
assert r.returncode==0,r.stderr
print(json.loads(r.stdout)["id"])
`);
    const created = Date.now();
    await ui.waitFor({ text: "1 waiting", exact: true, within: ".dispatch-waiting-peer" }, { timeoutMs: 20000 });
    const elapsed = Date.now() - created;
    fs.writeFileSync(path.join(fixture, "push.json"), JSON.stringify({ task, uiLatencyMs: elapsed }));
    await ui.screenshot("02-live-push");
    await ui.mark({ css: ".dispatch-waiting-peer" }, { what: "mini 的待决定事项", where: "左栏 Waiting for you 下方", how: "真实 SSH 推送到这里，点它去 mini" });
    await ui.click({ css: ".dispatch-waiting-peer" });
    await ui.sleep(1500);
    await connected(ui, "agents");
    await ui.waitFor({ text: "Choose the demo machine color", exact: true }, { timeoutMs: 90000 });
    await ui.waitFor({ css: ".dispatch-machines-button-icon.codicon-loading" }, { gone: true, timeoutMs: 90000 });
    if (await ui.eval("document.title") !== "Dispatch Agent · mini") throw new Error("Remote Agents title is missing its machine name");
    await ui.screenshot("03-remote-waiting");
    await ui.mark({ css: ".dispatch-waiting-page" }, { what: "远程 Waiting 落点", where: "mini 窗口主区", how: "源窗口的提示行直接带到这里" });
    await ui.click({ aria: "Editor" });
    await ui.sleep(1500);
    await connected(ui, "editor");
    if (await ui.eval("document.title") !== "Dispatch IDE · mini") throw new Error("Editor switch lost the remote authority");
    await ui.screenshot("04-remote-editor");
    await ui.mark({ css: '[id="status.host"]' }, { what: "远程机器标识", where: "编辑器左下角", how: "同一台 mini，点它开 Machines 面板" });
    // Open Remote - SSH uses ssh2 inside its extension host, not a child ssh process.
    // Interrupt only the REH whose command line names this explicit isolated server data directory.
    const interrupted = remotePython(`import json,os,shlex,signal,subprocess
rows=[]
for line in subprocess.check_output(["ps","-axo","pid=,command="],text=True).splitlines():
    pid,cmd=line.strip().split(None,1)
    if "/out/server-main.js " in cmd and ${JSON.stringify(`${remote}/reh-data`)} in shlex.split(cmd):
        rows.append({"pid":int(pid),"cmd":cmd})
assert rows, "No isolated demo REH was found"
print(json.dumps(rows),flush=True)
for row in rows: os.kill(row["pid"],signal.SIGTERM)
`);
    console.error(`SIGTERM isolated remote REH: ${interrupted}`);
    fs.writeFileSync(path.join(fixture, "interrupted-reh.json"), interrupted);
    await ui.waitFor({ css: ".dispatch-remote-lost" }, { timeoutMs: 30000 });
    await ui.screenshot("05-remote-disconnected");
    await ui.mark({ css: ".dispatch-remote-lost" }, { what: "断线提示和重试", where: "远程窗口主区顶部", how: "显示断线时间，点 Try again 重新连接" });
    await ui.click({ text: "Try again", exact: true, within: ".dispatch-remote-lost" });
    await ui.sleep(1500);
    await connected(ui, "editor");
    await ui.screenshot("06-remote-recovered");
    await ui.click({ aria: "Dispatch Agent" });
    await ui.sleep(1000);
    await connected(ui, "agents");
    await ui.newSession();
    const picker = ".sessions-chat-session-type-picker";
    if ((await ui.eval(`document.querySelector('${picker}')?.innerText.trim()`)) !== "OpenCode") {
      await ui.click({ css: picker });
      await ui.waitFor({ text: "OpenCode", exact: true, within: ".context-view" }, { timeoutMs: 30000 });
      await ui.click({ text: "OpenCode", exact: true, within: ".context-view" });
    }
    await ui.waitFor({ text: "GLM-5.3-Flash", within: ".model-picker-split" }, { timeoutMs: 60000 });
    const selection = await ui.eval(`({engine:document.querySelector('${picker}')?.innerText.trim(), model:document.querySelector('.model-picker-split')?.innerText.trim()})`);
    if (selection.engine !== "OpenCode" || !selection.model?.includes("GLM-5.3-Flash")) throw new Error("The required OpenCode GLM Flash model was not selected; refusing to send");
    fs.writeFileSync(path.join(fixture, "engine.json"), JSON.stringify({ ...selection, modelId: "zai-coding-plan/glm-5.3-flash" }));
    const newWorktree = { css: '.sessions-chat-isolation-checkbox [role="checkbox"][aria-checked="true"]' };
    if (await ui.exists(newWorktree)) {
      await ui.click({ text: "Separate copy", exact: true, within: ".sessions-chat-isolation-checkbox" });
      await ui.waitFor(newWorktree, { gone: true, timeoutMs: 10000 });
    }
    await ui.click({ css: ".sessions-chat-editor" });
    await ui.type("Reply with exactly REMOTE_MACHINE_OK. Do not use any tools.");
    await ui.press("Enter", { send: true });
    await ui.waitFor({ text: "REMOTE_MACHINE_OK", exact: true, within: ".interactive-list .interactive-response" }, { timeoutMs: 120000 });
    await ui.screenshot("07-remote-agent-reply");
    await ui.mark({ css: ".interactive-list .interactive-response" }, { what: "mini 上的真实回复", where: "远程 Agents 对话区", how: "使用 OpenCode 的 GLM Flash 发送测试消息" });
    const liveSessions = JSON.parse(remotePython(`import os,sys,json,pathlib
os.environ["DISPATCH_IDE_USER_DATA_DIRS"]=${JSON.stringify(`${remote}/reh-data/data`)}
os.environ["DISPATCH_SESSION_ROOT"]=${JSON.stringify(remote)}
sys.path.insert(0,str((pathlib.Path.home()/".local/bin/dispatch").resolve().parent))
import ide_sessions as I
rows=[r for r in I.scan(include_all=True) if (r.get("cwd") or "").startswith(${JSON.stringify(`${remote}/projects/demo`)})]
live={}
for _,user_data in I.apps():
    for endpoint in I.endpoints(user_data):
        try: live.update(I.list_live(endpoint))
        except (OSError,ValueError,KeyError): pass
print(json.dumps([{"id":r["session_id"],"alive":r.get("ide_key") in live,"cwd":r.get("cwd"),"source":r.get("source")} for r in rows]))
`));
    if (!liveSessions.some(r => r.alive && r.cwd?.startsWith(`${remote}/projects/demo`))) throw new Error("The remote CLI could not discover the live Agent Host session");
    fs.writeFileSync(path.join(fixture, "remote-session-discovery.json"), JSON.stringify(liveSessions, null, 2));
    remotePython(`import os,subprocess\nr=subprocess.run(["bd","close",${JSON.stringify(task)},"--reason","Machines UI acceptance complete"],env=${remoteEnv},capture_output=True,text=True,timeout=30)\nassert r.returncode==0,r.stderr`);
    task = undefined;
    await ui.attach("agents", 60000, "Dispatch Agent");
    await ui.waitFor({ css: ".dispatch-waiting-peer" }, { gone: true, timeoutMs: 20000 });
    await ui.screenshot("08-live-cleared");
  } finally {
    daemon.stdin.end();
    // Keep routing isolated for the lifetime of this instance, including reconnects after a failed run.
    for (const [file, old] of settings) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(old),
      "remote.SSH.serverInstallPath": { [target.split("@").pop()]: `${remote}/isolated-home/.dispatch-ide-server` },
    }));
    if (task) remotePython(`import os,subprocess\nr=subprocess.run(["bd","close",${JSON.stringify(task)},"--reason","Machines UI acceptance complete"],env=${remoteEnv},capture_output=True,text=True,timeout=30)\nassert r.returncode==0,r.stderr`);
  }
}
