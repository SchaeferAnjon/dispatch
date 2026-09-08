import { describe, expect, it } from "vitest";
import { inlineDiff, pairRows, patchRows, diffStat, collapse, type DiffRow } from "./diff";
type Line = Extract<DiffRow, { kind: "same" | "add" | "del" }>;
type Skip = Extract<DiffRow, { kind: "skip" }>;

describe("inlineDiff", () => {
  it("marks only the changed words", () => {
    const d = inlineDiff("const a = 1;", "const b = 1;");
    expect(d.a.filter((s) => s.changed).map((s) => s.text)).toEqual(["a"]);
    expect(d.b.filter((s) => s.changed).map((s) => s.text)).toEqual(["b"]);
  });
  it("gives up on lines that changed almost entirely", () => {
    const d = inlineDiff("hello world", "完全不同的一行内容");
    expect(d.a.every((s) => !s.changed)).toBe(true);
  });
});

describe("pairRows", () => {
  it("numbers both sides and attaches word segments to replaced lines", () => {
    const rows = pairRows("x = 1\ny = 2\nz = 3", "x = 1\ny = 20\nz = 3");
    const del = rows.find((r) => r.kind === "del") as Line;
    const add = rows.find((r) => r.kind === "add") as Line;
    expect(del.oldNo).toBe(2); expect(del.newNo).toBeNull();
    expect(add.newNo).toBe(2);
    expect(add.segs?.some((s) => s.changed && s.text.includes("20"))).toBe(true);
  });
  it("collapses far-away unchanged lines into a skip", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const full = pairRows(old, old.replace("l15", "L15"));
    const rows = collapse(full, 2);
    const skips = rows.filter((r) => r.kind === "skip") as Skip[];
    expect(skips.length).toBe(2);
    expect(skips[0]).toEqual({ kind: "skip", count: 13, start: 0 });
    expect(diffStat(rows)).toEqual({ add: 1, del: 1 });
    expect(collapse(full, 2, new Set([0])).filter((r) => r.kind === "skip").length).toBe(1);
  });
});

describe("patchRows", () => {
  it("reads real line numbers from hunk headers", () => {
    const rows = patchRows("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -10,3 +10,3 @@ fn\n ctx\n-old line\n+new line\n ctx2\n");
    const same = rows.filter((r) => r.kind === "same") as Line[];
    expect(same[0].oldNo).toBe(10); expect(same[1].newNo).toBe(12);
    const del = rows.find((r) => r.kind === "del") as Line;
    expect(del.oldNo).toBe(11);
    expect(del.segs?.filter((s) => s.changed).map((s) => s.text)).toEqual(["old"]);
  });
});
