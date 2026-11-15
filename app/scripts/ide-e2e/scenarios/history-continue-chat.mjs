// History's Continue in the chat (kanban task-b1ppr, Dispatch IDE patches/450-history.patch).
// A real conversation the agent ran outside Dispatch (`codex exec`, `claude -p`), never listed in the Agents window,
// is found in the History tab and continued the way a person does it: the row opened, the Chat | Terminal switch on
// Chat, Continue. The window takes the conversation in, shows it with what was said so far, and the next message goes
// on in the same conversation of the agent (its own transcript gets the new turn).
//
//   HISTORY_CHAT_AGENTS=codex,claude,opencode   which agents to try (default codex; Claude needs a logged-in claude on this Mac)
//
// Each costs one short real turn of that agent to seed, and one to continue.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { needs: ['codex'],
  title: "History：旧会话在图形对话里接着聊",
  description: "History 页签里一条 Claude Code / Codex 在 Dispatch 外跑过的会话：点开、Continue 旁边选 Chat、点 Continue，会话进左栏、在聊天里显示之前的对话，再发一句接着聊，Agent 自己的记录里多了这一轮。",
  timeout: 1500,
};

const AGENTS = (process.env.HISTORY_CHAT_AGENTS || "codex").split(",").map((s) => s.trim()).filter(Boolean);
const STAMP = Date.now().toString(36).slice(-5).toUpperCase();
const chatInput = ".interactive-input-part .monaco-editor";

