// The side pane's Tasks tab: the tasks of this session, or of its whole project (.dispatch-tasks).
export const meta = {
  title: "右栏 Tasks 页签",
  description: "Agents 窗口右栏的 Tasks 页签：This session 是这段会话的任务，项目名那一格是整个项目的任务和计划，Graph 是任务图。",
};

export default async function (ui) {
  const project = (ui.rec.seed && ui.rec.seed.project) || "demo";
  await ui.openAgents(ui.demoFolder);
  await ui.newSession(); // a page with the side pane (Waiting for you and Projects are full width)
  await ui.openTab("Tasks");
  await ui.waitFor({ text: "This session", within: ".dispatch-tasks" }, { timeoutMs: 20000 });
  await ui.click({ text: project, exact: true, within: ".dispatch-tasks" });
  await ui.waitFor({ text: "Add a Knowledge page", within: ".dispatch-tasks" }, { timeoutMs: 20000 });
  await ui.screenshot("tasks-tab");
  await ui.mark({ aria: "Tasks", exact: true, within: ".tabs-container" }, { what: "Tasks 页签", where: "右栏顶部页签，Changes / Files / Docs 旁边", how: "点它；没有时从右栏的 + 里加" });
  await ui.mark({ text: "This session", within: ".dispatch-tasks" }, { what: "This session", where: "Tasks 页签左上", how: "这段会话里 Agent 建的任务" });
  await ui.mark({ text: project, exact: true, within: ".dispatch-tasks" }, { what: "项目的任务", where: "This session 右边，写的是项目名", how: "点它看整个项目的任务和计划" });
  await ui.mark({ text: "Add a Knowledge page", within: ".dispatch-tasks" }, { what: "进行中的任务", where: "项目任务列表里", how: "点开看计划：做完的打勾，正在做的高亮" });
}
