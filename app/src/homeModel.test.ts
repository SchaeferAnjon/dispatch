import { describe, expect, it } from "vitest";
import { acceptanceOf, homeModel, startOfDay, tasksOf } from "./homeModel";
import type { Activity, Issue, Session } from "./types";

const NOW = new Date(2026, 8, 25, 18, 0, 0).getTime() / 1000;
const act = (id: string, extra: Partial<Activity> = {}): Activity => ({
  key: `claude-code:${id}`, agent: "claude-code", session_id: id, cwd: "/p", project: "p", title: id, last_at: NOW - 60, state: "idle", activity: "", version: "1",
  events: [], tasks: [], unread: false, stale: false, tracking_since: 0, source: "transcript", ...extra,
});
const sess = (id: string, last_at = NOW - 30): Session => ({ agent: "claude-code", session_id: id, cwd: "/p", project: "p", agent_pid: 1, source_kind: "terminal", source_app: "Herdr", entrypoint: "cli", started_at: 0, last_at, state: "idle", prompts: 1, alive: true, registered: true, attention: "input" });
const task = (id: string, extra: Partial<Issue> = {}): Issue => ({ id, title: id, status: "open", priority: 2, issue_type: "task", created_at: "2026-09-01", updated_at: "2026-09-01", ...extra });
const empty = { waiting: [], unread: [], running: [], read: [], rows: [], issues: [], now: NOW };

describe("homeModel", () => {
  it("puts 要确认 before 问你 before plain unread replies, one row per session", () => {
    const dlg = act("dlg", { waiting: "dialog" });
    const ask = act("ask", { unread: true, waiting: "question", question: "要不要全章重生成？", last_at: NOW - 10 });
    const done = act("done", { unread: true, last_at: NOW - 5 });
    const m = homeModel({ ...empty, waiting: [sess("dlg")], unread: [ask, done], rows: [dlg, ask, done] });
    expect(m.urgent.map((x) => [x.verb, x.a?.session_id])).toEqual([["confirm", "dlg"], ["ask", "ask"]]);
    expect(m.urgent[0].s?.session_id).toBe("dlg");
    expect(m.delivered.map((x) => x.a!.session_id)).toEqual(["done"]);
  });

  it("a waiting session whose snapshot says question is 问你, and it is not listed again as running", () => {
    const pick = act("pick", { state: "working", waiting: "question", question: "选哪个？" });
    const m = homeModel({ ...empty, waiting: [sess("pick")], running: [pick], rows: [pick] });
    expect(m.urgent.map((x) => x.verb)).toEqual(["ask"]);
    expect(m.running).toEqual([]);
  });

  it("today's read replies, newest first, capped; yesterday's are left out", () => {
    const day = startOfDay(NOW);
    const read = [act("y", { last_at: day - 60 }), ...Array.from({ length: 7 }, (_, n) => act(`r${n}`, { last_at: day + 60 * (n + 1) }))];
    const m = homeModel({ ...empty, read, rows: read });
    expect(m.today.map((x) => x.a!.session_id)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
  });

  it("unclaimed tasks: P0/P1 listed, P2 counted, claimed or started ones left out", () => {
    const issues = [task("p1", { priority: 1 }), task("p0", { priority: 0 }), task("p2", { priority: 2 }), task("mine", { priority: 1, assignee: "codex" }), task("run", { priority: 1, status: "in_progress" })];
    const m = homeModel({ ...empty, issues });
    expect(m.unowned.map((i) => i.id)).toEqual(["p0", "p1"]);
    expect(m.unownedP2).toBe(1);
  });
});

describe("tasksOf / acceptanceOf", () => {
  it("finds tasks by the ids a transcript mentions and by session labels; the meter uses the first open one with acceptance", () => {
    const a = act("s1", { tasks: ["t1"] });
    const issues = [task("t1", { status: "closed", acceptance_criteria: "- [x] a" }), task("t2", { status: "in_progress", labels: ["session:s1"], acceptance_criteria: "- [x] a\n- [ ] b\n- [ ] c" }), task("t3")];
    expect(tasksOf(a, issues).map((i) => i.id)).toEqual(["t2", "t1"]);
    expect(acceptanceOf(a, issues)).toEqual({ done: 1, total: 3, id: "t2" });
    expect(acceptanceOf(undefined, issues)).toBeNull();
  });
});
