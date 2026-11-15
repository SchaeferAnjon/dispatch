// Waiting for you: approvals, decisions, unread replies and what only the user can do, across projects. Since
// 2026-11-11 (design/home-now direction A, task-0v1o9) the newest things hang right under the entry in the side bar
// and the page lists This week and Older, one row per thing.
export const meta = {
  title: "Waiting for you 页",
  description: "Agents 窗口左侧栏最上面的 Waiting for you：入口下面直接挂最近几件；页面分 This week 和 Older，一件一行。",
};

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  // the seeded Only-you task hangs right under the entry
  await ui.waitFor({ css: ".session-section.dispatch-wait-row" }, { timeoutMs: 30000 });
  await ui.waitFor({ text: "Approve the demo release", within: ".sessions-list-control" }, { timeoutMs: 20000 });
  await ui.mark({ css: ".session-section.dispatch-waiting-section" }, { what: "Waiting for you 入口", where: "左侧栏第一行，数字只数 7 天内的", how: "点它打开整页" });
  await ui.mark({ css: ".session-section.dispatch-wait-row" }, { what: "最近一件", where: "入口下面，最多 3 行", how: "点它做页面里同样的事" });
  await ui.click({ css: ".session-section.dispatch-waiting-section" });
  await ui.waitFor({ css: '.dispatch-waiting-page .dispatch-waiting-row[data-kind="only_you"]' }, { timeoutMs: 20000 });
  await ui.waitFor({ text: "Approve the demo release", within: ".dispatch-waiting-page" }, { timeoutMs: 20000 });
  await ui.screenshot("waiting-for-you");
  await ui.mark({ css: '.dispatch-waiting-page .dispatch-waiting-row[data-kind="only_you"]' }, { what: "只能你做的一条", where: "This week 里，行尾写 Only you", how: "选中后回车完成，r 回复" });
  await ui.mark({ css: ".dispatch-waiting-group-head" }, { what: "This week", where: "页面上段，新的在前", how: "7 天没动的在下面的 Older 里" });
}
