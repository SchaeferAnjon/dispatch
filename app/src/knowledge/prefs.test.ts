import { describe, expect, it } from "vitest";
import {
  aboutSoon, appliesTo, dayLabel, eventLine, evidenceCards, filterPrefs, momentLabel, prefGroups, rememberedLine, scopeAndDay, topPrefs,
  upcomingParts, usedLine, whereFrom, type Pref,
} from "./prefs";

const NOW = new Date("2026-09-28T10:00:00+02:00");
const pref = (id: string, over: Partial<Pref> = {}): Pref => ({
  id, name: id, text: `${id} 的一句话`, polarity: "like", area: "design", scope: "everywhere", status: "active", seen: true, used: 0,
  said: { at: "2026-09-27T20:09:00+02:00", engine: "claude-code", session: "8ebbcdf5-aaaa", project: "kanban" }, created: "2026-09-27T20:10:00+02:00",
  ...over,
});

describe("the home box", () => {
  it("top five: followed most, then the newest; the new ones last", () => {
    const prefs = [
      pref("a", { used: 3, last_used: "2026-09-27T10:00:00+02:00" }),
      pref("b", { used: 9 }),
      pref("c"),
      pref("d", { said: { at: "2026-09-28T09:00:00+02:00" } }),
      pref("n", { seen: false, used: 20 }),
      pref("x", { status: "replaced", used: 50 }),
    ];
    expect(topPrefs(prefs, new Set(["n"])).map((p) => p.id)).toEqual(["b", "a", "d", "c", "n"]);
    // nothing followed yet: the areas take turns, newest first within each
    const unused = [
      pref("d1", { said: { at: "2026-09-28T09:00:00+02:00" } }), pref("d2"), pref("d3"),
      pref("w1", { area: "workflow" }), pref("r1", { area: "writing", polarity: "avoid" }), pref("t1", { area: "tools" }),
    ];
    expect(topPrefs(unused, new Set()).map((p) => p.id)).toEqual(["d1", "w1", "r1", "t1", "d2"]);
  });

  it("Profile: what is coming up soonest, then the latest dated notes", () => {
    const profile = { path: "/P.md", sections: [
      { heading: "我是谁", body: "", line: 3, items: [{ line: 4, end: 5, text: "用户喜欢的界面样子：Copilot（2026-09-27 · claude-code）" }] },
      { heading: "将来会发生的事", body: "", line: 7, items: [
        { line: 8, end: 9, text: "2026-09-28|外管局预约|延签 · 周一 11:00，Landratsamt（2026-09-24 · claude-code）" },
        { line: 9, end: 10, text: "2026-10-18|剪映续费前|决定续不续 · 剪映 SVIP 自动续费（2026-09-24 · claude-code）" },
        { line: 10, end: 11, text: "2026-09-21|待办 · 周一再打外管局电话（2026-09-17 · claude-code）" },
        { line: 11, end: 12, text: "2026-09 · mini 清理（待开任务）" },
      ] },
    ] };
    expect(aboutSoon(profile, NOW)).toEqual([
      { when: "Today 11:00", text: "外管局预约", date: "2026-09-28", line: 8 },
      { when: "Oct 18", text: "剪映续费前", date: "2026-10-18", line: 9 },
      { when: "Sep 27", text: "用户喜欢的界面样子", date: "2026-09-27", line: 4 },
    ]);
    expect(upcomingParts("2026-09-28|外管局预约|延签 · 周一 11:00")).toEqual({ date: "2026-09-28", label: "外管局预约", rest: "周一 11:00" });
    // the same after the profile migration wrote the headings in English
    const english = { ...profile, sections: [
      { ...profile.sections[0], heading: "Who I am" },
      { ...profile.sections[1], heading: "Upcoming" },
      { heading: "Past events", body: "", line: 13, items: [{ line: 14, end: 15, text: "2026-09-27 · 办完了（2026-09-27 · claude-code）" }] },
    ] };
    expect(aboutSoon(english, NOW)).toEqual(aboutSoon(profile, NOW));
  });
});

