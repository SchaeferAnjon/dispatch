import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, PROJECT_FLAGS_KEY, SETTINGS_KEY, parseProjectFlags, parseSettings, rankProjects, serializeProjectFlags, serializeSettings, withProjectFlag } from "./projectFlags";

describe("project flags", () => {
  it("parses only true known fields from the shared memory", () => {
    const flags = parseProjectFlags([{ key: "pit-x", value: "【坑】" }, { key: PROJECT_FLAGS_KEY, value: JSON.stringify({ a: { starred: true, archived: false, x: 1 }, b: { archived: true }, c: { starred: false }, d: "bad" }) }]);
    expect(flags).toEqual({ a: { starred: true }, b: { archived: true } });
    expect(parseProjectFlags([])).toEqual({});
    expect(parseProjectFlags([{ key: PROJECT_FLAGS_KEY, value: "nope" }])).toEqual({});
  });

  it("merges changes and drops empty entries, serialising in a stable order", () => {
    let flags = withProjectFlag({}, "ReadOut", { starred: true });
    flags = withProjectFlag(flags, "kanban", { archived: true });
    expect(serializeProjectFlags(flags)).toBe('{"ReadOut":{"starred":true},"kanban":{"archived":true}}');
    flags = withProjectFlag(flags, "ReadOut", { starred: false });
    expect(flags).toEqual({ kanban: { archived: true } });
  });

  it("ranks starred first and sets archived aside without reordering the rest", () => {
    const list = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }];
    const { active, archived } = rankProjects(list, { c: { starred: true }, b: { archived: true }, d: { starred: true, archived: true } });
    expect(active.map((p) => p.name)).toEqual(["c", "a"]);
    expect(archived.map((p) => p.name)).toEqual(["b", "d"]);
  });

  it("reads and writes the task auto-archive days, defaulting to off", () => {
    expect(DEFAULT_SETTINGS.task_archive_days).toBe(0);
    expect(parseSettings([]).task_archive_days).toBe(0);
    expect(parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ task_archive_days: 14 }) }]).task_archive_days).toBe(14);
    expect(parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ task_archive_days: -1 }) }]).task_archive_days).toBe(0);
    expect(JSON.parse(serializeSettings({ ...DEFAULT_SETTINGS, task_archive_days: 7 })).task_archive_days).toBe(7);
  });
});
