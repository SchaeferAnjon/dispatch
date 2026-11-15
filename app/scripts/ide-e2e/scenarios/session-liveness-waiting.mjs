const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
// LIVENESS_ENGINE=codex runs it on Codex. A question answered from Waiting for you (dispatch-ide patches/260-session-liveness.patch with
// 425-waiting.patch): a Claude Code session asks "A or B?"; its Decide card on the Waiting for you
// page takes the pick (the same `chat/inputCompleted` the session's own card sends); back in the
// session the agent got it and the question card is gone.
export const meta = { needs: ['claude'],
  title: "从 Waiting for you 直接回答提问",
  description: "会话里挂着的提问在 Waiting for you 的 Decide 卡上直接点选项，Agent 收到的就是这个答案。",
};

const tail = (ui, n = 1500) => ui.eval(`(document.querySelector('.interactive-list')||document.body).innerText.slice(-${n})`);
const cardVisible = (ui) => ui.eval(`(() => { const e = document.querySelector('.interactive-input-part .chat-question-carousel-container'); return !!e && e.offsetHeight > 0; })()`);

async function until(ui, fn, timeoutMs, what) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > timeoutMs * SCALE) throw new Error(`timed out waiting for ${what}`);
    await ui.sleep(1000);
  }
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  const want = { codex: "Codex", opencode: "OpenCode" }[process.env.LIVENESS_ENGINE] || "Claude Code";
  const picker = ".sessions-chat-session-type-picker";
  await ui.pickEngine(want);
  await ui.sleep(6000);
  await ui.click({ css: ".sessions-chat-editor" });
  await ui.type(want === "Codex"
    ? "Call the request_user_input tool once with one question: header 'Fourth', question 'Which one, A or B?', options A and B. After I answer, reply with exactly: YOU PICKED <answer>. Nothing else."
    : want === "OpenCode"
    ? "Use the question tool once to ask me: 'Which one, A or B?' with header 'Fourth' and two options A and B. After I answer, reply with exactly: YOU PICKED <answer>. Nothing else."
    : "Use the AskUserQuestion tool once to ask me: 'Which one, A or B?' with header 'Fourth' and two options A and B. After I answer, reply with exactly: YOU PICKED <answer>. Nothing else.");
  await ui.press("Enter", { send: true });
  await until(ui, () => cardVisible(ui), 120000, "the question card");
  const title = await ui.eval(`document.querySelector('.monaco-list-row.selected')?.innerText.split('\\n')[0].trim() || ''`);

  await ui.click({ text: "Waiting for you", exact: true, within: ".part.sidebar" }); // not the session's "Waiting for your answer"
  await until(ui, () => ui.eval(`!!document.querySelector('.dispatch-waiting-card .dispatch-waiting-options .dispatch-waiting-btn.outline')`), 30000, "the Decide card");
  await ui.sleep(800);
  await ui.screenshot("01-decide-card");
  await ui.mark({ css: ".dispatch-waiting-card .dispatch-waiting-options" }, { what: "Decide 卡上直接点选项（或按 1 2）", where: "Waiting for you 页，会话的提问卡", how: "点 A，答案直接回到会话" });
  await ui.click({ css: ".dispatch-waiting-card .dispatch-waiting-options .dispatch-waiting-btn.outline", index: 0 });
  await ui.sleep(2000);
  await ui.screenshot("02-picked");

  // back in the conversation: by its title, or (OpenCode names it anew meanwhile) the one conversation in the list
  if (title && await ui.exists({ text: title, within: ".part.sidebar" })) await ui.openSession(title);
  else await ui.click({ css: ".part.sidebar .monaco-list-row .session-item", index: 0 });
  await until(ui, async () => /YOU PICKED A/.test(await tail(ui)), 120000, "the agent to get A from Waiting for you");
  if (await cardVisible(ui)) throw new Error("the question card is still there after answering from Waiting for you");
  await ui.screenshot("03-session-got-it");
}
