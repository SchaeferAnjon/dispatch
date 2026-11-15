// Several preferences in one message: one `dispatch prefs add --batch`, one toast, and under the finished
// reply one line "Remembered 3 from your feedback: … Show" that opens into rows. Three that nothing has
// recorded yet, so the agent has no reason to skip one as already known. Talks to a real agent: test
// instance only.
import { freshPage, newSession, replyDone, say, waitForTextIn } from "./preferences.mjs";

export const meta = { needs: ['claude'],
  title: "偏好：一条消息里说三条",
  description: "新会话里一句话说三条偏好：Agent 一次 --batch 记下，回复完成后回复下面一行「Remembered 3 from your feedback」，点 Show 展开成三行。",
};

const AGENT_MS = 300000;

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  // ENGINE=OpenCode (or Codex) talks to that engine instead of the page's default Claude Code
  await (process.env.ENGINE ? newSession(ui) : freshPage(ui));
  await say(ui, "再记三条我的偏好：按钮文字用动词开头；空状态给一句下一步该做什么；表格里的数字右对齐。");
  await waitForTextIn(ui, ".dispatch-prefs-footer", "Remembered", AGENT_MS);
  await replyDone(ui);
  await ui.waitFor({ css: ".dispatch-prefs-toast" }, { timeoutMs: 20000, gone: true }).catch(() => undefined);
  await ui.sleep(800);
  await ui.screenshot("8-several");
  await ui.click({ text: "Show", exact: true, within: ".dispatch-prefs-footer" });
  await ui.waitFor({ text: "Hide", exact: true, within: ".dispatch-prefs-footer" }, { timeoutMs: 10000 });
  await ui.screenshot("9-several-open");
  await ui.mark({ text: "Hide", exact: true, within: ".dispatch-prefs-footer" }, { what: "一次记下好几条", where: "回复下面那一行，展开成每条一行", how: "点 Show 展开，每条有 Like / Avoid、适用范围、Edit、Forget" });
}
