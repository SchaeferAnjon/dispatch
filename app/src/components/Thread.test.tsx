import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api, ThreadData, ThreadList, ThreadProjects } from "../api";
import { threadFixture } from "../fixtures-thread";
import { loadThread } from "../api";
import { NO_PROJECT, ThreadPane, homeOf } from "./Thread";

const line = (id: string) => JSON.parse(threadFixture(["thread", id, "--json"])) as ThreadData;
const pane = (d: ThreadData) => renderToStaticMarkup(<ThreadPane d={d} me="user" onOpen={() => {}} onPick={() => {}} />);

describe("脉络", () => {
  it("draws the user's words, the three boxes and the kinds of records", () => {
    const html = pane(line("task-ds01"));
    expect(html).toContain('class="askbox"');
    expect(html).toContain("走到哪");
    expect(html).toContain("剩下");
    expect(html).toContain("这条线");
    expect(html).toMatch(/class="beat ask[^"]*first/);
    expect(html).toContain('class="beat decide');
    expect(html).toContain("3 人各说一次");
    expect(html).toContain("<span>派给自己</span>");
  });

  it("opens a branch that still has something open and leaves finished ones folded", () => {
    const html = pane(line("task-ds01"));
    expect(html).toMatch(/class="beat fork fold open-fold[^"]*" data-beat="fork:task-sp51/);
    expect(html).toMatch(/class="beat fork fold" data-beat="fork:task-sp50/);
    // the open tail has no time, the running one pulses
    expect(html).toContain("现在");
    expect(html).toMatch(/class="beat run[^"]*" data-beat="tail:open:task-sp51/);
  });

  it("marks a long quiet stretch and a task given by id opens its whole line", () => {
    const d = line("task-sp39");
    expect(d.root).toBe("task-sp21");
    expect(d.selected).toBe("task-sp39");
    const html = pane(d);
    expect(html).toContain('class="beat gap"');
    expect(html).toContain("2 天没动");
  });

  it("lists lines per project and folds single tasks into a count", () => {
    const l = JSON.parse(threadFixture(["thread", "sprout", "--lines", "--all", "--json"])) as ThreadList;
    expect(l.threads.map((r) => r.root)).toEqual(["task-ds01", "task-sp21"]);
    expect(l.singles?.length).toBe(2);
    const all = JSON.parse(threadFixture(["thread", "--all-projects", "--all", "--json"])) as ThreadList;
    expect(all.everywhere).toBe(true);
    expect(new Set(all.threads.map((r) => r.project)).size).toBeGreaterThan(2);
  });
});

describe("脉络 by project", () => {
  it("lists projects, one row each, with their state", () => {
    const l = JSON.parse(threadFixture(["thread", "--projects", "--json"])) as ThreadProjects;
    const sprout = l.projects.find((p) => p.name === "sprout")!;
    expect(sprout.state).toBe("run");
    expect(sprout.lines).toBe(4);
    expect(l.projects.some((p) => p.state === "done")).toBe(true);
  });
});

describe("脉络 by project: reviewed fixes", () => {
  it("a chapter reads its line inside the project it is listed in", async () => {
    const calls: string[][] = [];
    const rec = { on: async (_h: string, args: string[]) => { calls.push(args); return threadFixture(args); } } as unknown as Api;
    await loadThread(rec, "task-sp33", "sprout");
    await loadThread(rec, "task-sp33");
    expect(calls).toEqual([["thread", "task-sp33", "--in", "sprout", "--json"], ["thread", "task-sp33", "--json"]]);
  });

  it("follows a task to its own project and chapter, not its line's root", () => {
    const d = line("task-sp39");
    expect(homeOf(d)).toEqual({ project: d.project, root: d.root });
    expect(homeOf({ ...d, home_project: "TUTOR", home_root: "task-sp39" })).toEqual({ project: "TUTOR", root: "task-sp39" });
    expect(homeOf({ ...d, home_project: "", home_root: "task-sp39" })).toEqual({ project: NO_PROJECT, root: "task-sp39" });
  });
});