function assert(ok, message) { if (!ok) throw new Error(message); }
const bin = (name) => {
  for (const d of [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  }
  return name;
};

/** One real turn of the agent outside Dispatch: its own conversation, with its id. */
function seed(ui, agent) {
  // under the instance: its lists only take sessions that worked there (DISPATCH_SESSION_ROOT)
  const folder = path.join(fs.realpathSync(ui.rec.root), "projects", `${agent}-chat-${STAMP.toLowerCase()}`);
  fs.mkdirSync(folder, { recursive: true });
  const words = `SEEDED ${agent.toUpperCase()} ${STAMP}`;
  const prompt = `Reply with exactly: ${words}`;
  if (agent === "codex") {
    const env = { ...process.env, CODEX_HOME: path.join(ui.rec.root, "codex-home") };
    const out = execFileSync(bin("codex"), ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", folder, prompt], { env, encoding: "utf8", timeout: 240000 });
    const started = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e && e.type === "thread.started");
    assert(started?.thread_id, `codex exec gave no thread: ${out.slice(0, 400)}`);
    const rollout = execFileSync("find", [path.join(env.CODEX_HOME, "sessions"), "-name", `*${started.thread_id}.jsonl`], { encoding: "utf8" }).trim().split("\n")[0];
    return { agent, folder, id: started.thread_id, words, prompt, transcript: rollout, engine: "Codex" };
  }
  if (agent === "opencode") {
    // a free fast model of OpenCode Zen; its conversation is in OpenCode's own store, read back with `opencode export`
    // the copy Dispatch runs (engines.pick: the first one new enough), not just ~/.opencode/bin: an old copy there cannot
    // open the store the instance's newer OpenCode already wrote ("Unexpected error" on 1.14 against a 1.18 database)
    const picked = execFileSync("python3", ["-c", "import sys, json; sys.path.insert(0, sys.argv[1]); import engines as E; print(E.pick(E.get('opencode'))['path'])",
      path.dirname(ui.rec.cli)], { encoding: "utf8", timeout: 60000 }).trim();
    const oc = picked || [path.join(os.homedir(), ".opencode", "bin", "opencode")].find((p) => fs.existsSync(p)) || bin("opencode");
    const model = process.env.HISTORY_CHAT_OPENCODE_MODEL || process.env.DISPATCH_E2E_OPENCODE_MODEL || "opencode/mimo-v2.6-flash-free"; // the free model that answers now (e2e_suite.free_model)
    // the instance's own OpenCode store (it runs with XDG_DATA_HOME / XDG_CONFIG_HOME inside its folder, as Codex runs
    // with CODEX_HOME there); PWD: OpenCode files the session under PWD, which node passes on from where the run started
    // (its --dir and --title kept `opencode run` from ending on 1.18)
    const env = { ...process.env, PWD: folder, XDG_DATA_HOME: path.join(ui.rec.root, "xdg-data"), XDG_CONFIG_HOME: path.join(ui.rec.root, "xdg-config") };
    let out;
    try {
      // stdin closed: `opencode run` on an open pipe waits for more input after it has answered
      out = execFileSync(oc, ["run", "--format", "json", "-m", model, prompt], { cwd: folder, env, encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      // OpenCode prints only "Unexpected error, check log file": put the end of that log in the failure
      const logs = path.join(env.XDG_DATA_HOME, "opencode", "log");
      const last = fs.existsSync(logs) ? fs.readdirSync(logs).filter((f) => f.endsWith(".log")).sort().at(-1) : "";
      const tail = last ? fs.readFileSync(path.join(logs, last), "utf8").split("\n").filter((l) => /ERROR|error/.test(l)).slice(-6).join("\n") : "";
      throw new Error(`${String(e.message).slice(0, 300)}\n${tail}`);
    }
    const id = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e && e.sessionID)?.sessionID;
    assert(id && out.includes(words), `opencode run gave no answer: ${out.slice(0, 400)}`);
    const has = (text) => { try { return execFileSync(oc, ["export", id], { cwd: folder, env, encoding: "utf8", timeout: 60000 }).includes(text); } catch { return false; } };
    return { agent, folder, id, words, prompt, has, engine: "OpenCode" };
  }
  const out = JSON.parse(execFileSync(bin("claude"), ["-p", prompt, "--output-format", "json", "--model", "haiku"], { cwd: folder, encoding: "utf8", timeout: 240000 }));
  assert(out.session_id, `claude -p gave no session: ${JSON.stringify(out).slice(0, 300)}`);
  // the instance's own config folder when the run has a test token (ide_e2e.claude_home), else ~/.claude
  const transcript = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", fs.realpathSync(folder).replace(/[^A-Za-z0-9]/g, "-"), `${out.session_id}.jsonl`);
  return { agent: "claude-code", folder, id: out.session_id, words, prompt, transcript, engine: "Claude Code" };
}

const rowTitles = (ui) => ui.eval("JSON.stringify([...document.querySelectorAll('.dispatch-history-row .dispatch-history-title')].map(e => e.textContent))").then(JSON.parse);
const sidebarText = (ui) => ui.eval("[...document.querySelectorAll('.session-item')].map(e => e.innerText).join('\\n')");
const chatText = (ui) => ui.eval("[...document.querySelectorAll('.interactive-session .interactive-item-container')].map(e => e.innerText).join('\\n')");
const lastResponse = (ui) => ui.eval(`(() => {
  const rows = [...document.querySelectorAll('.interactive-response')];
  const row = rows.find(r => r.classList.contains('chat-most-recent-response')) || rows.at(-1);
  return row ? { text: row.innerText, loading: row.classList.contains('chat-response-loading') } : { text: '', loading: true };
})()`);

async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) {
    const v = await fn();
    if (v) return v;
    await ui.sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function search(ui, text) {
  await ui.click({ css: "input.dispatch-history-search-input" });
  await ui.eval("(() => { const i = document.querySelector('input.dispatch-history-search-input'); i.select(); })()");
  await ui.press("Backspace");
  // the list redraws as the first look at the history comes in: focus the box again if it lost the keyboard
  for (let i = 0; text && i < 4; i++) {
    try { await ui.type(text, { into: { css: "input.dispatch-history-search-input" } }); break; } catch (e) {
      if (i === 3) throw e;
      await closeTips(ui);
      await ui.sleep(2000);
      await ui.click({ css: "input.dispatch-history-search-input" });
    }
  }
  await ui.sleep(1500);
}

async function closeTips(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); i++) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(500);
  }
}

/** Types into a box, putting the keyboard back in it first when a tip that came up took it away. */
async function typeIn(ui, css, text) {
  for (let i = 0; ; i++) {
    try {
      if (i) {
        for (let k = 0; k < 4 && (await ui.exists({ css: ".dispatch-tour", webview: false })); k++) {
          await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => ui.press("Escape"));
          await ui.sleep(500);
        }
        await ui.click({ css, webview: false });
      }
      await ui.type(text);
      return;
    } catch (e) {
      if (i >= 3) throw e;
      await ui.sleep(1500);
    }
  }
}