describe("the list", () => {
  it("New first (not seen before this visit), then the areas with anything in them, newest first", () => {
    const prefs = [
      pref("d1", { said: { at: "2026-09-20" } }),
      pref("d2", { said: { at: "2026-09-26" } }),
      pref("w1", { area: "workflow" }),
      pref("n1", { area: "tools", seen: false }),
      pref("r1", { area: "writing", status: "replaced" }),
    ];
    const groups = prefGroups(prefs, new Set(["n1"]));
    expect(groups.map((g) => [g.id, g.items.map((p) => p.id)])).toEqual([["new", ["n1"]], ["design", ["d2", "d1"]], ["workflow", ["w1"]]]);
    expect(filterPrefs(prefs, "d2 一句").map((p) => p.id)).toEqual(["d2"]);
  });

  it("the grey line says where it came from and the words", () => {
    expect(whereFrom(pref("a", { part: "design/waiting/redesign/index.html#a-session", part_title: "Waiting for you 重设计", quote: "能点开" }), NOW))
      .toBe("Your feedback on Waiting for you 重设计 · a-session · 「能点开」");
    expect(whereFrom(pref("b", { part: "design/task-model/redesign/index.html" }), NOW)).toBe("Your feedback on task-model");
    expect(whereFrom(pref("c", { quote: "以后都先跑 designer" }), NOW)).toBe("You said · 「以后都先跑 designer」");
    expect(whereFrom(pref("d", { imported: true, sources: [{ kind: "facts", path: "/F.md", label: "FACTS.md · 我常说的话" }, { kind: "memory", path: "/m.md", label: "memory" }], also_in: ["GLOBAL.md"] }), NOW))
      .toBe("From FACTS.md · 我常说的话 · +1 more · also in GLOBAL.md");
    expect(scopeAndDay(pref("e", { scope: "kanban:Tasks tab" }), NOW)).toBe("kanban · Tasks tab · yesterday");
    expect(scopeAndDay(pref("f", { imported: true, said: { at: "" } }), NOW)).toBe("Everywhere");
  });
});

describe("one preference", () => {
  it("dates, where it applies, when and by whom, how often used", () => {
    expect(dayLabel("2026-09-28T09:00:00+02:00", NOW)).toBe("today");
    expect(dayLabel("2026-09-26", NOW)).toBe("09-26");
    expect(dayLabel("2025-09-26", NOW)).toBe("2025-09-26");
    expect(momentLabel("2026-09-27T20:09:00+02:00", NOW)).toBe("yesterday 20:09");
    expect(appliesTo(pref("a"))).toBe("Everywhere");
    expect(appliesTo(pref("a", { scope: "kanban" }))).toBe("The kanban project");
    expect(appliesTo(pref("a", { scope: "kanban:Waiting for you" }))).toBe("kanban: Waiting for you");
    expect(rememberedLine(pref("a"), NOW)).toBe("yesterday 20:09 by Claude Code in kanban");
    expect(rememberedLine(pref("a", { imported: true, sources: [{ kind: "memory", path: "/m", label: "Claude Code memory · x", at: "2026-09-02" }] }), NOW))
      .toBe("Imported from Claude Code memory · x, written 09-02");
    expect(usedLine(pref("a"))).toBe("Not yet");
    expect(usedLine(pref("a", { used: 2, last_used: "2026-09-28T08:00:00+02:00" }), NOW)).toBe("2 times, last today");
    expect(eventLine({ at: "", event: "replaces", detail: "「所有任务都做成时间线」" })).toBe("Replaced 「所有任务都做成时间线」. Kept here, not given to agents.");
    expect(eventLine({ at: "", event: "also-found", detail: "Claude Code memory · designer-delivery-format" })).toBe("Also found in Claude Code memory · designer-delivery-format");
    expect(eventLine({ at: "", event: "unsaid" })).toBe("Undo right after it was said again: kept as it was");
  });

  it("evidence: the part it hangs on first, with the thumbnail; its screenshots; pages and links", () => {
    const cards = evidenceCards(pref("a", {
      part: "design/waiting/redesign/index.html#a-session", part_path: "/Users/me/p/design/waiting/redesign/index.html", part_title: "Waiting for you 重设计",
      thumb: "data:image/jpeg;base64,AA", images: [{ path: "/Users/me/.dispatch/preferences/evidence/a/179.png", uri: "data:image/png;base64,BB" }],
      evidence: ["/Users/me/Desktop/179.png", "https://example.com/x"],
    }));
    expect(cards.map((c) => [c.kind, c.title, c.part, c.file, c.dir, c.target, !!c.thumb])).toEqual([
      ["page", "Waiting for you 重设计", "a-session", "index.html", "~/p/design/waiting/redesign", "/Users/me/p/design/waiting/redesign/index.html#a-session", true],
      ["image", "Your screenshot", "a", "179.png", "~/.dispatch/preferences/evidence/a", "/Users/me/.dispatch/preferences/evidence/a/179.png", true],
      ["link", "example.com", "https://example.com/x", "x", "https://example.com", "https://example.com/x", false],
    ]);
    // two screenshots, one of them copied: the other one still gets its card
    const two = evidenceCards(pref("b", {
      images: [{ path: "/Users/me/.dispatch/preferences/evidence/b/new-session.png", uri: "data:image/png;base64,CC" }],
      evidence: ["/Users/me/refs/new-session.png", "/Users/me/refs/app.png"],
    }));
    expect(two.map((c) => c.file)).toEqual(["new-session.png", "app.png"]);
  });
});
