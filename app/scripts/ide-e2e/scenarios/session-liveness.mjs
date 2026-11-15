// A session never hangs silently (dispatch-ide patches/260-session-liveness.patch), with a real Claude
// Code session in the Agents window:
//   1. the agent asks "A or B?" (AskUserQuestion): the question card, the input's placeholder, the row
//      "Waiting for your answer"; the answer is typed into the chat input and sent: the agent gets it
//      as the answer (it replies YOU PICKED …), no new message is started
//   2. asked again, the answer is picked on the card (option A, Submit)
//   3. asked again, stop: the question is cancelled and the session goes on (next message answered)
//   4. a command that runs 70 s with no output: after 45 s the row says how long and the last step
// LIVENESS_ENGINE=codex | opencode runs it on Codex (request_user_input) or OpenCode (its question tool); the
// permission card step is Claude only.
export const meta = { needs: ['claude'],
  title: "会话不能卡死",
  description: "Agent 提问：卡片、输入框直接回答、卡上点选、停止取消；45 秒没动静时说出最后一步。",
};

const ENGINE = process.env.LIVENESS_ENGINE || "claude";
const ASK = (header) => ENGINE === "codex"
  ? `Call the request_user_input tool once with one question: header '${header}', question 'Which one, A or B?', options A and B. After I answer, reply with exactly: YOU PICKED <answer>. Nothing else.`
  : ENGINE === "opencode"
  ? `Use the question tool once to ask me: 'Which one, A or B?' with header '${header}' and two options A and B. After I answer, reply with exactly: YOU PICKED <answer>. Nothing else.`
  : `Use the AskUserQuestion tool once to ask me: 'Which one, A or B?' with header '${header}' and two options A and B. After I answer, reply with exactly: YOU PICKED <answer>. Nothing else.`;

const tail = (ui, n = 600) => ui.eval(`(document.querySelector('.interactive-list')||document.body).innerText.slice(-${n})`);
// the working row under the last reply (the stall row) is outside the list
const bodyTail = (ui, n = 800) => ui.eval(`(document.querySelector('.interactive-session')||document.body).innerText.slice(-${n})`);

