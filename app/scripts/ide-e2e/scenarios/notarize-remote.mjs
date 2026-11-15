// Provision the signed REH in an isolated demo first. Never points at the user's server or projects.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { targets, windowKind } from "../cdp.mjs";

export const meta = { needs: ['env:NOTARIZE_REMOTE_ROOT', 'env:NOTARIZE_SSH_CONFIG'], setup: "a release check: the Developer ID signed and notarized app (dispatch build sign, which needs the person's signing certificate) with its server provisioned in an isolated demo on the mini; NOTARIZE_REMOTE_ROOT and NOTARIZE_SSH_CONFIG name it", title: "签名后的 mini 远程连接", description: "用已公证 App 打开隔离的 mini 演示项目，读取真实远程文件。" };

export default async function (ui) {
  const root = process.env.NOTARIZE_REMOTE_ROOT;
  const config = process.env.NOTARIZE_SSH_CONFIG;
  if (!root?.startsWith("/private/tmp/dispatch-notarize-") || !config || !fs.existsSync(config)) {
    throw new Error("Provide NOTARIZE_REMOTE_ROOT and NOTARIZE_SSH_CONFIG for an isolated mini demo");
  }
  const files = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].map(d => path.join(d, "User/settings.json"));
  const old = files.map(f => [f, fs.readFileSync(f, "utf8")]);
  try {
    for (const [file, content] of old) {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(content),
        "remote.SSH.configFile": config,
        "remote.SSH.remotePlatform": { "notarize-mini": "macos" },
        "remote.SSH.serverInstallPath": { "*": `${root}/server` },
        "remote.SSH.defaultExtensions": [],
      }));
    }
    await ui.openEditor();
    await ui.sleep(1000);
    const before = new Set((await targets(ui.port)).map(t => t.id));
    await ui.step("openRemote", "notarize-mini/notarize-demo", async () => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const log = fs.openSync(path.join(ui.rec.root, "notarize-remote-launch.log"), "a");
      const child = spawn(ui.rec.binary, [...ui.rec.profile_args, "--new-window", "--force-disable-user-env",
        "--use-inmemory-secretstorage", "--disable-workspace-trust", "--folder-uri",
        `vscode-remote://ssh-remote+notarize-mini${root}/notarize-demo`], { env, stdio: ["ignore", log, log] });
      fs.closeSync(log);
      child.unref();
      const until = Date.now() + 90000;
      while (Date.now() < until) {
        // the new editor window of this instance: its title names the Mac ("Dispatch IDE · mini"), not the folder;
        // the checks below make sure it is notarize-demo over SSH
        const remote = (await targets(ui.port)).find(t => !before.has(t.id) && windowKind(t.url) === "editor");
        if (remote) {
          // its title changes while it loads (the folder, then the Mac): a title gone by now is looked up again
          try {
            await ui.attach("editor", 5000, remote.title);
            return;
          } catch { /* look again */ }
        }
        await ui.sleep(500);
      }
      throw new Error("Remote editor did not open in the isolated instance");
    });
    await ui.waitFor({ css: '[id="status.host"]' }, { timeoutMs: 90000 });
    await ui.waitFor({ text: "SIGNED_SERVER_OK.txt", exact: true }, { timeoutMs: 90000 });
    await ui.click({ text: "SIGNED_SERVER_OK.txt", exact: true });
    await ui.waitFor({ text: "Signed remote server on mini is running.", within: ".monaco-editor" }, { timeoutMs: 30000 });
    const evidence = await ui.eval(`({title:document.title, remote:document.getElementById('status.host')?.innerText,
      workspace:document.body.innerText.split('\\n').find(line => line.includes('notarize-demo') && line.includes('SSH: notarize-mini')),
      file:document.querySelector('.monaco-editor .view-lines')?.innerText.replace(/\\u00a0/g, ' ')})`);
    if (!evidence.workspace || !evidence.file?.includes("Signed remote server on mini is running.")) {
      throw new Error(`Remote file did not load: ${JSON.stringify(evidence)}`);
    }
    fs.writeFileSync(path.join(ui.out, "remote-window.json"), JSON.stringify(evidence, null, 2));
    await ui.screenshot("01-signed-mini-remote");
    await ui.mark({ text: "notarize-demo [SSH: notarize-mini]", exact: true }, { what: "mini 的隔离演示项目", where: "远程编辑器顶部", how: "从本机打开 mini 上的隔离演示项目" });
    await ui.mark({ text: "Signed remote server on mini is running.", within: ".monaco-editor" }, { what: "读取真实远程文件", where: "编辑器正文", how: "在 Explorer 打开 SIGNED_SERVER_OK.txt" });
  } finally {
    for (const [file, content] of old) fs.writeFileSync(file, content);
  }
}
