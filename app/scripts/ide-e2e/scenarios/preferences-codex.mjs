// Preferences reach Codex too: a new Codex session is asked for the switch preference its session-start
// context gave it. Codex keeps only the head and tail of a long hook output, so prime puts the section last
// for Codex (prefs.py CODEX_CHARS). Talks to a real agent: test instance only. The preference is recorded first through
// the instance's own CLI (as `preferences` leaves it), so it runs on a new instance of its own.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const meta = { needs: ['codex'], timeout: 900,
  title: "偏好：Codex 的新会话开头也带着",
  description: "新开一个 Codex 会话，问它会话开头收到的「偏好」段里讲开关的那一条；它原样答出来，说明 prime 的偏好段没被 Codex 的长度上限切掉。",
};

const INPUT = [{ css: ".interactive-input-part .chat-editor-container" }, "What should we do?", { css: ".sessions-chat-editor" }];
const ASK = "只用一句话回答：你这次会话开头收到的偏好里，关于开关的那一条说的是什么？不要做别的。";

export default async function (ui) {
  const rec = ui.rec;
  const store = path.join(rec.dispatch_home, "preferences.jsonl");
  if (!(fs.existsSync(store) && fs.readFileSync(store, "utf8").includes("方角"))) {
    const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_E2E_INSTANCE: rec.name };
    for (const k of Object.keys(env)) if (k.startsWith("CLAUDE") || k.startsWith("CODEX_")) delete env[k];
    execFileSync("python3", [rec.cli, "prefs", "add", "开关用方角，别用胶囊", "--like", "--name", "方角开关", "--area", "design", "--quote", "这个开关用方角，别用胶囊"],
      { env, cwd: rec.folder, encoding: "utf8", timeout: 60000 });
  }
  await ui.openAgents(ui.demoFolder);
  // the new session page for sure (typing into the last session instead would talk to it)
  for (let attempt = 1; ; attempt++) {
    await ui.newSession();
    try {
      await ui.waitFor("What should we do?", { timeoutMs: 10000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await ui.press("Escape");
    }
  }
  const picker = ".sessions-chat-session-type-picker";
  if ((await ui.eval(`document.querySelector('${picker}')?.innerText.trim()`)) !== "Codex") {
    await ui.click({ css: picker });
    await ui.click({ text: "Codex", exact: true, within: ".context-view" });
  }
  await ui.waitFor({ text: "Codex" }, { timeoutMs: 10000 });
  await ui.sleep(3000); // its app-server starts on first use
  let into = INPUT[0];
  for (const spec of INPUT) if (await ui.exists(spec)) { into = spec; break; }
  await ui.type(ASK, { into });
  for (let attempt = 1; ; attempt++) {
    await ui.press("Enter", { send: true });
    try {
      await ui.waitFor({ text: ASK, within: ".interactive-request" }, { timeoutMs: 15000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
  // a long reply line is past the locator's prefix match: read the reply's text
  const until = Date.now() + 300000;
  const has = `(() => { const all = [...document.querySelectorAll(".interactive-item-container.interactive-response")]; const el = all[all.length - 1]; return !!el && (el.innerText || "").includes("方角"); })()`;
  while (!(await ui.eval(has))) {
    if (Date.now() > until) throw new Error("no 方角 in the Codex reply after 300 s");
    await ui.sleep(2000);
  }
  await ui.screenshot("codex-prime");
  await ui.mark({ css: ".interactive-item-container.interactive-response .rendered-markdown" }, { what: "Codex 答出的那一条", where: "Codex 会话的回复", how: "新会话选 Codex，问它开头收到的偏好" });
}