async function waitText(ui, re, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await tail(ui, 1500);
    if (re.test(t)) return t;
    await ui.sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}: ${(await tail(ui, 300)).replace(/\n+/g, " | ")}`);
}

async function waitResponseText(ui, re, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const reply = await ui.eval(`(() => { const e = [...document.querySelectorAll('.interactive-response')].at(-1); return e && !e.classList.contains('chat-response-loading') ? e.innerText : ''; })()`);
    if (re.test(reply)) return reply;
    await ui.sleep(1000);
  }
  throw new Error(`timed out waiting for assistant response: ${what}`);
}

const cardVisible = (ui) => ui.eval(`(() => { const e = document.querySelector('.interactive-input-part .chat-question-carousel-container'); return !!e && e.offsetHeight > 0; })()`);

async function waitCard(ui, timeoutMs = 120000) {
  const t0 = Date.now();
  while (!(await cardVisible(ui))) {
    if (Date.now() - t0 > timeoutMs) throw new Error("no question card");
    await ui.sleep(1000);
  }
  await ui.sleep(800);
}

async function send(ui, text) {
  await ui.click({ css: ".interactive-input-part .monaco-editor .view-lines" });
  await ui.type(text);
  await ui.press("Enter", { send: true });
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  // the new-session page keeps the last engine: switch only when it is not the one asked for
  const want = { codex: "Codex", opencode: "OpenCode" }[ENGINE] || "Claude Code";
  const picker = ".sessions-chat-session-type-picker";
  await ui.pickEngine(want);
  await ui.sleep(6000); // the model list arrives; Enter before it is ignored
  await ui.click({ css: ".sessions-chat-editor .monaco-editor .view-lines" });
  await ui.type(process.env.LIVENESS_STALL_ONLY === "1" ? "Reply READY only. Do not use tools." : ASK("Pick"));
  await ui.press("Enter", { send: true });

  if (process.env.LIVENESS_STALL_ONLY === "1") {
    await waitResponseText(ui, /^READY$/m, 120000, "the initial real reply");
  } else {
  // 1. the card, the placeholder, the row; the answer typed into the input
  await waitCard(ui);
  await ui.sleep(800);
  await ui.screenshot("01-question-card");
  await ui.mark({ css: ".chat-question-carousel-container" }, { what: "Agent 的提问卡：问题、选项、自己写的回答", where: "输入框正上方", how: "点选项再 Submit，或按 1 2 直接选" });
  await ui.mark({ css: ".interactive-input-part .monaco-editor" }, { what: "有提问挂着时输入框写 Pick an option above, or type your own answer", where: "提问卡下面的输入框", how: "直接打字回车，就是这道题的回答" });
  if (!process.env.LIVENESS_SKIP_WAITING_ROW) await ui.mark({ text: "Waiting for your answer" }, { what: "进度那行写 Waiting for your answer，不再是 Analyzing", where: "对话末尾", how: "看一眼就知道在等你" });
  const placeholder = await ui.eval(`document.querySelector('.interactive-input-part .monaco-editor')?.innerText || ''`);
  if (!/Pick an option above, or type your own answer/.test(placeholder)) throw new Error(`placeholder is "${placeholder}"`);
  await send(ui, "B");
  await waitText(ui, /YOU PICKED B/, 120000, "the agent to get B typed in the input");
  if (/Skipped question/.test(await tail(ui, 1500))) throw new Error("the question was skipped instead of answered");
  await ui.screenshot("02-typed-answer");

  // 2. picked on the card
  await send(ui, ASK("Second"));
  await waitCard(ui);
  await ui.click({ css: ".interactive-input-part .chat-question-list-item", index: 0 });
  await ui.sleep(500);
  if (await ui.exists({ css: ".interactive-input-part .chat-question-submit-button" })) await ui.click({ css: ".interactive-input-part .chat-question-submit-button" });
  await waitText(ui, /YOU PICKED A/, 120000, "the agent to get A picked on the card");
  await ui.screenshot("03-picked-on-card");

  // 3. the question survives a window reload; then stop while it waits
  await send(ui, ASK("Third"));
  await waitCard(ui);
  await ui.reloadWindow(); // a real reload (location.reload() is refused by the workbench)
  await ui.sleep(10000);
  const t1 = Date.now();
  while (!(await cardVisible(ui))) {
    if (Date.now() - t1 > 60000) throw new Error("the question card did not come back after a reload");
    await ui.sleep(1000);
  }
  await ui.sleep(800);
  await ui.screenshot("04-after-reload");
  await ui.click({ css: ".interactive-input-part .codicon-stop-circle, .interactive-input-part [aria-label^='Cancel'], .interactive-input-part [aria-label^='Stop']" });
  const t2 = Date.now();
  while (await cardVisible(ui)) {
    if (Date.now() - t2 > 30000) throw new Error("stop did not take the question card away");
    await ui.sleep(500);
  }
  await ui.sleep(1500);
  // the next message goes on in the same session, with what came before (the header of the question
  // that was stopped is only in the history)
  await send(ui, "What was the header of the last question you asked me? Reply with that one word only, then a space and the word STILL, then HERE.");
  await waitText(ui, /Third STILL HERE/i, 120000, "the session to go on after stop, with its history");
  await ui.screenshot("05-after-stop");
  await ui.mark({ text: "Third STILL HERE", exact: true }, { what: "停掉提问后再发消息，同一个会话照常回答", where: "对话末尾", how: "停止键取消提问，不用新开会话" });

  // the permission card next to it, for the review (the question card is meant to look like it)
  if (ENGINE === "claude") {
  await send(ui, "Use the Write tool to create hello.txt containing hi. Then reply with exactly: WROTE");
  const tp = Date.now();
  // in a worktree session an edit may go through without asking
  while (Date.now() - tp < 20000 && !(await ui.exists({ text: "Allow", exact: true }))) await ui.sleep(1000);
  if (await ui.exists({ text: "Allow", exact: true })) {
    await ui.sleep(800);
    await ui.screenshot("06-permission-card");
    await ui.click({ text: "Allow", exact: true });
  }
  await waitText(ui, /WROTE[\s\S]*WROTE/, 120000, "the write to finish");
  }

  }
  // 4. a step with no news for 45 s
  await send(ui, ENGINE === "codex"
    ? "Run this exact shell command and nothing else: sleep 70 && echo slept. Then reply with exactly: DONE SLEEPING"
    : "Run this exact shell command with the Bash tool and nothing else: sleep 70 && echo slept. Then reply with exactly: DONE SLEEPING");
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (await ui.exists({ text: "Allow" })) { await ui.click({ text: "Allow", index: 0 }); break; }
    if (/sleep 70/.test(await tail(ui, 400))) break;
    await ui.sleep(1500);
  }
  const ts = Date.now();
  while (!(await ui.eval(`/Nothing new for/.test(document.body.innerText)`))) {
    if (Date.now() - ts > 90000) throw new Error("timed out waiting for the stall row: " + (await bodyTail(ui, 300)).replace(/\n+/g, " | "));
    await ui.sleep(2000);
  }
  // This is a transient progress row. Its text was verified above; capture it
  // without relying on the long-paragraph locator used for persistent content.
  await ui.screenshot("07-stall-row");
  await waitResponseText(ui, /^DONE SLEEPING$/m, 120000, "the command to finish");
}