export default async function (ui) {
  const results = { agents: {} };
  const seeded = [];
  try {
    for (const a of AGENTS) seeded.push(seed(ui, a));
    await ui.attach("agents", 30000).catch(() => ui.openAgents());
    await ui.closeOverlays();
    await ui.waitFor({ css: ".sessions-chat-editor, .interactive-input-part", webview: false }, { timeoutMs: 90000 }).catch(() => undefined);
    await ui.sleep(5000);
    await closeTips(ui);
    let n = 0;
    for (const s of seeded) {
      n++;
      const r = (results.agents[s.agent] = { id: s.id });
      const before = await sidebarText(ui);
      r.inSidebarBefore = before.includes(s.words);
      await ui.newSession();
      await ui.sleep(1500);
      await closeTips(ui);
      for (let i = 0; i < 3; i++) {
        try { await ui.openTab("History"); break; } catch (e) { if (i === 2) throw e; await ui.press("Escape"); await closeTips(ui); await ui.sleep(1500); }
      }
      if (await ui.exists({ text: "All", exact: true, within: ".dispatch-history-bar" })) await ui.click({ text: "All", exact: true, within: ".dispatch-history-bar" });
      await search(ui, s.words);
      // OpenCode names its sessions itself: the search (which reads the messages too) leaves that one row
      const pick = (titles) => titles.find((t) => t.includes(s.words)) || (s.agent === "opencode" && titles.length === 1 ? titles[0] : undefined);
      // a session made a moment ago: "Look for new sessions now", and the search again every 20 s, as a person would
      for (let tries = 0; !pick(await rowTitles(ui)); tries++) {
        if (tries >= 12) throw new Error(`the History row of ${s.agent} after ${tries * 20} s: ${JSON.stringify(await rowTitles(ui))}`);
        await ui.click({ aria: "Look for new sessions now", webview: false }).catch(() => undefined);
        await ui.sleep(20000);
        await search(ui, s.words);
      }
      const title = pick(await rowTitles(ui));
      await closeTips(ui);
      await ui.click({ text: title, within: ".dispatch-history-list" });
      await ui.waitFor({ css: ".dispatch-history-row.open .dispatch-history-continue-in", webview: false }, { timeoutMs: 20000 });
      r.choice = await ui.eval("[...document.querySelectorAll('.dispatch-history-row.open .dispatch-history-continue-in .dispatch-tasks-pill')].map(p => p.textContent + (p.classList.contains('on') ? ' (on)' : ''))");
      assert(r.choice.includes("Chat (on)") && r.choice.includes("Terminal"), `the switch: ${r.choice}`);
      await ui.screenshot(`0${n}a-${s.agent}-row`);
      await ui.mark({ css: ".dispatch-history-row.open .dispatch-history-continue-in", webview: false }, { what: "接着聊在哪：Chat 或 Terminal", where: "Continue 右边", how: "点一下切换，记住选择" });
      await ui.mark({ text: "Continue", exact: true, within: ".dispatch-history-row.open" }, { what: "Continue：在聊天里接着聊", where: "点开的会话里", how: "选 Chat 时点它" });

      // Continue: the conversation joins the sessions and opens in the chat, with what was said so far
      await closeTips(ui);
      await ui.click({ text: "Continue", exact: true, within: ".dispatch-history-row.open" });
      r.busy = await ui.eval("document.querySelector('.dispatch-history-row.open .dispatch-history-button.busy')?.innerText || ''");
      await until(ui, async () => (await chatText(ui)).includes(s.words), 90000, `the ${s.agent} conversation in the chat`, 1000);
      r.chatBefore = (await chatText(ui)).slice(0, 600);
      r.inSidebarAfter = await until(ui, async () => (await sidebarText(ui)).includes(s.words) || (await sidebarText(ui)).includes(s.prompt.slice(0, 30)) || (await sidebarText(ui)).includes(title.slice(0, 30)) || (s.agent === "opencode" && (await sidebarText(ui)).split("\n").length > before.split("\n").length), 30000, "the session on the left", 1000);
      await ui.screenshot(`0${n}b-${s.agent}-in-chat`);
      await ui.mark({ css: ".interactive-session", webview: false }, { what: "之前的对话照样在", where: "中间的聊天", how: "下面的输入框接着发" });

      // the next message goes on in the same conversation
      const next = `CONTINUED ${s.agent.toUpperCase()} ${STAMP}`;
      await ui.click({ css: chatInput });
      await typeIn(ui, chatInput, `Reply with exactly: ${next}`);
      await ui.press("Enter", { send: true });
      await until(ui, async () => { const x = await lastResponse(ui); return !x.loading && x.text.includes(next); }, 300000, `the ${s.agent} answer`, 2000);
      r.transcriptHasIt = await until(ui, async () => s.has ? s.has(next) : fs.existsSync(s.transcript) && fs.readFileSync(s.transcript, "utf8").includes(next), 60000, `${s.agent}'s own transcript to have the new turn`, 2000);
      await ui.screenshot(`0${n}c-${s.agent}-continued`);
    }
  } finally {
    // the Claude transcript lives in the person's ~/.claude: take it out again (Codex's is in the instance)
    for (const s of seeded) {
      if (s.agent === "claude-code") fs.rmSync(path.dirname(s.transcript), { recursive: true, force: true });
      fs.rmSync(s.folder, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(ui.out, "results.json"), JSON.stringify(results, null, 2));
  return results;
}
