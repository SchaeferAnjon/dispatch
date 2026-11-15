import { describe, expect, it } from "vitest";
import {
  attribution, changedFields, factRows, fieldValues, filterRows, groupsOf, newestFirst, plain, profileRows, sectionName, shortDate,
  titleAndSummary, wikiRows, type WikiItem,
} from "./model";

const item = (key: string, kind: WikiItem["kind"], text: string, fields: Record<string, string> = {}, created = ""): WikiItem =>
  ({ key, kind, text, fields, project: "kanban", task: "task-ab12", raw: "", created });

describe("row text", () => {
  it("drops links, bold, backticks and task ids", () => {
    expect(plain("看 [文档](https://x.y/z) 和 https://a.b/c，`dispatch here` **重要**（claude-code · task-r3em）")).toBe("看 文档 和 ，dispatch here 重要（claude-code）");
  });

  it("splits title and summary at the first colon outside brackets, not at a time", () => {
    expect(titleAndSummary("生产 VPS：Hetzner（德国）")).toEqual({ title: "生产 VPS", summary: "Hetzner（德国）" });
    expect(titleAndSummary("NAS（型号：DH4300）在国内：家庭宽带")).toEqual({ title: "NAS（型号：DH4300）在国内", summary: "家庭宽带" });
    expect(titleAndSummary("16:30 后还没收到邮件：去问").title).toBe("16:30 后还没收到邮件");
    expect(titleAndSummary("", "只有字段").title).toBe("只有字段");
    const long = titleAndSummary("一".repeat(30) + "，" + "二".repeat(40));
    expect(long.title).toBe("一".repeat(30));
    expect(long.summary.startsWith("二")).toBe(true);
    expect(titleAndSummary("短标题：" + "长".repeat(200)).summary.length).toBe(80);
  });

  it("reads an About me entry's date and agent", () => {
    expect(attribution("喜欢结论先行。（2026-09-12 · claude-code）")).toEqual({ text: "喜欢结论先行。", date: "2026-09-12", agent: "claude-code" });
    expect(attribution("2026-09 · mini 清理（待开任务）")).toEqual({ text: "mini 清理（待开任务）", date: "2026-09", agent: "" });
    expect(attribution("2026-09-15|Harbor 迁移|等会话 · 用户说明（2026-09-15 · codex）")).toEqual({ text: "用户说明", date: "2026-09-15", agent: "codex" });
    expect(attribution("以后|计划 · Harbor 上架（2026-09-23 · claude-code）").text).toBe("Harbor 上架");
    expect(attribution("2026-09 · Dispatch 加 here。（zcode · task-r3em）")).toEqual({ text: "Dispatch 加 here。", date: "2026-09", agent: "zcode" });
  });
});

describe("rows", () => {
  it("wiki rows: group by kind, title from the text or the first field, newest first", () => {
    const rows = newestFirst(wikiRows([
      item("pit-a", "pit", "菜单不弹：窗口失去 key", { "【解法】": "先 activate" }, "2026-09-20T10:00:00Z"),
      item("retro-b", "retro", "", { "【技术】": "tsc 查类型" }, "2026-09-26T10:00:00Z"),
      item("m", null, "plain"),
    ]));
    expect(rows.map((r) => [r.group, r.title, r.summary, r.date])).toEqual([
      ["Retros", "tsc 查类型", "", "2026-09-26"],
      ["Pitfalls", "菜单不弹", "窗口失去 key", "2026-09-20"],
    ]);
    expect(groupsOf(rows, "wiki").map((g) => [g.name, g.count])).toEqual([["Wins", 0], ["Pitfalls", 1], ["Retros", 1], ["How-tos", 0]]);
  });

  it("fact rows: one per entry of each topic, with its line", () => {
    const rows = factRows([{ section: "通用", topic: "Apple 开发者（2026-09-07 核实）", note: "", body: "", path: "/F.md", line: 35,
      items: [{ line: 36, end: 37, text: "Apple ID `a@b.c` 是美区账号" }] }]);
    expect(rows[0]).toMatchObject({ id: "facts:36", group: "Apple 开发者", source: "Apple 开发者", date: "2026-09-07", path: "/F.md", line: 36, title: "Apple ID a@b.c 是美区账号" });
  });

  it("About me rows: short group names, agent and date on the right", () => {
    const rows = profileRows({ path: "/P.md", sections: [
      { heading: "将来会发生的事", body: "", line: 9, items: [{ line: 11, end: 12, text: "2026-10-01 · 回国（2026-09-20 · codex）" }] },
      { heading: "已发生", body: "", line: 13, items: [{ line: 15, end: 16, text: "2026-09-13 · 视频到 NAS" }] },
    ] });
    expect(rows.map((r) => [r.group, r.title, r.source, r.date, r.icon])).toEqual([
      ["Upcoming", "回国", "codex", "2026-09-20", "calendar"],
      ["Past events", "视频到 NAS", "", "2026-09-13", "history"],
    ]);
    expect(sectionName("设备与服务现状（快照 · 2026-09-26）")).toBe("Devices and services");
    expect(sectionName("Devices and services (Snapshot)")).toBe("Devices and services");
    expect(sectionName("Who I am")).toBe("Who I am");
    expect(filterRows(rows, "nas").map((r) => r.id)).toEqual(["me:15"]);
  });

  it("dates this year are short", () => {
    expect(shortDate("2026-09-26", new Date("2026-10-01"))).toBe("09-26");
    expect(shortDate("2025-09-26", new Date("2026-10-01"))).toBe("2025-09-26");
    expect(shortDate("2026-09", new Date("2026-10-01"))).toBe("2026-09");
  });

  it("edit form fields", () => {
    const r = item("retro-a", "retro", "t", { "【技术】": "tsc", "【做错】": "x" });
    expect(fieldValues(r)).toEqual({ tech: "tsc", good: "", bad: "x" });
    expect(changedFields(r, { tech: "tsc ", good: "", bad: "y" })).toEqual({ bad: "y" });
  });
});
