// One picture of where the pages the other scenarios test live in the Agents window.
export const meta = {
  title: "Agents 窗口里的功能在哪",
  description: "一张图：Waiting for you、Projects、右栏 Tasks 页签、Settings 里的 Abilities（Find skills 在它最后）和 Knowledge 各在哪、怎么进去。",
};

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession(); // a page with the side pane (Waiting for you and Projects are full width)
  await ui.openTab("Tasks");
  await ui.waitFor({ text: "This session", within: ".dispatch-tasks" }, { timeoutMs: 20000 });
  await ui.screenshot("agents-window");
  await ui.mark({ text: "Waiting for you", exact: true }, { what: "Waiting for you", where: "左侧栏第一行", how: "点它：等你批准、决定、没读的回复和只能你做的事" });
  await ui.mark({ text: "Projects", exact: true }, { what: "Projects", where: "左侧栏 Sessions 下面", how: "点它：所有项目和各自的任务、会话、文档" });
  await ui.mark({ aria: "Tasks", exact: true, within: ".tabs-container" }, { what: "Tasks 页签", where: "右栏顶部", how: "点它：这段会话或整个项目的任务和计划" });
  await ui.mark({ text: "Settings", exact: true, within: ".part.sidebar" }, { what: "Settings", where: "左侧栏最下面", how: "点它或按 ⌘,：账号、Agent、Abilities（技能、Find skills）、Knowledge 都在这里" });
  // Settings: its own side bar lists the pages Customizations used to hold
  await ui.press("Cmd+,");
  await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 15000 });
  await ui.screenshot("settings");
  await ui.mark({ text: "Abilities", exact: true, within: ".dispatch-settings-nav" }, { what: "Abilities", where: "Settings 左栏", how: "技能、外部工具、插件；最后一行是 Find skills" });
  await ui.mark({ text: "Knowledge", exact: true, within: ".dispatch-settings-nav" }, { what: "Knowledge", where: "Settings 左栏", how: "点它：wiki、Facts、About me" });
}
