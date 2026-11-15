// The Projects page: every project Dispatch knows, with its open tasks, sessions and documents.
export const meta = {
  title: "Projects 页",
  description: "Agents 窗口左侧栏的 Projects：Dispatch 知道的每个项目，带任务数、会话数和文档数；测试实例里只有演示项目 demo。",
};

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.click("Projects");
  await ui.waitFor({ text: "demo", exact: true, within: ".dispatch-projects-page" }, { timeoutMs: 20000 });
  await ui.screenshot("projects");
  await ui.mark({ text: "Projects", exact: true }, { what: "Projects 入口", where: "左侧栏 Sessions 下面", how: "点它" });
  await ui.mark({ text: "demo", exact: true, within: ".dispatch-projects-page" }, { what: "项目 demo", where: "Projects 页列表", how: "点项目名打开项目页（任务、会话、文档）" });
  await ui.mark("Add Project", { what: "Add Project", where: "Projects 页右上角", how: "选文件夹、按名字新建或从网上拷一份" });
}
