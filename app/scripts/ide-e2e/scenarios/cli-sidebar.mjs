// The instance starts with fixtures/cli-sidebar.py (meta.instance.fixture). Every title is synthetic; no agent turns are sent.
export const meta = { instance: { fixture: "cli-sidebar" }, title: "CLI sidebar filtering", description: "Keep interactive chats, collapse worktrees, and find one-shot runs through search." };

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  const sidebar = ".agent-sessions-viewpane";
  await ui.waitFor({ text: "CLI Conversation", within: sidebar }, { timeoutMs: 45000 });
  await ui.waitFor({ text: "CLI App Conversation", within: sidebar });
  await ui.waitFor({ text: "Worktrees", exact: true, within: sidebar });
  if (await ui.exists({ text: "CLI One-shot", within: sidebar })) throw new Error("One-shot run leaked into the sidebar");
  if (await ui.exists({ text: "CLI Worktree", within: sidebar })) throw new Error("Worktrees did not start collapsed");
  await ui.click({ text: "Worktrees", exact: true, within: sidebar });
  await ui.waitFor({ text: "CLI Worktree", within: sidebar });
  await ui.click({ text: "Worktrees", exact: true, within: sidebar });
  await ui.waitFor({ text: "CLI Worktree", within: sidebar }, { gone: true });
  await ui.click("Find Session or Code");
  await ui.type("CLI One-shot", { into: "Search sessions by name or folder" });
  await ui.waitFor({ text: "CLI One-shot", within: ".quick-input-widget" });
  await ui.press("Escape");
  if (await ui.exists({ text: "CLI One-shot", within: sidebar })) throw new Error("Search changed sidebar visibility");
}
