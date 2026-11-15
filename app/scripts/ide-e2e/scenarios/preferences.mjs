// Preferences end to end: say one in a throwaway session, see it remembered, undo it, have it remembered
// again, find it with its words in Knowledge, and see a new session's prime carry it.
// Talks to a real agent (the person's own Claude login): run it only in a test instance, with a long
// --timeout (every agent turn is a minute or more). Start the instance with an empty preference store to
// get the empty Knowledge page as the first picture.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export const meta = { needs: ['claude'],
  title: "偏好：会话里说一句，记下、撤销、再记、Knowledge 里看到、新会话里带着",
  description: "一次性会话里说「这个开关用方角，别用胶囊」：Agent 用 Dispatch 的 prefs_add 工具（MCP 服务）记下，回复下一行 Remembered，输入框上方弹 Preference remembered；点 Undo 撤掉；再说一次又记下；Customizations › Knowledge 里看到带原话的一条；新开一个会话，它开头收到的偏好段里有这一条；最后一次记三条，回复下一行可以展开。",
};

const SAY = "这个开关用方角，别用胶囊";
const INPUT = [{ css: ".interactive-input-part .chat-editor-container" }, "What should we do?", { css: ".sessions-chat-editor" }];
const AGENT_MS = 300000;

async function input(ui) {
  for (const spec of INPUT) if (await ui.exists(spec)) return spec;
  return INPUT[0];
}

/** The new session page, for sure: a click on New that lands while something else has the focus leaves the
 *  last session on screen, and typing there would go into it. */
export async function freshPage(ui) {
  for (let attempt = 1; ; attempt++) {
    await ui.newSession();
    try {
      // the placeholder, or the new session's box holding a draft someone left (dictation on a shared Mac): emptied
      await ui.waitFor({ css: '.sessions-chat-editor' }, { timeoutMs: 10000 });
      if (!(await ui.exists("What should we do?"))) {
        await ui.click({ css: '.sessions-chat-editor' });
        await ui.press('End');
        for (let i = 0; i < 300 && !(await ui.exists("What should we do?")); i++) await ui.press('Backspace');
        await ui.waitFor("What should we do?", { timeoutMs: 5000 });
      }
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await ui.press("Escape");
    }
  }
  await pickModel(ui);
}

/** The person's rule for test sessions: Claude Code runs on Haiku, the cheapest (10-08; before, Sonnet, never Opus).
 *  MODEL=<another> picks that one instead of Opus, MODEL= (empty) keeps the page's default; another ENGINE keeps its own. */
async function pickModel(ui) {
  const model = process.env.MODEL ?? "Haiku";
  const engine = process.env.ENGINE;
  if (!model || (engine && engine !== "Claude Code")) return;
  if (model === "Haiku") return void (await ui.pickModel(/Haiku/i, "Claude Code's Haiku"));
  if (!(await ui.exists({ text: "Opus", exact: true }))) return; // already another model
  await ui.click({ text: "Opus", exact: true });
  await ui.sleep(500);
  await ui.click({ text: model, exact: true });
  await ui.waitFor({ text: "Opus", exact: true }, { timeoutMs: 10000, gone: true });
}

/** ENGINE=Codex runs the sessions on another engine than the new session page's default (Claude Code). */
export async function newSession(ui) {
  await freshPage(ui);
  const engine = process.env.ENGINE;
  if (engine && engine !== "Claude Code") {
    await ui.pickEngine(engine);
    await ui.sleep(3000); // its app-server starts on first use
  }
}

