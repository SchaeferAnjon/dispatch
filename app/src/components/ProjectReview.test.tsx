import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "../api";
import { ProjectReview } from "./ProjectHub";

const api = { on: async () => "{}", openPath: async () => {}, copy: async () => {} } as unknown as Api;

const noop = () => {};

describe("ProjectReview 按任务分组", () => {
  it("shows a session under every task it is linked to, not only the one it claimed", () => {
    const data = {
      project: "kanban",
      detected: true,
      cwd: "/Users/x/Projects/kanban",
      timeline_days: 14,
      summary: { text: "项目现状一段话" },
      timeline: [
        {
          day: "2026-09-14",
          weekday: "周一",
          entries: [
            {
              ts: 1000, kind: "session" as const, ref: "s1",
              text: "会话「发起甲也做乙」：两件事都做了",
              task: "task-a", task_title: "甲",
              tasks: [{ id: "task-a", title: "甲" }, { id: "task-b", title: "乙" }],
            },
            { ts: 900, kind: "task" as const, ref: "task-a", task: "task-a", task_title: "甲", text: "甲：进展一句话" },
          ],
        },
      ],
      open_tasks: [],
      sessions: [],
    };
    const html = renderToStaticMarkup(
      <ProjectReview api={api} data={data} busy={false} err="" me="" onOpen={noop} onTask={noop} onReload={noop} />
    );
    // Both task groups render (their title button), and the shared session row appears once per
    // group (each row's text shows up twice in the markup: once as the visible span, once as its
    // title="" tooltip attribute — so two groups means four raw occurrences).
    const groupHeads = (html.match(/review-group-title/g) || []).length;
    expect(groupHeads).toBeGreaterThanOrEqual(2);
    const sessionMentions = (html.match(/两件事都做了/g) || []).length;
    expect(sessionMentions).toBe(4);
  });

  it("keeps a session with no linked task in 未挂任务, appearing once", () => {
    const data = {
      project: "kanban",
      detected: true,
      cwd: "/Users/x/Projects/kanban",
      timeline_days: 14,
      summary: { text: "" },
      timeline: [
        {
          day: "2026-09-14",
          weekday: "周一",
          entries: [
            { ts: 1000, kind: "session" as const, ref: "s2", text: "会话「只是提到」：随口提了一下", tasks: [] },
          ],
        },
      ],
      open_tasks: [],
      sessions: [],
    };
    const html = renderToStaticMarkup(
      <ProjectReview api={api} data={data} busy={false} err="" me="" onOpen={noop} onTask={noop} onReload={noop} />
    );
    expect(html).toContain("未挂任务");
    // One row (no linked task) → text shows up twice: the visible span and its title="" attribute.
    expect((html.match(/随口提了一下/g) || []).length).toBe(2);
  });
});
