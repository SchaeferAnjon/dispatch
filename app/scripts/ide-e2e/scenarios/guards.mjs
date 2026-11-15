// Self-check of the runner's guards, in a real window: typing into an open file is refused and the
// file stays as it was; Enter in a chat input is refused unless the scenario says {send: true}.
import fs from "fs";
import path from "path";

export const meta = {
  title: "e2e 的两道闸",
  description: "编辑器里打开的文件不让打字（文件不变）；聊天框里回车不发出去（除非场景写明 send: true）。",
};

async function refused(ui, code, fn) {
  try {
    await fn();
  } catch (e) {
    if (e.code === code) return e.message;
    throw e;
  }
  throw new Error(`expected a refusal (${code}), but it went through`);
}

export default async function (ui) {
  const readme = path.join(ui.demoFolder, "README.md");
  const before = fs.readFileSync(readme, "utf8");

  // 1. an open file
  await ui.openEditor();
  await ui.click({ text: "README.md", exact: true });
  await ui.waitFor({ css: ".editor-instance .view-lines" }, { timeoutMs: 15000 });
  await ui.click({ css: ".editor-instance .view-lines" });
  const why = await refused(ui, "focus", () => ui.type("typed by a test"));
  await ui.screenshot("refused-open-file");
  await ui.mark({ css: ".editor-instance .view-lines" }, { what: "编辑器里打开的 README.md", where: "编辑器窗口正文", how: "type() 在这里被拒绝，文件一个字没变" });
  if (fs.readFileSync(readme, "utf8") !== before) throw new Error("README.md changed");
  console.error("open file: " + why);

  // 2. Enter in the chat input
  await ui.openAgents();
  await ui.newSession();
  await ui.type("not sent", { into: "What should we do?" });
  const why2 = await refused(ui, "send", () => ui.press("Enter"));
  await ui.screenshot("refused-enter");
  await ui.mark({ css: ".sessions-chat-editor" }, { what: "新会话的聊天输入框", where: "Agents 窗口新会话页中间", how: "能打字；回车被拒绝，场景写 press(\"Enter\", {send: true}) 才会发出去" });
  for (let i = 0; i < "not sent".length; i++) await ui.press("Backspace");
  console.error("chat Enter: " + why2);
}
