// The Task graph (Dispatch IDE patches/430-tasks.patch, kanban design/task-graph/redesign/ direction A):
// from a new session's Tasks tab to its graph (the session's empty state), on to the project's graph, a mark's
// card, the right-hand line's details, a task page and back. Reads how long the page took to draw.
export const meta = {
  title: "Task graph",
  description: "Agents 窗口的 Task graph：从新会话右栏 Tasks 页签的 Graph 进来（这条会话还没有任务），切到项目：一行一件事、一天一格可左右滑动的时间轴、悬停点出卡、悬停右列出详情、点进任务页再回来。",
};

/** First-run tips (the Getting started tour) can sit over the page: close them before a picture, like a person would. */
function closeTipsBeforePictures(ui) {
  const shoot = ui.screenshot.bind(ui);
  ui.screenshot = async (...args) => {
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    return shoot(...args);
  };
}

export default async function (ui) {
  closeTipsBeforePictures(ui);
  await ui.openAgents(ui.rec.folder || ui.demoFolder);
  await ui.newSession();
  await ui.openTab("Tasks");
  // the tab draws its head once the session's tasks are read (the CLI: a moment on a busy Mac)
  await ui.waitFor({ css: ".dispatch-tasks-graph" }, { timeoutMs: 30000 });
  await ui.click({ css: ".dispatch-tasks-graph" });
  await ui.waitFor({ css: ".dispatch-tg-empty, .dispatch-tg-lane" }, { timeoutMs: 40000 });
  const headLine = () => ui.eval(`(() => { const d = document.querySelector('.custom-view-header-description'); return d && !d.classList.contains('hidden') && d.getBoundingClientRect().height ? d.textContent : ''; })()`);
  if (await ui.exists({ css: ".dispatch-tg-empty" })) {
    await ui.screenshot("session-empty");
    // the empty state says it once: no line of counts under the title saying the same (task-h9co)
    const head = await headLine();
    if (head) throw new Error(`the empty graph still has a line under its title: ${head}`);
    await ui.mark({ css: ".dispatch-tg-empty-btn" }, { what: "这条会话还没有任务", where: "Task graph 页中间", how: "新会话的 Tasks 页签 › Graph；按钮切到整个项目" });
    await ui.click({ css: ".dispatch-tg-empty-btn" });
    if (!(await ui.waitFor({ css: ".dispatch-tg-lane" }, { timeoutMs: 40000 }).then(() => true, () => false))) {
      // the session's project has nothing in these days either (a fresh window's Assistant): that page too says it once
      if (!(await ui.exists({ css: ".dispatch-tg-empty" }))) throw new Error("the project's graph shows neither tasks nor its empty state");
      const projectHead = await headLine();
      if (projectHead) throw new Error(`the empty project graph still has a line under its title: ${projectHead}`);
      await ui.screenshot("project-empty");
      return { empty: true };
    }
  }
  else {
    // the page opened on the project (the new session has no tasks of its own): This session is the empty one,
    // and it too says so once (task-h9co)
    // a first-run tip can sit over the switch: close it first, like a person would
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    await ui.click({ css: ".dispatch-tg-seg-btn", index: 0 });
    await ui.waitFor({ css: ".dispatch-tg-empty" }, { timeoutMs: 40000 });
    await ui.sleep(500);
    const head = await headLine();
    if (head) throw new Error(`the empty session graph still has a line under its title: ${head}`);
    await ui.screenshot("session-empty");
    await ui.mark({ css: ".dispatch-tg-empty" }, { what: "这条会话还没有任务", where: "Task graph 页中间", how: "页头开关点 This session" });
    await ui.click({ css: ".dispatch-tg-seg-btn", index: 1 });
  }
  await ui.waitFor({ css: ".dispatch-tg-lane" }, { timeoutMs: 40000 });
  const drawn = await ui.eval("({ ms: document.querySelector('.dispatch-graph-page').dataset.renderMs, rows: document.querySelector('.dispatch-graph-page').dataset.rows, marks: document.querySelectorAll('.dispatch-tg-svg .mk').length })");
  await ui.screenshot("project");
  await ui.mark({ css: ".dispatch-tg-seg" }, { what: "范围开关", where: "页头下面左边", how: "This session 只看这条会话碰过的事，项目名看整个项目" });
  await ui.mark({ css: ".dispatch-tg-axis" }, { what: "一天一格的时间轴", where: "图顶上一排", how: "今天按小时展开到 Now，左右滑动换天" });
  await ui.mark({ css: ".dispatch-tg-name", index: 0 }, { what: "一行一件事", where: "左列", how: "事名加条数" });
  await ui.mark({ css: ".dispatch-tg-hit", index: 0 }, { what: "点（同一格的任务并成一个）", where: "泳道上", how: "悬停出卡，点了进任务页" });
  await ui.mark({ css: ".dispatch-tg-now", index: 0 }, { what: "现状一句", where: "右列", how: "悬停在今天那段出详情，点了进那条任务" });
  if (await ui.exists({ css: ".dispatch-tg-fold" })) {
    await ui.mark({ css: ".dispatch-tg-fold" }, { what: "No activity in 7 days", where: "图下面", how: "点一下展开" });
  }
  await ui.mark({ css: ".dispatch-tg-legend" }, { what: "图例", where: "开关同一行右边", how: "点的四种样子和线的意思" });

  // a mark's card, then the right-hand line's details in today's stretch
  // the seeded demo project draws only a few marks and lines: take the fourth when there is one
  const hits = await ui.eval("document.querySelectorAll('.dispatch-tg-hit').length");
  const nows = await ui.eval("document.querySelectorAll('.dispatch-tg-now').length");
  await ui.hover({ css: ".dispatch-tg-hit", index: Math.min(3, hits - 1) }, { settleMs: 900 });
  await ui.waitFor({ css: ".workbench-hover-container" }, { timeoutMs: 5000 });
  await ui.screenshot("mark-card");
  await ui.hover({ css: ".dispatch-tg-now", index: Math.min(1, nows - 1) }, { settleMs: 700 });
  await ui.waitFor({ css: ".dispatch-tg-detail.show" }, { timeoutMs: 5000 });
  await ui.screenshot("now-detail");

  // a click opens the task page; Esc comes back to the graph
  await ui.click({ css: ".dispatch-tg-now", index: Math.min(1, nows - 1) });
  await ui.waitFor({ css: ".dispatch-task-page .dispatch-task-meta" }, { timeoutMs: 30000 });
  await ui.screenshot("task-page");
  await ui.press("Escape");
  await ui.waitFor({ css: ".dispatch-tg-lane" }, { timeoutMs: 30000 });
  await ui.screenshot("back");

  return drawn;
}
