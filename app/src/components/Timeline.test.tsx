import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api, OpenWork, ProjectTimelineData, TimelineEvent } from "../api";
import { loadProjectTimeline } from "../api";
import { threadFixture } from "../fixtures-thread";
import { setLocale } from "../i18n";
import { OpenColumn, ProjectTimeline, TIMELINE_INTERNALS, kindWord, sentence, type HereState } from "./Timeline";

const here: HereState = { data: { project: "sprout", detected: true, cwd: "/p/sprout", timeline_days: 14, summary: { text: "sprout 是记账 App。", at: 1790000000, by: "haiku" }, open_tasks: [], sessions: [] }, busy: false, err: "", reload: () => {}, rewrite: () => {} };
const api = { on: async () => "{}" } as unknown as Api;
const timeline = (args: string[] = []) => JSON.parse(threadFixture(["thread", "sprout", "--timeline", ...args, "--json"])) as ProjectTimelineData;
const ev = (e: Partial<TimelineEvent>): TimelineEvent => ({ id: "x", kind: "done", ts: 1790000000, text: "", ...e });

describe("项目页 v3 时间线", () => {
  it("asks the CLI for the window, the older page and the closes-only view", async () => {
    const calls: string[][] = [];
    const rec = { on: async (_h: string, args: string[]) => { calls.push(args); return threadFixture(args); } } as unknown as Api;
    await loadProjectTimeline(rec, "sprout", { days: 3 });
    await loadProjectTimeline(rec, "sprout", { days: 14, before: 1789000000, only: true, sessions: false });
    expect(calls).toEqual([
      ["thread", "sprout", "--timeline", "--days", "3", "--json"],
      ["thread", "sprout", "--timeline", "--days", "14", "--before", "1789000000", "--only", "done", "--no-sessions", "--json"],
    ]);
  });

  it("全部 asks for the whole history, a focused task asks for its own rows, 更早 skips the open work", async () => {
    const calls: string[][] = [];
    const rec = { on: async (_h: string, args: string[]) => { calls.push(args); return threadFixture(args); } } as unknown as Api;
    const all = await loadProjectTimeline(rec, "sprout", { days: 0 });
    const week = await loadProjectTimeline(rec, "sprout", { days: 14 });
    await loadProjectTimeline(rec, "sprout", { days: 7, task: "task-sp51" });
    const older = await loadProjectTimeline(rec, "sprout", { days: 14, before: 1789000000, task: "task-sp51", open: false });
    expect(calls.map((c) => c.join(" "))).toEqual([
      "thread sprout --timeline --days 0 --json",
      "thread sprout --timeline --days 14 --json",
      "thread sprout --timeline --days 7 --task task-sp51 --json",
      "thread sprout --timeline --days 14 --before 1789000000 --task task-sp51 --no-open --json",
    ]);
    expect(all.all).toBe(true);
    expect(all.next_before).toBeNull();
    expect(all.count).toBeGreaterThanOrEqual(week.count);
    expect(older.open).toBeUndefined();
  });

  it("never shows a row twice when pages overlap", () => {
    const a = timeline();
    const dup = a.days[0].events[0];
    const b = { ...a, days: [{ ...a.days[0], events: [dup, ev({ id: "new-one", ts: dup.ts })], count: 2 }] };
    const rows = TIMELINE_INTERNALS.mergeDays([a, b]).flatMap((d) => d.events).map((e) => e.id);
    expect(rows.filter((id) => id === dup.id).length).toBe(1);
    expect(rows).toContain("new-one");
  });

  it("puts the checklist line, not the checker's why, in 等你, one row per task", () => {
    const open = timeline().open as OpenWork;
    const two = { ...open, asks: [...open.asks, { ...open.asks[0], n: 5, item: "第二项", ts: open.asks[0].ts - 1 }] };
    const html = renderToStaticMarkup(<OpenColumn api={api} me="user" open={two} here={here} onTask={() => {}} onSession={() => {}} />);
    expect(html).toContain("2 项验收要你确认");
    expect(html).toContain("室友手机上也显示头像、第二项");
    expect(html).not.toContain("只能你在真机上确认室友那台的头像");
  });

  it("says each kind of row in its own words", () => {
    expect(sentence(ev({ kind: "done", group: true, closes: [{ task: "a", title: "习惯打卡", text: "", ts: 1 }, { task: "b", title: "编辑器", text: "", ts: 1 }] }))).toBe("2 项一起收尾：习惯打卡、编辑器");
    expect(sentence(ev({ kind: "verify", verify: { ok: 3, ask: 1, fail: 0 } }))).toBe("3 项通过，1 项要你确认");
    expect(sentence(ev({ kind: "verify", verify: { ok: 0, ask: 0, fail: 0, error: "超时" } }))).toBe("验收没跑成：超时");
    expect(sentence(ev({ kind: "commit", text: "feat: x", fold: { count: 3, from_ts: 1, to_ts: 2, summary: [], events: [] } }))).toBe("3 个提交 · feat: x");
    expect(kindWord({ kind: "void" })).toBe("作废");
  });

  it("merges pages that meet on one day", () => {
    const a = timeline();
    const b = { ...a, days: [{ ...a.days[a.days.length - 1], events: [ev({ id: "older" })], count: 1 }] };
    const days = TIMELINE_INTERNALS.mergeDays([a, b]);
    expect(days.length).toBe(a.days.length);
    expect(days[days.length - 1].events.some((e) => e.id === "older")).toBe(true);
  });

  it("draws 现状, the filter and the open column; no chapters, newest day first", () => {
    const html = renderToStaticMarkup(<ProjectTimeline api={api} me="user" project="sprout" here={here} onTask={() => {}} onSession={() => {}} />);
    expect(html).toContain("现状");
    expect(html).toContain("sprout 是记账 App。");
    expect(html).toContain("重写");
    expect(html).toContain("做了什么");
    expect(html).toContain("只看收尾和结论");
    expect(html).toContain('class="pv3-side"');
    expect(html).not.toContain("data-chapter");
    expect(html).not.toContain("更早 1 条线");
  });

  it("the timeline fixture is newest first and every row has a kind word", () => {
    const d = timeline(["--days", "14"]);
    const rows = d.days.flatMap((x) => x.events);
    const ts = rows.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
    expect(rows.every((e) => kindWord(e))).toBe(true);
    expect(rows.some((e) => e.kind === "verify")).toBe(true);
  });

  it("the open column lists 等你 first, then 在做 and 没人认领", () => {
    const open = timeline().open as OpenWork;
    const html = renderToStaticMarkup(<OpenColumn api={api} me="user" open={open} here={here} onTask={() => {}} onSession={() => {}} testCard={<div className="pv3-card">card</div>} />);
    const at = (s: string) => html.indexOf(s);
    expect(at("等你")).toBeGreaterThan(-1);
    expect(at("card")).toBeLessThan(at("在做"));
    expect(at("验收第 4 项")).toBeGreaterThan(-1);
    expect(at("在做")).toBeLessThan(at("没人认领"));
    const empty = renderToStaticMarkup(<OpenColumn api={api} me="user" open={{ asks: [], waiting_sessions: [], wait: [], doing: [], unassigned: [], sessions: [], test_cmd: "", counts: { wait: 0, doing: 0, unassigned: 0 } }} here={{ ...here, data: null }} onTask={() => {}} onSession={() => {}} />);
    expect(empty).toContain("没有等你的事，也没人在做");
  });

  it("reads in English and German", () => {
    for (const [loc, done, together] of [["en", "Done", "2 wrapped up together: "], ["de", "Erledigt", "2 zusammen abgeschlossen: "]] as const) {
      setLocale(loc);
      try {
        expect(kindWord({ kind: "done" })).toBe(done);
        expect(TIMELINE_INTERNALS.verifyParts({ ok: 2, ask: 1, fail: 0 })).not.toContain("，");
        expect(sentence(ev({ kind: "done", group: true, closes: [{ task: "a", title: "A", text: "", ts: 1 }, { task: "b", title: "B", text: "", ts: 1 }] }))).toBe(`${together}A, B`);
      } finally { setLocale("zh"); }
    }
  });
});
