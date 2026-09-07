import { describe, expect, it } from "vitest";
import { PROJECT_FLAGS_KEY, parseProjectFlags, rankProjects, serializeProjectFlags, withProjectFlag } from "./projectFlags";

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
});