export async function say(ui, text) {
  const box = await input(ui);
  await ui.click(box);
  // the box empty first: a stray character that landed in it (a key someone pressed on this Mac while the test window
  // had the focus, 10-08: "都") would go out with the words
  const typed = () => ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(box.css || "")}); const v = e && (e.querySelector('.view-lines') || e.closest('.monaco-editor')?.querySelector('.view-lines')); return (v?.innerText || '').replace(/\\s+/g, ''); })()`);
  if (box.css && (await typed())) {
    await ui.press("End");
    for (let i = 0; i < 300 && (await typed()); i++) await ui.press("Backspace");
  }
  await ui.type(text);
  // an engine that is still starting (Codex's app-server on its first use) drops the first Enter: the
  // words stay in the box. Sent means they show up as the request in the conversation.
  for (let attempt = 1; ; attempt++) {
    await ui.press("Enter", { send: true });
    try {
      await ui.waitFor({ text, within: ".interactive-request" }, { timeoutMs: 15000 });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

/** Wait until the reply is over. An agent that wants a tool the session has to allow (a browser MCP to look
 *  at its own change) would wait forever in a test: such a request is skipped, the demo needs no browser. */
/** A tool the agent reaches for on its own (Playwright to look at the page, say) asks for approval in the test
 *  instance and would hold the turn: skip it, the walk-through is about the preference. */
async function skipApprovals(ui) {
  // an agent that still runs `dispatch prefs add` in a shell may ask to step out of its sandbox for it; the person
  // allows that, as they would on their own Mac (with Dispatch's tools nothing asks)
  // (the request sits above the input box, outside the conversation's own elements: found by its buttons)
  if (await ui.exists({ text: "1 confirmation pending" }) && await ui.exists({ text: "Allow", exact: true }) && await ui.exists({ text: "Skip", exact: true })) {
    await ui.click({ text: "Allow", exact: true });
    await ui.sleep(1500);
    return;
  }
  if (await ui.exists({ text: "Skip", exact: true, within: ".interactive-item-container" })) {
    await ui.click({ text: "Skip", exact: true, within: ".interactive-item-container" });
  }
}

export async function replyDone(ui, timeoutMs = AGENT_MS) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (!(await ui.exists({ css: ".interactive-item-container.chat-response-loading" }))) return;
    await skipApprovals(ui);
    if (Date.now() > until) throw new Error(`the reply is still running after ${timeoutMs} ms`);
    await ui.sleep(3000);
  }
}

/** Wait for spec while the agent works, skipping approvals on the way. */
export async function waitSkipping(ui, spec, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await ui.exists(spec)) return;
    await skipApprovals(ui);
    if (Date.now() > until) throw new Error(`never appeared after ${timeoutMs} ms: ${JSON.stringify(spec)}`);
    await ui.sleep(2000);
  }
}

/** Wait until the last element matching css has this text in it (a long reply line is past the locator's
 *  prefix match, so this reads innerText). */
export async function waitForTextIn(ui, css, needle, timeoutMs) {
  const until = Date.now() + timeoutMs;
  // a RegExp: any of several wordings (the agent may write the preference's sentence in English)
  const test = needle instanceof RegExp ? `new RegExp(${JSON.stringify(needle.source)}, ${JSON.stringify(needle.flags)}).test(t)` : `t.includes(${JSON.stringify(needle)})`;
  const expr = `(() => { const all = [...document.querySelectorAll(${JSON.stringify(css)})]; const el = all[all.length - 1]; const t = el ? (el.innerText || "") : ""; return !!el && ${test}; })()`;
  for (;;) {
    if (await ui.eval(expr)) return;
    await skipApprovals(ui);
    if (Date.now() > until) throw new Error(`never appeared after ${timeoutMs} ms: ${needle} in ${css}`);
    await ui.sleep(2000);
  }
}

/** The demo project runs the build's own `dispatch prime` at session start (the person's ~/.claude hook
 *  runs the installed CLI). Committed: a new session works in its own worktree of the project. */
function homeRelative(p) {
  const home = process.env.HOME || "";
  return home && p.startsWith(home + "/") ? "$HOME" + p.slice(home.length) : p;
}

function primeHook(folder) {
  const dir = path.join(folder, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    // PRIME_CLI=<dispatch.py>: the prime of a newer CLI than the build's (what agents are told changes
    // more often than the window)
    // (under $HOME it is written with $HOME: a commit hook here refuses absolute paths in .claude/settings.json)
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: process.env.PRIME_CLI ? `python3 "${homeRelative(process.env.PRIME_CLI)}" prime --hook-json` : "dispatch prime --hook-json" }] }] },
  }, null, 2) + "\n");
  // "this switch" has to be something: a page with one capsule switch, the delivery the words are about
  fs.writeFileSync(path.join(folder, "toggle.html"), TOGGLE);
  const git = (...a) => execFileSync("git", ["-C", folder, "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...a], { encoding: "utf8" });
  git("add", ".claude/settings.json", "toggle.html");
  if (git("diff", "--cached", "--name-only").trim()) git("commit", "-q", "-m", "chore: prime at session start, a settings page with a switch");
}

const TOGGLE = `<!doctype html>
<meta charset="utf-8">
<title>Settings</title>
<style>
  body { font: 14px -apple-system, sans-serif; margin: 40px; }
  .row { display: flex; align-items: center; gap: 12px; }
  .switch { width: 40px; height: 22px; border-radius: 999px; background: #d6d3d1; position: relative; }
  .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 999px; background: #fff; }
  .switch.on { background: #292524; }
  .switch.on::after { left: 21px; }
</style>
<div class="row"><span class="switch on" role="switch" aria-checked="true"></span> Notify me when a task is done</div>
`;

export default async function (ui) {
  primeHook(ui.demoFolder);

  // 0. before anything is remembered: the empty Knowledge page (a new session page left open by an
  // earlier run can swallow the first click: Escape and once more)
  await ui.openAgents(ui.demoFolder);
  try {
    await ui.openCustomizations("Knowledge");
  } catch {
    await ui.press("Escape");
    await ui.openCustomizations("Knowledge");
  }
  await ui.waitFor({ text: "What Dispatch knows about you" }, { timeoutMs: 30000 });
  // the heading is drawn before the store is read: wait for the page to know it is empty
  const empty = await ui.waitFor({ text: "Nothing remembered yet" }, { timeoutMs: 20000 }).then(() => true, () => false);
  if (empty) {
    // the Import button comes when the dry run over the old places is back (it reads every engine memory)
    await ui.waitFor({ text: "Import from" }, { timeoutMs: 90000 }).catch(() => undefined);
    await ui.screenshot("0-empty");
    await ui.mark({ text: "Nothing remembered yet" }, { what: "还什么都没记的时候", where: "Knowledge 最上面的框", how: "Customizations › Knowledge；下面的按钮从 FACTS.md、引擎记忆、design/taste 导入" });
  }
  await ui.closeOverlays();

  // PREFS_SEED=<a preferences.jsonl> (and PREFS_SEED_EVIDENCE=<its evidence folder>): what the person
  // had before this session, added after the empty page (an import's result, say)
  if (process.env.PREFS_SEED) {
    const home = ui.rec.dispatch_home;
    fs.mkdirSync(path.join(home, "preferences", "evidence"), { recursive: true });
    fs.appendFileSync(path.join(home, "preferences.jsonl"), fs.readFileSync(process.env.PREFS_SEED, "utf8"));
    if (process.env.PREFS_SEED_EVIDENCE) fs.cpSync(process.env.PREFS_SEED_EVIDENCE, path.join(home, "preferences", "evidence"), { recursive: true });
  }

  // 1. a throwaway session: say it
  await newSession(ui);
  await say(ui, SAY);
  // the toast comes when the agent runs `prefs add` and folds away 8 s later; the line under the reply comes when
  // the reply is done, which can be well after that with a slower model: wait for them in that order
  await waitSkipping(ui, { text: "Preference remembered" }, AGENT_MS);
  await ui.screenshot("1-remembered");
  await ui.mark({ text: "Preference remembered" }, { what: "Preference remembered 提示", where: "输入框正上方，对话让出位置", how: "记下的那一刻弹出，8 秒后收起，鼠标停在上面不收" });

  // 2. Undo in the toast (while it is up; the line under the reply comes once the reply is done, as Forgotten)
  await ui.click({ text: "Undo", exact: true, within: ".dispatch-prefs-toast" });
  await waitSkipping(ui, { text: "Forgotten:" }, AGENT_MS);
  await ui.screenshot("2-undone");
  await ui.mark({ text: "Forgotten:", within: ".dispatch-prefs-remembered" }, { what: "撤掉之后", where: "同一行变成 Forgotten", how: "点提示里的 Undo；这一行的 Undo 还能再放回来" });

  // 3. say it again: remembered again (once the first reply is over: a message sent while the agent still
  // works stops it and joins the same turn)
  await ui.waitFor({ css: ".dispatch-prefs-toast" }, { timeoutMs: 20000, gone: true });
  await replyDone(ui);
  await say(ui, "还是记下吧：" + SAY + "。");
  await waitSkipping(ui, { text: "Preference remembered" }, AGENT_MS);
  await ui.screenshot("3-again");
  // the reply done: the line sits under it, not folded into the steps
  await replyDone(ui);
  await ui.waitFor({ css: ".dispatch-prefs-toast" }, { timeoutMs: 20000, gone: true });
  await ui.waitFor({ css: ".dispatch-prefs-footer" }, { timeoutMs: 20000 });
  await ui.sleep(600);
  await ui.screenshot("3b-under-reply");
  // the second reply's line (the first one's says Forgotten since the Undo)
  await ui.mark({ text: "Remembered:", within: ".dispatch-prefs-footer" }, { what: "回复完成以后的 Remembered 行", where: "回复正文下面，步骤收起来它还在", how: "回完就在；Edit 就地改，Forget 忘掉" });

  // 4. Knowledge: the preference with the words
  await ui.openCustomizations("Knowledge");
  await ui.waitFor({ text: "What Dispatch knows about you" }, { timeoutMs: 30000 });
  await ui.waitFor({ css: ".know .kr" }, { timeoutMs: 30000 });
  // About you and the card counts come a moment later, Engine memory last: shoot once nothing is loading
  await ui.waitFor({ css: ".know .loading" }, { timeoutMs: 60000, gone: true }).catch(() => undefined);
  await ui.waitFor({ text: "…", exact: true, within: ".card" }, { timeoutMs: 90000, gone: true }).catch(() => undefined);
  await ui.sleep(800);
  await ui.screenshot("4-knowledge");
  await ui.click({ text: "Preferences", exact: true });
  await ui.waitFor({ text: "New Preference", exact: true }, { timeoutMs: 30000 });
  await ui.screenshot("5-preferences");
  // the newest first: the one just remembered heads the New group
  await ui.click({ css: ".sec .row" });
  await ui.waitFor({ text: "Your words", exact: true }, { timeoutMs: 30000 });
  await ui.screenshot("6-preference");
  await ui.mark({ text: "Your words", exact: true }, { what: "你的原话", where: "这条偏好的详情页", how: "Customizations › Knowledge › Preferences › 点这一行" });

  // 5. a new session: its prime carries it
  await ui.closeOverlays();
  await newSession(ui);
  await say(ui, "只回答一行：把你这次会话开头收到的「偏好」段里讲开关的那一条原样发给我，不要做别的。");
  // the line as the brief has it: the preference's sentence, in the words the agent recorded it (Haiku writes English)
  await waitForTextIn(ui, ".interactive-item-container.interactive-response", /方角|square corners/i, AGENT_MS);
  await replyDone(ui);
  await ui.screenshot("7-new-session-prime");

  // 6. several in one message: the agent records them in one --batch call, so one line under the reply
  // ("Remembered 3 from your feedback: … Show") and one toast ("3 preferences remembered")
  // three nothing has recorded yet: an agent may skip ones it finds already known
  await say(ui, "再记三条我的偏好：按钮文字用动词开头；空状态给一句下一步该做什么；表格里的数字右对齐。");
  await waitForTextIn(ui, ".dispatch-prefs-footer", "Remembered", AGENT_MS);
  await replyDone(ui);
  await ui.waitFor({ css: ".dispatch-prefs-toast" }, { timeoutMs: 20000, gone: true }).catch(() => undefined);
  await ui.sleep(800);
  await ui.screenshot("8-several");
  if (await ui.exists({ text: "Show", exact: true, within: ".dispatch-prefs-footer" })) {
    await ui.click({ text: "Show", exact: true, within: ".dispatch-prefs-footer" });
    await ui.waitFor({ text: "Hide", exact: true, within: ".dispatch-prefs-footer" }, { timeoutMs: 10000 });
    await ui.screenshot("9-several-open");
    await ui.mark({ text: "Hide", exact: true, within: ".dispatch-prefs-footer" }, { what: "一次记下好几条", where: "回复下面那一行，展开成每条一行", how: "点 Show 展开，每条有 Like / Avoid、适用范围、Edit、Forget" });
  }
}
